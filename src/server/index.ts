import "dotenv/config";
import express from "express";
import path from "node:path";
import { db, latestScores } from "../db.js";
import { AUTO_PLATFORMS } from "../collectors/index.js";
import { startTask, stopTask, getState, isRunning, loadEnv } from "./runner.js";
import { listTags, createTag, updateTag, deleteTag, applyTagFilter, tagHitCounts, TagError } from "../tags.js";
import { setJobStatus, JOB_STATUSES, type JobStatus } from "../db.js";
import { rebuildRecommendations, recommendationsOn, backlog, latestRecommendDate } from "../recommend.js";
import { allStatuses, PLATFORMS } from "../platforms.js";
import { BROWSER_PLATFORMS } from "../collectors/index.js";
import { localDate, localDayStartIso } from "../time.js";
import type { Platform } from "../types.js";
import { RESUME_PATH, loadResume } from "../config.js";
import { extractResumeText } from "../resume-extract.js";
import { estimateCost } from "../score/scorer.js";
import { listQueries, scoreQueries, selectQueries, topSuggestions, recentLog, addQuery, setQueryState, deleteQuery, QUERY_BUDGET } from "../strategy.js";
import fs from "node:fs";

const app = express();
const PORT = parseInt(process.env.PORT || "5173", 10);

/**
 * 防 DNS rebinding + CSRF：
 *  - Host 必须是本机地址（rebinding 时 Host 是攻击者的域名）
 *  - 写操作如果带 Origin，必须是看板自己（别的网页发来的 POST 都带它们自己的 Origin）
 *    不带 Origin 的是 curl 等本机命令行调用，放行
 */
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

/**
 * 书签小工具要从招聘站页面 POST 到 /api/manual-jobs，所以对这一个接口开放跨域。
 * ⚠️ 只放行招聘站 + 只放行这一个路径；其它写接口（改配置、起任务）仍然只接受看板自己。
 */
const IMPORT_PATH = "/api/manual-jobs";
const IMPORT_ORIGINS = [
  /^https:\/\/([a-z0-9-]+\.)*zhipin\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*liepin\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*zhaopin\.com$/i,
];
const isImportRequest = (req: express.Request) => {
  // 注意：app.use(IMPORT_PATH, ...) 挂载后 req.path 会变成 "/"，所以用 originalUrl 判断
  const p = (req.originalUrl || req.url || "").split("?")[0];
  return p === IMPORT_PATH && IMPORT_ORIGINS.some((re) => re.test(String(req.headers.origin || "")));
};

app.use((req, res, next) => {
  const host = (req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: "forbidden host" });
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin.toLowerCase()) && !isImportRequest(req)) {
      return res.status(403).json({ error: "forbidden origin" });
    }
  }
  next();
});

// 给放行的那一个接口补上 CORS 响应头（含预检）
app.use(IMPORT_PATH, (req, res, next) => {
  if (isImportRequest(req)) {
    res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin));
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.resolve(process.cwd(), "src/server/public")));

/** 总览 */
app.get("/api/stats", (_req, res) => {
  const total = (db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n;
  const todayNew = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE first_seen_at >= ?").get(localDayStartIso()) as any).n;
  const scored = (db.prepare("SELECT COUNT(DISTINCT job_id) n FROM scores").get() as any).n;
  const avg = (db.prepare(`
    SELECT AVG(total) a FROM scores s WHERE s.id = (SELECT id FROM scores WHERE job_id=s.job_id ORDER BY id DESC LIMIT 1)
  `).get() as any).a;
  const good = (db.prepare(`
    SELECT COUNT(*) n FROM (SELECT total FROM scores s WHERE s.id = (SELECT id FROM scores WHERE job_id=s.job_id ORDER BY id DESC LIMIT 1)) WHERE total >= 70
  `).get() as any).n;
  const cost = db.prepare("SELECT SUM(cost_input) i, SUM(cost_output) o, SUM(cost_cache_hit) h FROM scores").get() as any;
  const costYuan = estimateCost(cost.i || 0, cost.o || 0, cost.h || 0);

  res.json({ total, todayNew, scored, avgScore: avg ? Number(avg.toFixed(1)) : 0, goodCount: good, costYuan: Number(costYuan.toFixed(3)) });
});

/** ?tagFilter=0 → 只打标签、不过滤（看板上「临时关闭过滤」用） */
const tagFilterOn = (req: express.Request) => req.query.tagFilter !== "0";

/** 列表接口不需要把 JD 全文发给前端（JD 只用于标签匹配） */
const stripJd = <T extends { jd?: unknown }>(r: T) => { const { jd: _jd, ...rest } = r; return rest; };

/** TOP N（带链接和理由），按标签过滤后再取前 N */
app.get("/api/top", (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "20"), 10), 200);
  const all = latestScores(100_000).filter((r: any) => r.status !== "ignored");
  const { rows } = applyTagFilter(all, listTags(), tagFilterOn(req));
  res.json(rows.slice(0, limit).map(stripJd));
});

/** 岗位列表（分页 + 过滤） */
app.get("/api/jobs", (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 500);
  const offset = parseInt(String(req.query.offset || "0"), 10);
  const platform = req.query.platform as string | undefined;
  const minScore = req.query.minScore ? Number(req.query.minScore) : null;
  const q = (req.query.q as string || "").trim();

  const where: string[] = [];
  const params: any[] = [];
  if (platform) { where.push("j.platform = ?"); params.push(platform); }
  if (q) { where.push("(j.title LIKE ? OR j.company LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  if (minScore != null) { where.push("s.total >= ?"); params.push(minScore); }

  // 标签过滤要在 JS 里做，所以先取全量再分页（岗位量在几千条以内，开销可以忽略）
  const sql = `
    SELECT j.id, j.platform, j.title, j.company, j.salary_raw, j.salary_max, j.city, j.url, j.first_seen_at,
           j.tags, j.jd, j.status,
           s.total, s.dims, s.verdict, s.reason, s.scored_at, s.scoring_version
    FROM jobs j
    LEFT JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id = j.id ORDER BY id DESC LIMIT 1)
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(s.total, -1) DESC, j.id DESC`;
  const { rows, hidden } = applyTagFilter(db.prepare(sql).all(...params) as any[], listTags(), tagFilterOn(req));

  res.json({ rows: rows.slice(offset, offset + limit).map(stripJd), total: rows.length, hidden });
});

/** 平台分布 */
app.get("/api/platforms", (_req, res) => {
  res.json(db.prepare(`
    SELECT j.platform, COUNT(*) n,
           SUM(CASE WHEN s.total >= 70 THEN 1 ELSE 0 END) good
    FROM jobs j
    LEFT JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id=j.id ORDER BY id DESC LIMIT 1)
    GROUP BY j.platform
  `).all());
});

/** 分数分布（直方图） */
app.get("/api/distribution", (_req, res) => {
  const rows = db.prepare(`
    SELECT total FROM scores s WHERE s.id = (SELECT id FROM scores WHERE job_id=s.job_id ORDER BY id DESC LIMIT 1)
  `).all() as { total: number }[];
  const buckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const dist = buckets.map((b, i) => ({
    range: `${b}-${b + 10}`,
    count: rows.filter((r) => r.total >= b && r.total < (i === buckets.length - 1 ? 101 : b + 10)).length,
  }));
  res.json(dist);
});

/** 每日趋势 */
app.get("/api/trend", (_req, res) => {
  const rows = db.prepare(`
    SELECT substr(first_seen_at, 1, 10) d, COUNT(*) n FROM jobs GROUP BY d ORDER BY d
  `).all();
  res.json(rows);
});

/** 打分版本列表（回归迭代用） */
app.get("/api/versions", (_req, res) => {
  res.json(db.prepare(`
    SELECT scoring_version v, COUNT(*) n, ROUND(AVG(total),1) avg, SUM(CASE WHEN total>=70 THEN 1 ELSE 0 END) good
    FROM scores GROUP BY scoring_version ORDER BY MAX(scored_at) DESC
  `).all());
});

/** 版本对比：同一批岗位在两个版本下的分数差异 */
app.get("/api/compare", (req, res) => {
  const v1 = String(req.query.v1 || "");
  const v2 = String(req.query.v2 || "");
  if (!v1 || !v2) return res.status(400).json({ error: "need v1 & v2" });
  const rows = db.prepare(`
    SELECT j.title, j.company, a.total t1, b.total t2, (b.total - a.total) delta, b.verdict verdict
    FROM scores a
    JOIN scores b ON a.job_id = b.job_id AND b.scoring_version = ?
    JOIN jobs j ON j.id = a.job_id
    WHERE a.scoring_version = ?
    ORDER BY ABS(b.total - a.total) DESC
    LIMIT 100
  `).all(v2, v1);
  res.json(rows);
});

/** 今日推荐（首页主区） */
app.get("/api/today", (req, res) => {
  const today = localDate();
  // 第一次打开（还从没生成过推荐）时现场生成一次
  if (!latestRecommendDate()) rebuildRecommendations(today);
  const date = latestRecommendDate() || today;
  const tf = tagFilterOn(req);
  const fmt = (r: any) => ({ ...stripJd(r), salaryText: fmtSalary(r) });
  const cur = recommendationsOn(date, tf);
  const old = backlog(date, tf);
  const lastRun = db.prepare("SELECT finished_at, platform, query, found, inserted FROM runs ORDER BY id DESC LIMIT 1").get() as any;
  const todayCount = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE last_seen_at >= ?").get(localDayStartIso()) as any).n;
  res.json({
    date, isToday: date === today,
    rows: cur.rows.map(fmt), hidden: cur.hidden,
    backlog: old.rows.map(fmt),
    lastRun, todayCount,
  });
});

/** 改了标签 / 想换一批：重新挑今天的推荐（已处理的保留） */
app.post("/api/today/rebuild", (_req, res) => {
  res.json(rebuildRecommendations(localDate()));
});

/** 岗位状态：已投 / 稍后 / 不感兴趣 / 撤销 */
app.post("/api/jobs/:id/status", express.json(), (req, res) => {
  const status = String(req.body?.status || "") as JobStatus;
  if (!JOB_STATUSES.includes(status)) return res.status(400).json({ error: `status 只能是 ${JOB_STATUSES.join("/")}` });
  res.json({ ok: setJobStatus(Number(req.params.id), status) });
});

/** ---------- 简历：打分对照的就是它；改了之后所有岗位按新简历重新打分 ---------- */
app.get("/api/resume", (_req, res) => {
  let text = "";
  try { text = fs.readFileSync(RESUME_PATH, "utf8"); } catch { /* 还没有 */ }
  res.json({ text, chars: loadResume().length });
});

app.post("/api/resume", express.json({ limit: "200kb" }), (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (text.length < 50) return res.status(400).json({ error: "简历太短了，请粘贴完整简历" });
  fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
  fs.writeFileSync(RESUME_PATH, text + "\n", "utf8");
  res.json({ ok: true });
});

/** 上传简历文件（PDF / Word / Markdown / TXT）：提取文字存成 profile/resume.md，原文件另存一份 */
app.post("/api/resume/upload", express.raw({ type: "*/*", limit: "15mb" }), async (req, res) => {
  const filename = decodeURIComponent(String(req.headers["x-filename"] || "resume"));
  const buf = req.body as Buffer;
  if (!buf?.length) return res.status(400).json({ error: "文件是空的" });
  try {
    const text = await extractResumeText(buf, filename);
    if (text.length < 50) return res.status(400).json({ error: "没提取到文字（可能是扫描版 PDF），请直接粘贴简历文本" });
    fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(RESUME_PATH), `resume-source${path.extname(filename).toLowerCase()}`), buf);
    fs.writeFileSync(RESUME_PATH, `<!-- 由上传的 ${filename.replace(/--/g, "")} 自动提取，可以在看板上直接修改 -->\n\n${text}\n`, "utf8");
    res.json({ ok: true, chars: text.length, preview: text.slice(0, 200) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** ---------- 关键词策略 ---------- */
app.get("/api/strategy", (_req, res) => {
  const sc = scoreQueries();
  const plan = selectQueries();
  res.json({
    budget: QUERY_BUDGET,
    queries: listQueries().map((q) => {
      const s = sc.get(q.keyword)!;
      return { ...q, runs: s.runs, mean: s.mean, totalNew: s.totalNew, totalGood: s.totalGood, nextRun: plan.find((p) => p.keyword === q.keyword)?.why ?? null };
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.status === "retired" ? 1 : 0) - (b.status === "retired" ? 1 : 0) || b.mean - a.mean),
    plan,
    suggestions: topSuggestions(14, 12),
    log: recentLog(20),
  });
});

/** 关键词操作：add / pin / unpin / retire / activate / delete */
app.post("/api/strategy/query", express.json(), (req, res) => {
  const keyword = String(req.body?.keyword || "").trim();
  const action = String(req.body?.action || "");
  if (!keyword) return res.status(400).json({ error: "缺少关键词" });
  let ok = false;
  switch (action) {
    case "add": ok = addQuery(keyword, "user", "手动添加", "active"); break;
    case "pin": ok = setQueryState(keyword, { pinned: true }); break;
    case "unpin": ok = setQueryState(keyword, { pinned: false }); break;
    case "retire": ok = setQueryState(keyword, { status: "retired", reason: "手动淘汰" }); break;
    case "activate": ok = setQueryState(keyword, { status: "active", reason: "手动恢复" }); break;
    case "delete": ok = deleteQuery(keyword); break;
    default: return res.status(400).json({ error: "未知操作" });
  }
  res.json({ ok });
});

/** ---------- 平台状态 & 一键处理 ---------- */
app.get("/api/platform-status", (_req, res) => {
  const st = getState();
  const loginRunning = st.status === "running" && st.kind === "login";
  const queued = loginRunning && st.lines.some((l) => l.includes("排队中")) && !st.lines.some((l) => l.startsWith("▶ ") && !l.startsWith("▶ 启动"));
  res.json(allStatuses().map((s) => ({
    ...s, kind: PLATFORMS[s.platform].kind,
    // autoCollect=false：默认不自动采集（平台有机器人检测，绕过属于规避，不做）
    autoCollect: AUTO_PLATFORMS.includes(s.platform),
    handling: loginRunning && (st.platform === s.platform || !st.platform),
    queued: queued && (st.platform === s.platform || !st.platform),
  })));
});

/** 去处理 / 登录：打开可见窗口，完成后自动检测 */
app.post("/api/platform-status/:p/resolve", express.json(), (req, res) => {
  const p = req.params.p as Platform;
  if (!BROWSER_PLATFORMS.includes(p)) return res.status(400).json({ ok: false, message: "这个平台不需要登录" });
  const mode = req.body?.mode === "login" ? "login" : "auto";
  res.json(startTask("login", { LOGIN_PLATFORM: p, LOGIN_MODE: mode }, { platform: p }));
});

/** 我已完成：自动检测没认出来时，手动告诉登录窗口可以收尾了 */
app.post("/api/platform-status/:p/done", (req, res) => {
  const p = req.params.p as Platform;
  if (!BROWSER_PLATFORMS.includes(p)) return res.status(400).json({ ok: false });
  const dir = path.resolve(process.cwd(), ".cache");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `login-done-${p}`), new Date().toISOString());
  res.json({ ok: true });
});

/** ---------- 标签 ---------- */
const tagErr = (res: express.Response, e: unknown) =>
  e instanceof TagError ? res.status(400).json({ error: e.message }) : res.status(500).json({ error: String((e as Error)?.message || e) });

app.get("/api/tags", (_req, res) => {
  const tags = listTags();
  const hits = tagHitCounts(tags);
  res.json(tags.map((t) => ({ ...t, hits: hits[t.id] ?? 0 })));
});

app.post("/api/tags", express.json(), (req, res) => {
  try { res.json(createTag(req.body || {})); } catch (e) { tagErr(res, e); }
});

app.patch("/api/tags/:id", express.json(), (req, res) => {
  try { res.json(updateTag(Number(req.params.id), req.body || {})); } catch (e) { tagErr(res, e); }
});

app.delete("/api/tags/:id", (req, res) => {
  res.json({ ok: deleteTag(Number(req.params.id)) });
});

/** ---------- 任务控制 ---------- */
app.post("/api/run/:kind", express.json(), (req, res) => {
  const kind = req.params.kind as any;
  const extra: Record<string, string> = {};
  const body = req.body || {};
  if (body.pages) extra.MAX_PAGES = String(body.pages);
  if (body.queries) extra.DAILY_QUERIES = String(body.queries);
  res.json(startTask(kind, extra));
});

app.post("/api/stop", (_req, res) => res.json({ ok: stopTask() }));

app.get("/api/run/status", (_req, res) => {
  res.json({ ...getState(), running: isRunning() });
});

/** ---------- 配置读写 ---------- */
app.get("/api/config", (_req, res) => {
  const e = loadEnv();
  res.json({
    queries: e.DAILY_QUERIES || "",
    maxPages: e.MAX_PAGES || "2",
    detailLimit: e.DETAIL_LIMIT || "60",
    topN: e.TOP_N || "20",
    openKeywords: e.OPEN_KEYWORDS_COUNT || "2",
    hasKey: Boolean(e.DEEPSEEK_API_KEY),
    keyMasked: e.DEEPSEEK_API_KEY ? e.DEEPSEEK_API_KEY.slice(0, 6) + "..." + e.DEEPSEEK_API_KEY.slice(-4) : "",
  });
});

app.post("/api/config", express.json(), (req, res) => {
  const b = req.body || {};
  const changes: Record<string, string> = {};
  if (b.key) changes.DEEPSEEK_API_KEY = String(b.key).trim();
  if (b.queries != null) changes.DAILY_QUERIES = String(b.queries).trim();
  if (b.maxPages != null) changes.MAX_PAGES = String(b.maxPages);
  if (b.detailLimit != null) changes.DETAIL_LIMIT = String(b.detailLimit);
  if (b.topN != null) changes.TOP_N = String(b.topN);
  if (b.openKeywords != null) changes.OPEN_KEYWORDS_COUNT = String(b.openKeywords);
  updateEnvFile(path.resolve(process.cwd(), ".env"), changes);
  res.json({ ok: true });
});

/**
 * 只改动传进来的几个键，其余行（注释、其他配置）原样保留。
 * 以前是按固定清单整个重写 .env，清单外的配置（期望薪资、城市、官网关键词…）会被删掉。
 */
function updateEnvFile(envPath: string, changes: Record<string, string>) {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n") : [];
  for (const [k, raw] of Object.entries(changes)) {
    // 去掉换行：否则一个字段值就能往 .env 里注入任意变量（比如改 DEEPSEEK_BASE_URL 把 key 发给别人）
    let v = raw.replace(/[\r\n]+/g, " ").trim();
    // 有空格 / # / 引号的值加双引号，dotenv 能正确读出完整值
    if (/[\s#"']/.test(v)) v = `"${v.replace(/"/g, "")}"`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"), "utf8");
}

// 只监听本机：看板没有鉴权，且能改 .env、能起任务，不能暴露给局域网
/** 把 salary_min/max 格式化成 "18-35K·16薪" */
function fmtSalary(r: any): string {
  const lo = r.salary_min, hi = r.salary_max, m = r.salary_months;
  if (lo == null && hi == null) return r.salary_raw || "面议";
  const k = (v: number) => (v >= 1 ? `${Math.round(v)}K` : `${Math.round(v * 10) / 10}K`);
  const range = lo != null && hi != null ? `${k(lo)}-${k(hi)}` : k((lo ?? hi) as number);
  return m ? `${range}·${m}薪` : range;
}


/**
 * 浏览即采集导入新岗位后自动打分：等最后一次导入后 1 分钟（你还在翻页时不打扰），
 * 用 score 任务打分（走任务锁，和每日任务不冲突），打完追加到今日推荐。
 * 有任务在跑就过 2 分钟再试。
 */
let autoScoreTimer: NodeJS.Timeout | null = null;
function scheduleAutoScore(delayMs = 60_000, tries = 0) {
  if (autoScoreTimer) clearTimeout(autoScoreTimer);
  autoScoreTimer = setTimeout(() => {
    autoScoreTimer = null;
    if (isRunning()) { if (tries < 15) scheduleAutoScore(120_000, tries + 1); return; }
    startTask("score", { SCORE_TOPUP: "1" });
  }, delayMs);
}

/** ---------- 手动导入岗位（从 BOSS / 猎聘 等不方便自动采集的地方）---------- */
app.post("/api/manual-jobs", express.json({ limit: "1mb" }), async (req, res) => {
  const body = req.body || {};
  const raw = String(body.text || "").trim();

  // ---- 分支 A：油猴/MV3 插件转发的「页面接口响应」----
  // 脚本是直接把 payload 放在顶层的；也兼容把同一份 JSON 塞进 text 字段
  const api = (() => {
    if (body && (body as any).__jobhunter && (body as any).raw !== undefined) return body as any;
    try { return JSON.parse(raw); } catch { return null; }
  })();
  if (api && api.__jobhunter && api.raw !== undefined) {
    const { parseApiPayload, parseSalary: parseSal } = await import("./api-import.js");
    const { upsertJob } = await import("../db.js");
    const { recordHit } = await import("../strategy.js");
    const { localDate } = await import("../time.js");

    const parsed = parseApiPayload({
      platform: api.platform, kind: api.kind, query: api.query,
      pageUrl: api.pageUrl, raw: api.raw,
    });

    if (parsed.detailJob) {
      const d = parsed.detailJob;
      const row = db.prepare("SELECT id FROM jobs WHERE platform=? AND external_id=?").get(d.platform, d.externalId) as any;
      if (row) {
        const sal = d.salaryRaw ? parseSal(d.salaryRaw) : { salaryMin: null, salaryMax: null, months: null };
        db.prepare(`UPDATE jobs SET jd=COALESCE(NULLIF(?,''),jd), salary_raw=COALESCE(NULLIF(?,''),salary_raw),
                    salary_min=COALESCE(?,salary_min), salary_max=COALESCE(?,salary_max),
                    salary_months=COALESCE(?,salary_months), last_seen_at=? WHERE id=?`)
          .run(d.jd, d.salaryRaw, sal.salaryMin, sal.salaryMax, sal.months, new Date().toISOString(), row.id);

        // 补到 JD 后立刻重新打分（否则它会一直卡在「无 JD 封顶 65」）
        let rescored: number | null = null;
        try {
          const full = db.prepare("SELECT * FROM jobs WHERE id=?").get(row.id) as any;
          const { scoreJob: doScore, SCORING_VERSION } = await import("../score/scorer.js");
          const { saveScore } = await import("../db.js");
          const res2 = await doScore({
            title: full.title, company: full.company || "", salaryRaw: full.salary_raw || "",
            salaryMax: full.salary_max, salaryMonths: full.salary_months,
            city: full.city || "", tags: (() => { try { return JSON.parse(full.tags || "[]"); } catch { return []; } })(),
            jd: full.jd || "",
          });
          saveScore(row.id, SCORING_VERSION, "detail", res2);
          rescored = res2.total;
          // 补完 JD 分数够了，马上追加进今日推荐
          const { topUpRecommendations } = await import("../recommend.js");
          topUpRecommendations();
        } catch { /* 打分失败不影响补 JD */ }

        return res.json({ ok: true, mode: "api-detail", count: 0, updated: 1, note: "已补 JD 并重新打分", rescored });
      }
      return res.json({ ok: true, mode: "api-detail", count: 0, note: "详情对应岗位还没进库（先翻列表页）" });
    }

    let inserted = 0, updated = 0;
    // 批次标识要以「YYYY-MM-DDTHH:MM」开头，和自动采集的批次可比较（关键词策略按它排序、按时间窗口取数）
    const runKey = `${localDate()}T12:00 import-${api.platform}`;
    for (const j of parsed.jobs.slice(0, 300)) {
      const sal = parseSal(String(j.salaryRaw || ""));
      const r = upsertJob(
        { ...j, query: api.query || j.query || "import" },
        { min: sal.salaryMin, max: sal.salaryMax, months: sal.months }
      );
      r.isNew ? inserted++ : updated++;
      // 记到关键词策略：用的是你真正搜的那个词
      if (api.query) recordHit(runKey, String(api.query), api.platform, r.id, r.isNew);
    }
    if (inserted) scheduleAutoScore(); // 有新岗位：1 分钟后自动打分并追加到今日推荐
    return res.json({ ok: true, mode: "api", count: inserted + updated, inserted, updated, note: parsed.note, query: api.query || "" });
  }

  if (!raw) return res.status(400).json({ error: "没有内容" });

  // 支持两种输入：
  //   1) 纯 URL 列表，一行一个 → 只登记链接，标题留空，等补详情
  //   2) 粘贴的岗位文本（标题/公司/薪资/JD 混在一起）→ 直接入库并打分
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const urls = lines.filter((l) => /^https?:\/\//.test(l));
  const isUrlOnly = urls.length > 0 && urls.length === lines.length;

  const { upsertJob, saveScore } = await import("../db.js");
  const { parseSalary } = await import("../score/salary.js");
  const { scoreJob } = await import("../score/scorer.js");
  const { SCORING_VERSION } = await import("../config.js");

  const results: { title: string; total?: number; verdict?: string; error?: string }[] = [];

  if (isUrlOnly) {
    for (const u of urls.slice(0, 50)) {
      const platform = /zhipin\.com/.test(u) ? "boss" : /liepin\.com/.test(u) ? "liepin" : /zhaopin\.com/.test(u) ? "zhaopin" : "boss";
      const id = u.split(/[?#]/)[0].replace(/\/$/, "").split("/").pop() || u;
      const r = upsertJob(
        { platform: platform as any, externalId: `manual-${id}`, title: "(待补详情)", company: "", salaryRaw: "", tags: [], url: u, query: "manual" },
        { min: null, max: null, months: null }
      );
      results.push({ title: u.slice(0, 60) });
      void r;
    }
    return res.json({ ok: true, mode: "url", count: results.length, note: "已登记链接。标题和 JD 需要补：在页面上点「补详情」或直接粘贴岗位文本" });
  }

  // 文本模式：整段当作一个岗位
  const firstLine = lines[0].slice(0, 80);
  const salaryGuess = raw.match(/\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk千万]/);
  const companyGuess = (raw.match(/公司[：:]\s*([^\n]{2,30})/) || raw.match(/^([^\n]{2,20}(?:有限公司|科技|集团))/m) || [])[1] || "";
  const sal = parseSalary(salaryGuess?.[0] || "");

  const { id } = upsertJob(
    {
      platform: "boss" as any,
      externalId: `manual-${Date.now()}`,
      title: (body.title || firstLine).slice(0, 80),
      company: body.company || companyGuess,
      salaryRaw: salaryGuess?.[0] || "",
      city: body.city || "深圳",
      tags: [],
      jd: raw,
      url: body.url || "",
      query: "manual",
    },
    { min: sal.salaryMin, max: sal.salaryMax, months: sal.months }
  );

  const result = await scoreJob({
    title: (body.title || firstLine).slice(0, 80),
    company: body.company || companyGuess,
    salaryRaw: salaryGuess?.[0] || "", salaryMax: sal.salaryMax, salaryMonths: sal.months,
    city: body.city || "深圳", tags: [], jd: raw,
  });
  saveScore(id, SCORING_VERSION, "manual", result);
  results.push({ title: (body.title || firstLine).slice(0, 60), total: result.total, verdict: result.verdict });
  res.json({ ok: true, mode: "text", count: 1, results });
});

/** 书签小工具代码（前端生成 href） */

/**
 * 打开招聘站搜索页 —— ⭐ 用「关键词策略」当天选出的词，而不是写死的固定词
 * 只调用系统 open，不抓取、不注入、不模拟操作。
 */
const SEARCH_URL: Record<string, (kw: string) => string> = {
  boss: (kw) => `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(kw)}&city=101280600`,
  liepin: (kw) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(kw)}&city=050020`,
  zhaopin: (kw) => `https://www.zhaopin.com/jobs/?kw=${encodeURIComponent(kw)}&jl=765`,
};

function buildOpenPlan() {
  // ⚠️ 必须现读 .env：进程启动后改配置不会更新 process.env
  const env = loadEnv();
  const perPlatform = Math.max(1, Math.min(5, parseInt(env.OPEN_KEYWORDS_COUNT || "2", 10)));
  const platforms = (env.OPEN_PLATFORMS || "boss,liepin,zhaopin").split(",").map((x) => x.trim()).filter((x) => SEARCH_URL[x]);
  // 取策略排在最前面（UCB 最高）的词
  const plan = selectQueries(Math.max(perPlatform, 1)).slice(0, perPlatform);
  const keywords = plan.map((p) => p.keyword);
  const urls: { platform: string; keyword: string; url: string }[] = [];
  for (const kw of keywords) for (const pf of platforms) urls.push({ platform: pf, keyword: kw, url: SEARCH_URL[pf](kw) });
  return { keywords, detail: plan, platforms, urls, tabs: urls.length };
}

/** 预览：会用哪些词、开几个标签页 */
app.get("/api/open-searches/plan", (_req, res) => res.json(buildOpenPlan()));

/** 执行：按计划打开 */
app.post("/api/open-searches", (_req, res) => {
  const plan = buildOpenPlan();
  if (!plan.urls.length) return res.json({ ok: false, message: "关键词策略还没选出词（先跑一轮采集）" });
  void (async () => {
    const { execFile } = await import("node:child_process");
    let opened = 0;
    for (const u of plan.urls) {
      // 用装了采集脚本的浏览器打开（系统默认浏览器可能是别的，脚本不在那里就收不到数据）
      const browser = loadEnv().SEARCH_BROWSER || "Google Chrome";
      await new Promise<void>((r) => execFile("/usr/bin/open", ["-a", browser, u.url], (err) => {
        if (err) execFile("/usr/bin/open", [u.url], () => { opened++; r(); }); // 指定的浏览器不存在就退回默认浏览器
        else { opened++; r(); }
      }));
      await new Promise((r) => setTimeout(r, 400));
    }
    res.json({ ok: true, message: `已打开 ${opened} 个标签页`, keywords: plan.keywords, tabs: plan.tabs });
  })();
});

/** 待补 JD：已入库、分数还行、但缺 JD（补了才能进推荐） */
app.get("/api/pending-jd", (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "24"), 10), 100);
  const { SCORING_VERSION } = { SCORING_VERSION: (db.prepare("SELECT scoring_version v FROM scores ORDER BY id DESC LIMIT 1").get() as any)?.v };
  const rows = db.prepare(`
    SELECT j.id, j.platform, j.title, j.company, j.salary_raw, j.salary_min, j.salary_max, j.salary_months,
           j.city, j.url, s.total, s.reason
    FROM jobs j
    LEFT JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id=j.id ORDER BY id DESC LIMIT 1)
    WHERE length(trim(COALESCE(j.jd,''))) < 80
      AND j.status = 'new'
      AND j.url != ''
      AND (s.total IS NULL OR s.total >= 45)
      AND (? IS NULL OR s.scoring_version = ?)
    ORDER BY
      -- 无 JD 时 total 会被封顶成同一个值，改用「技术匹配」维度排序才有区分度
      CAST(COALESCE(json_extract(s.dims, '$.tech'), 0) AS REAL) DESC,
      COALESCE(s.total, 0) DESC,
      j.last_seen_at DESC
    LIMIT ?
  `).all(SCORING_VERSION ?? null, SCORING_VERSION ?? null, limit) as any[];
  res.json({ rows: rows.map((r) => ({ ...r, salaryText: fmtSalary(r) })), total: rows.length });
});

/** 给油猴/MV3 脚本读的配置（在看板上改，脚本下次加载生效） */

/**
 * 公司画像：找出「开得起高薪、还在扩招」的公司
 *
 * 为什么不只看公司名：小而有钱、处于上升期的公司往往比大厂更舍得给钱。
 * 这里用「薪资 + 岗位数」当代理信号，
 * 而不是靠一份写死的大厂名单。
 */
app.get("/api/companies", async (req, res) => {
  const minSalary = parseFloat(String(req.query.minSalary || "25"));
  const minJobs = parseInt(String(req.query.minJobs || "2"), 10);
  const limit = Math.min(parseInt(String(req.query.limit || "40"), 10), 200);

  // 只要「技术岗」多的公司：否则高薪的化工/地产/证券也会混进来
  const TECH_JOB = "%AI%|%算法%|%模型%|%推理%|%平台%|%后端%|%架构%|%Agent%|%大模型%|%研发%|%工程师%|%Infra%";
  const rows = db.prepare(`
    SELECT company,
           COUNT(*) AS jobs,
           MAX(salary_max) AS maxSalary,
           MIN(salary_min) AS minSalary,
           SUM(CASE WHEN length(trim(jd)) >= 80 THEN 1 ELSE 0 END) AS withJd,
           GROUP_CONCAT(DISTINCT platform) AS platforms,
           MAX(city) AS city,
           MAX(last_seen_at) AS lastSeen
    FROM jobs
    WHERE salary_max >= ? AND company != '' AND company NOT LIKE '%某%'
      AND (${TECH_JOB.split("|").map(() => "title LIKE ?").join(" OR ")})
    GROUP BY company
    HAVING jobs >= ?
    ORDER BY maxSalary DESC, jobs DESC
    LIMIT ?
  `).all(minSalary, ...TECH_JOB.split("|"), minJobs, limit) as any[];

  const { OUTSOURCE_COMPANIES, COMPANY_TIERS } = await import("../config.js");
  const tierOf = (co: string) =>
    COMPANY_TIERS.s.some((n) => co.includes(n)) ? "S"
    : COMPANY_TIERS.a.some((n) => co.includes(n)) ? "A"
    : COMPANY_TIERS.b.some((n) => co.includes(n)) ? "B" : "成长型";

  res.json({
    rows: rows
      .filter((r) => !OUTSOURCE_COMPANIES.test(r.company))   // 外包/人力公司不算机会
      .map((r) => ({
        company: r.company, jobs: r.jobs, maxSalary: r.maxSalary, minSalary: r.minSalary,
        withJd: r.withJd, platforms: String(r.platforms || "").split(","),
        city: r.city || "", tier: tierOf(r.company), lastSeen: r.lastSeen,
      })),
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n📊 看板已启动： http://localhost:${PORT}\n`);
});
