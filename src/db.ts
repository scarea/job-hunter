import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Platform, RawJob, ScoreResult } from "./types.js";

const DB_DIR = path.resolve(process.cwd(), "data");
fs.mkdirSync(DB_DIR, { recursive: true });
export const db = new Database(path.join(DB_DIR, "jobs.db"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  salary_raw TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  salary_months INTEGER,
  city TEXT,
  district TEXT,
  tags TEXT,
  jd TEXT,
  url TEXT,
  query TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(platform, external_id)
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  scored_at TEXT NOT NULL,
  scoring_version TEXT NOT NULL,
  model TEXT,
  total REAL,
  dims TEXT,
  verdict TEXT,
  reason TEXT,
  reject_rule TEXT,
  ai_raw TEXT,
  cost_input INTEGER,
  cost_output INTEGER,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_scores_job ON scores(job_id);
CREATE INDEX IF NOT EXISTS idx_scores_version ON scores(scoring_version);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  platform TEXT,
  query TEXT,
  found INTEGER DEFAULT 0,
  inserted INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  errors TEXT
);
`);

/** 给已有的库补列（CREATE TABLE IF NOT EXISTS 不会改旧表） */
function addColumn(table: string, col: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
/**
 * 岗位处理状态：
 *   new      还没处理
 *   later    稍后再看（一直留在「待处理」里）
 *   applied  已投递
 *   ignored  不感兴趣（以后不再推荐，也不再补详情、打分）
 */
addColumn("jobs", "status", "TEXT NOT NULL DEFAULT 'new'");
addColumn("jobs", "status_at", "TEXT");
/** 被选进哪一天的「今日推荐」（本地日期 YYYY-MM-DD）；推荐过的不会再作为「新推荐」出现 */
addColumn("jobs", "recommended_on", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_recommended ON jobs(recommended_on)");
/** 命中前缀缓存的输入 token 数（算成本用） */
addColumn("scores", "cost_cache_hit", "INTEGER NOT NULL DEFAULT 0");

export const JOB_STATUSES = ["new", "later", "applied", "ignored", "closed"] as const; // closed = 岗位已下线（自动识别）
export type JobStatus = (typeof JOB_STATUSES)[number];

export function setJobStatus(id: number, status: JobStatus): boolean {
  return db.prepare("UPDATE jobs SET status = ?, status_at = ? WHERE id = ?").run(status, new Date().toISOString(), id).changes > 0;
}

const now = () => new Date().toISOString();

/** upsert 岗位；返回 { id, isNew } */
export function upsertJob(job: RawJob, salary: { min: number|null; max: number|null; months: number|null }) {
  const existing = db
    .prepare("SELECT id FROM jobs WHERE platform = ? AND external_id = ?")
    .get(job.platform, job.externalId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE jobs SET title=?, company=?, salary_raw=?, salary_min=?, salary_max=?, salary_months=?,
       city=?, district=?, tags=?, jd=COALESCE(NULLIF(?,''), jd), url=?, query=?, last_seen_at=? WHERE id=?`
    ).run(
      job.title, job.company, job.salaryRaw, salary.min, salary.max, salary.months,
      job.city ?? "", job.district ?? "", JSON.stringify(job.tags ?? []),
      job.jd ?? "", job.url, job.query ?? "", now(), existing.id
    );
    return { id: existing.id, isNew: false };
  }

  const info = db.prepare(
    `INSERT INTO jobs (platform, external_id, title, company, salary_raw, salary_min, salary_max, salary_months,
      city, district, tags, jd, url, query, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    job.platform, job.externalId, job.title, job.company, job.salaryRaw, salary.min, salary.max, salary.months,
    job.city ?? "", job.district ?? "", JSON.stringify(job.tags ?? []), job.jd ?? "", job.url, job.query ?? "",
    now(), now()
  );
  return { id: Number(info.lastInsertRowid), isNew: true };
}

export function saveScore(jobId: number, version: string, model: string, result: ScoreResult) {
  db.prepare(
    `INSERT INTO scores (job_id, scored_at, scoring_version, model, total, dims, verdict, reason, reject_rule, ai_raw, cost_input, cost_output, cost_cache_hit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    jobId, now(), version, model, result.total, JSON.stringify(result.dims), result.verdict,
    result.reason, result.rejectRule ?? null, result.aiRaw ?? null,
    result.usage?.input ?? 0, result.usage?.output ?? 0, result.usage?.cacheHit ?? 0
  );
}

export function startRun(platform: string, query: string) {
  const info = db.prepare("INSERT INTO runs (started_at, platform, query) VALUES (?,?,?)").run(now(), platform, query);
  return Number(info.lastInsertRowid);
}

export function finishRun(id: number, found: number, inserted: number, updated: number, errors: string[] = []) {
  db.prepare("UPDATE runs SET finished_at=?, found=?, inserted=?, updated=?, errors=? WHERE id=?")
    .run(now(), found, inserted, updated, errors.join("\n"), id);
}

/** 最新一次评分（每个岗位取最新版本） */
export function latestScores(limit = 20) {
  return db.prepare(`
    SELECT j.*, s.total, s.dims, s.verdict, s.reason, s.scored_at, s.scoring_version
    FROM jobs j
    JOIN scores s ON s.id = (
      SELECT id FROM scores WHERE job_id = j.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY s.total DESC
    LIMIT ?
  `).all(limit) as any[];
}

/** 还没打分的岗位 */
export function unscoredJobs(version: string, limit = 200) {
  return db.prepare(`
    SELECT j.* FROM jobs j
    WHERE NOT EXISTS (
      SELECT 1 FROM scores s WHERE s.job_id = j.id AND s.scoring_version = ?
    )
    AND j.status NOT IN ('ignored', 'applied', 'closed')  -- 处理过 / 已下线的不再花钱打分
    AND j.last_seen_at >= datetime('now', '-' || ? || ' days')  -- 很久没在平台上出现的（多半已下线）也不打
    ORDER BY j.last_seen_at DESC
    LIMIT ?
  `).all(version, parseInt(process.env.STALE_DAYS || "14", 10), limit) as any[];
}
