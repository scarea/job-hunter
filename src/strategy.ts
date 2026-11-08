import { db } from "./db.js";
import { loadResume, SCORING_VERSION } from "./config.js";
import { MIN_SCORE } from "./recommend.js";

/**
 * 关键词策略：搜索 → 打分 → 复盘 → 调整关键词 的正反馈闭环
 *
 *  1. 记账：每个关键词每轮带来了哪些岗位（query_hits），打完分后算收益
 *       收益 = 新岗位里达到推荐门槛的个数 + 0.3 × 相关（≥50 分）的个数 + 0.2 × 老岗位里的高分个数
 *  2. 选词：UCB（利用 + 探索）。收益高的多跑；样本少的、新加入的保留固定比例的探索名额
 *  3. 建议：每个高分岗位打分时 LLM 顺带给 1–3 个「能搜到更多同类岗位」的词，按分数加权累计
 *  4. 复盘：每轮结束 LLM 看「各词收益 + 累计建议词 + 简历」，提出增 / 删，由护栏决定是否执行
 *
 * 防止越搜越窄（简历小众时尤其要防）：
 *  - 种子词（配置里填的）和钉住的词永不淘汰；活跃词数量有下限
 *  - 每天最多新增 3 个；至少跑 3 轮才允许淘汰
 *  - 淘汰的词 21 天后回到候选池重新试
 *  - 新岗位太少 / 可推荐的不够时进入「拓宽模式」：不淘汰，并要求 LLM 给更宽泛、相邻方向的词
 *  - 固定比例的探索名额，永远有新词在被试
 */

export const QUERY_BUDGET = parseInt(process.env.QUERY_BUDGET || "8", 10);   // 每天给浏览器平台跑几个关键词
const EXPLORE_RATIO = 0.3;
const MIN_ACTIVE = 6;
const MAX_ADD_PER_RUN = 3;
const MIN_RUNS_BEFORE_RETIRE = 3;
const RETEST_AFTER_DAYS = 21;
const UCB_C = 1.0;
const DECAY = 0.85;            // 越早的轮次权重越低
const BREADTH_MIN_NEW = parseInt(process.env.BREADTH_MIN_NEW || "30", 10);

db.exec(`
CREATE TABLE IF NOT EXISTS search_queries (
  keyword TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'candidate',   -- active | candidate | retired
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed',        -- seed | ai | user
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE IF NOT EXISTS query_hits (
  run_key TEXT NOT NULL,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  is_new INTEGER NOT NULL,
  PRIMARY KEY (run_key, keyword, platform, job_id)
);
CREATE INDEX IF NOT EXISTS idx_hits_keyword ON query_hits(keyword);
CREATE TABLE IF NOT EXISTS keyword_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  weight REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, keyword)
);
CREATE TABLE IF NOT EXISTS strategy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key TEXT NOT NULL,
  action TEXT NOT NULL,                       -- add | retire | promote | retest | review | skip
  keyword TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();
export const newRunKey = () => now().slice(0, 16); // 精确到分钟，一轮采集一个

/** 关键词规范化：去空白、统一大小写，用来去重（「AI Agent」和「ai agent」算一个） */
export const normKeyword = (k: string) => k.replace(/\s+/g, " ").trim();
const keyOf = (k: string) => normKeyword(k).toLowerCase().replace(/\s/g, "");

function log(runKey: string, action: string, keyword: string, reason: string) {
  db.prepare("INSERT INTO strategy_log (run_key, action, keyword, reason, created_at) VALUES (?,?,?,?,?)").run(runKey, action, keyword, reason, now());
}

// ---------------- 词表 ----------------

export interface QueryRow { keyword: string; status: string; pinned: number; source: string; reason: string; created_at: string; updated_at: string; retired_at: string | null }

export function listQueries(): QueryRow[] {
  return db.prepare("SELECT * FROM search_queries ORDER BY pinned DESC, status, keyword").all() as QueryRow[];
}

function findQuery(k: string): QueryRow | undefined {
  const key = keyOf(k);
  return listQueries().find((q) => keyOf(q.keyword) === key);
}

/** 种子词（配置里的 DAILY_QUERIES）：没有就加进来，已淘汰的种子词恢复 */
export function seedQueries(seeds: string[]) {
  for (const s of seeds.map(normKeyword).filter(Boolean)) {
    const cur = findQuery(s);
    if (!cur) {
      db.prepare("INSERT INTO search_queries (keyword, status, source, reason, created_at, updated_at) VALUES (?, 'active', 'seed', '配置里的初始关键词', ?, ?)").run(s, now(), now());
    } else if (cur.source !== "seed") {
      db.prepare("UPDATE search_queries SET source = 'seed', status = 'active', retired_at = NULL, updated_at = ? WHERE keyword = ?").run(now(), cur.keyword);
    }
  }
}

export function addQuery(keyword: string, source: "ai" | "user", reason: string, status: "active" | "candidate" = "candidate"): boolean {
  const k = normKeyword(keyword);
  if (k.length < 2 || k.length > 20) return false;
  const cur = findQuery(k);
  if (cur) {
    if (cur.status === "retired" && source === "user") {
      db.prepare("UPDATE search_queries SET status = ?, retired_at = NULL, reason = ?, updated_at = ? WHERE keyword = ?").run(status, reason, now(), cur.keyword);
      return true;
    }
    return false;
  }
  db.prepare("INSERT INTO search_queries (keyword, status, source, reason, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(k, status, source, reason, now(), now());
  return true;
}

export function setQueryState(keyword: string, patch: { pinned?: boolean; status?: "active" | "candidate" | "retired"; reason?: string }) {
  const cur = findQuery(keyword);
  if (!cur) return false;
  if (patch.pinned != null) db.prepare("UPDATE search_queries SET pinned = ?, updated_at = ? WHERE keyword = ?").run(patch.pinned ? 1 : 0, now(), cur.keyword);
  if (patch.status) {
    db.prepare("UPDATE search_queries SET status = ?, retired_at = ?, reason = COALESCE(?, reason), updated_at = ? WHERE keyword = ?")
      .run(patch.status, patch.status === "retired" ? now() : null, patch.reason ?? null, now(), cur.keyword);
  }
  return true;
}

export function deleteQuery(keyword: string) {
  const cur = findQuery(keyword);
  if (!cur || cur.source === "seed") return false;
  return db.prepare("DELETE FROM search_queries WHERE keyword = ?").run(cur.keyword).changes > 0;
}

// ---------------- 记账 & 收益 ----------------

export function recordHit(runKey: string, keyword: string, platform: string, jobId: number, isNew: boolean) {
  db.prepare("INSERT OR IGNORE INTO query_hits (run_key, keyword, platform, job_id, is_new) VALUES (?,?,?,?,?)").run(runKey, keyword, platform, jobId, isNew ? 1 : 0);
}

export interface QueryRunStat { run_key: string; keyword: string; found: number; new_jobs: number; unscored: number; good: number; relevant: number; good_old: number; reward: number }

/** 每个关键词每轮的收益（按当前打分版本实时算：打分晚到、简历换版本都会自动反映） */
export function runStats(sinceDays = 30): QueryRunStat[] {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 16);
  const rows = db.prepare(`
    SELECT h.run_key, h.keyword,
      COUNT(DISTINCT h.job_id) found,
      COUNT(DISTINCT CASE WHEN h.is_new = 1 THEN h.job_id END) new_jobs,
      COUNT(DISTINCT CASE WHEN h.is_new = 1 AND s.total IS NULL THEN h.job_id END) unscored,
      COUNT(DISTINCT CASE WHEN h.is_new = 1 AND s.total >= @min THEN h.job_id END) good,
      COUNT(DISTINCT CASE WHEN h.is_new = 1 AND s.total >= 50 AND s.total < @min THEN h.job_id END) relevant,
      COUNT(DISTINCT CASE WHEN h.is_new = 0 AND s.total >= @min THEN h.job_id END) good_old
    FROM query_hits h
    LEFT JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id = h.job_id AND scoring_version = @ver ORDER BY id DESC LIMIT 1)
    WHERE h.run_key >= @since
    GROUP BY h.run_key, h.keyword
    ORDER BY h.run_key
  `).all({ min: MIN_SCORE, ver: SCORING_VERSION, since }) as Omit<QueryRunStat, "reward">[];
  return rows.map((r) => ({ ...r, reward: r.good + 0.3 * r.relevant + 0.2 * r.good_old }));
}

export interface QueryScore { keyword: string; runs: number; mean: number; ucb: number; lastFound: number; totalGood: number; totalNew: number }

/** 时间衰减的平均收益 + UCB 探索加成 */
export function scoreQueries(): Map<string, QueryScore> {
  const stats = runStats(45);
  const byKw = new Map<string, QueryRunStat[]>();
  for (const s of stats) (byKw.get(s.keyword) ?? byKw.set(s.keyword, []).get(s.keyword)!).push(s);
  const totalRuns = new Set(stats.map((s) => s.run_key)).size;
  const out = new Map<string, QueryScore>();
  for (const q of listQueries()) {
    const runs = byKw.get(q.keyword) ?? [];
    let wsum = 0, rsum = 0;
    runs.slice().reverse().forEach((r, i) => { const w = Math.pow(DECAY, i); wsum += w; rsum += w * r.reward; });
    const mean = wsum ? rsum / wsum : 0;
    const ucb = runs.length ? mean + UCB_C * Math.sqrt(Math.log(totalRuns + 1) / runs.length) : Infinity;
    out.set(q.keyword, {
      keyword: q.keyword, runs: runs.length, mean: Math.round(mean * 100) / 100, ucb,
      lastFound: runs.at(-1)?.found ?? 0,
      totalGood: runs.reduce((a, r) => a + r.good, 0),
      totalNew: runs.reduce((a, r) => a + r.new_jobs, 0),
    });
  }
  return out;
}

// ---------------- 选词 ----------------

/**
 * 今天跑哪些词：钉住的必跑 → 探索名额（候选词、样本少的）→ 剩下按 UCB 从高到低
 */
export function selectQueries(budget = QUERY_BUDGET): { keyword: string; why: string }[] {
  const qs = listQueries().filter((q) => q.status !== "retired");
  const sc = scoreQueries();
  const picked: { keyword: string; why: string }[] = [];
  const take = (k: string, why: string) => { if (!picked.some((p) => p.keyword === k)) picked.push({ keyword: k, why }); };

  for (const q of qs.filter((q) => q.pinned)) take(q.keyword, "钉住");

  const exploreSlots = Math.max(2, Math.round(budget * EXPLORE_RATIO));
  const explore = qs.filter((q) => !q.pinned)
    .sort((a, b) => (sc.get(a.keyword)!.runs - sc.get(b.keyword)!.runs) || (a.status === "candidate" ? -1 : 1));
  for (const q of explore) {
    if (picked.length >= budget || picked.filter((p) => p.why.startsWith("探索")).length >= exploreSlots) break;
    if (sc.get(q.keyword)!.runs < MIN_RUNS_BEFORE_RETIRE) take(q.keyword, `探索（已跑 ${sc.get(q.keyword)!.runs} 轮）`);
  }

  const exploit = qs.filter((q) => q.status === "active").sort((a, b) => sc.get(b.keyword)!.ucb - sc.get(a.keyword)!.ucb);
  for (const q of exploit) {
    if (picked.length >= budget) break;
    take(q.keyword, `收益 ${sc.get(q.keyword)!.mean}`);
  }
  for (const q of qs) { if (picked.length >= budget) break; take(q.keyword, "补位"); } // 词不够时什么都跑
  return picked;
}

// ---------------- 打分时的关键词建议 ----------------

/** 高分岗位的 LLM 建议词，按分数加权记下来（同一岗位同一个词只记一次） */
export function recordSuggestions(jobId: number, keywords: unknown, score: number) {
  if (!Array.isArray(keywords) || score < 60) return;
  const ins = db.prepare("INSERT OR IGNORE INTO keyword_suggestions (job_id, keyword, weight, created_at) VALUES (?,?,?,?)");
  for (const k of keywords.slice(0, 3)) {
    if (typeof k !== "string") continue;
    const kw = normKeyword(k);
    if (kw.length >= 2 && kw.length <= 16) ins.run(jobId, kw, Math.round((score / 100) * 100) / 100, now());
  }
}

/** 最近 N 天累计的建议词（加权），排除已在词表里的 */
export function topSuggestions(days = 14, limit = 20): { keyword: string; weight: number; jobs: number }[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = db.prepare(`
    SELECT keyword, SUM(weight) weight, COUNT(*) jobs FROM keyword_suggestions
    WHERE created_at >= ? GROUP BY keyword ORDER BY weight DESC LIMIT ?
  `).all(since, limit * 3) as { keyword: string; weight: number; jobs: number }[];
  const existing = new Set(listQueries().map((q) => keyOf(q.keyword)));
  const merged = new Map<string, { keyword: string; weight: number; jobs: number }>();
  for (const r of rows) {
    const key = keyOf(r.keyword);
    if (existing.has(key)) continue;
    const m = merged.get(key);
    if (m) { m.weight += r.weight; m.jobs += r.jobs; } else merged.set(key, { ...r });
  }
  return [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, limit)
    .map((r) => ({ ...r, weight: Math.round(r.weight * 10) / 10 }));
}

// ---------------- 复盘 ----------------

export interface ReviewResult { mode: "normal" | "broaden"; added: string[]; retired: string[]; promoted: string[]; retested: string[]; summary: string }

/** 拓宽模式：最近几轮新岗位太少，或可推荐的存货不够 */
function needBroaden(): { broaden: boolean; why: string } {
  const stats = runStats(10);
  const runKeys = [...new Set(stats.map((s) => s.run_key))].slice(-3);
  const avgNew = runKeys.length ? runKeys.reduce((a, k) => a + stats.filter((s) => s.run_key === k).reduce((x, s) => x + s.new_jobs, 0), 0) / runKeys.length : 0;
  const pool = (db.prepare(`
    SELECT COUNT(*) n FROM jobs j JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id = j.id ORDER BY id DESC LIMIT 1)
    WHERE s.scoring_version = ? AND s.total >= ? AND j.status = 'new' AND j.recommended_on IS NULL
  `).get(SCORING_VERSION, MIN_SCORE) as { n: number }).n;
  const topN = parseInt(process.env.TOP_N || "20", 10);
  if (runKeys.length && avgNew < BREADTH_MIN_NEW) return { broaden: true, why: `最近 ${runKeys.length} 轮平均只有 ${avgNew.toFixed(0)} 个新岗位` };
  if (pool < topN) return { broaden: true, why: `可推荐的存货只剩 ${pool} 个` };
  return { broaden: false, why: "" };
}

const LLM_BASE = () => process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const LLM_KEY = () => process.env.DEEPSEEK_API_KEY || "";
const LLM_MODEL = () => process.env.DEEPSEEK_MODEL || "deepseek-chat";

async function askStrategist(input: object, broaden: boolean): Promise<{ add: { keyword: string; reason: string }[]; retire: { keyword: string; reason: string }[]; summary: string } | null> {
  if (!LLM_KEY()) return null;
  const system = `你是招聘搜索策略顾问。求职者每天用一组关键词在招聘网站（BOSS直聘 / 智联 / 猎聘）搜索深圳的岗位，你根据每个词的历史收益和简历调整词表。

【求职者简历】
${loadResume().slice(0, 3000) || "（无）"}

【规则】
- 关键词要像真人在招聘网站搜索框里输入的：2–8 个字，岗位名或核心技术词，不要公司名、不要句子
- 收益 = 新岗位里达到推荐门槛的个数（主要）+ 相关岗位个数（次要）
- 新增的词要和现有词有差异：不同的岗位叫法、相邻方向、上下游技术，不要只是同义改写
- ${broaden ? "⚠️ 现在是【拓宽模式】：岗位来源在变少。只新增、不淘汰；优先给更宽泛的通用岗位名和相邻方向的词，让搜索面变大" : "淘汰只针对跑了多轮、收益一直垫底、且和简历关系弱的词；不确定就别淘汰"}
- 最多新增 ${MAX_ADD_PER_RUN} 个，最多淘汰 2 个

只返回 JSON：{"add":[{"keyword":"…","reason":"一句话"}],"retire":[{"keyword":"…","reason":"一句话"}],"summary":"一句话总结这轮的调整思路"}`;
  try {
    const res = await fetch(`${LLM_BASE()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY()}` },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: LLM_MODEL(), temperature: 0.4, max_tokens: 800, response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const p = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return { add: Array.isArray(p.add) ? p.add : [], retire: Array.isArray(p.retire) ? p.retire : [], summary: String(p.summary || "") };
  } catch (e: any) {
    console.log(`  ⚠️ 关键词复盘 LLM 调用失败：${e.message}（本轮只做规则调整）`);
    return null;
  }
}

/**
 * 每轮结束后复盘：规则调整（转正 / 淘汰 / 重新测试）+ LLM 增删建议，全部过护栏
 */
export async function reviewStrategy(runKey: string, logFn: (...a: any[]) => void = console.log): Promise<ReviewResult> {
  const result: ReviewResult = { mode: "normal", added: [], retired: [], promoted: [], retested: [], summary: "" };
  const { broaden, why } = needBroaden();
  result.mode = broaden ? "broaden" : "normal";
  if (broaden) logFn(`  🔭 拓宽模式：${why}`);

  const sc = scoreQueries();
  const qs = listQueries();
  const activeMeans = qs.filter((q) => q.status === "active" && sc.get(q.keyword)!.runs > 0).map((q) => sc.get(q.keyword)!.mean).sort((a, b) => a - b);
  const median = activeMeans.length ? activeMeans[Math.floor(activeMeans.length / 2)] : 0;

  // 1) 淘汰满 21 天的词回到候选池，重新试一次（市场在变）
  for (const q of qs.filter((q) => q.status === "retired" && q.retired_at && Date.now() - new Date(q.retired_at).getTime() > RETEST_AFTER_DAYS * 86400_000)) {
    setQueryState(q.keyword, { status: "candidate", reason: "淘汰满 21 天，重新测试" });
    log(runKey, "retest", q.keyword, "淘汰满 21 天，重新测试");
    result.retested.push(q.keyword);
  }

  // 2) 候选词：跑够 2 轮且收益不低于活跃词中位数 → 转正
  for (const q of qs.filter((q) => q.status === "candidate")) {
    const s = sc.get(q.keyword)!;
    if (s.runs >= 2 && s.mean >= median && s.mean > 0) {
      setQueryState(q.keyword, { status: "active", reason: `试跑 ${s.runs} 轮，收益 ${s.mean} ≥ 中位数 ${median}` });
      log(runKey, "promote", q.keyword, `收益 ${s.mean} ≥ 中位数 ${median}`);
      result.promoted.push(q.keyword);
    }
  }

  // 3) LLM 复盘
  const stats = [...sc.values()].map((s) => {
    const q = qs.find((x) => x.keyword === s.keyword)!;
    return { keyword: s.keyword, status: q.status, pinned: !!q.pinned, source: q.source, runs: s.runs, avgReward: s.mean, totalNewJobs: s.totalNew, totalGoodJobs: s.totalGood };
  });
  const advice = await askStrategist({ mode: result.mode, reason: why, keywords: stats, suggestedByScoredJobs: topSuggestions() }, broaden);
  if (advice) {
    result.summary = advice.summary;
    log(runKey, "review", "", `${result.mode}｜${advice.summary}`);

    for (const a of advice.add) {
      if (result.added.length >= MAX_ADD_PER_RUN) break;
      if (typeof a?.keyword !== "string") continue;
      if (addQuery(a.keyword, "ai", String(a.reason || "").slice(0, 80))) {
        log(runKey, "add", normKeyword(a.keyword), String(a.reason || ""));
        result.added.push(normKeyword(a.keyword));
      }
    }

    for (const r of advice.retire) {
      if (broaden || result.retired.length >= 2) break; // 拓宽模式不淘汰
      const q = typeof r?.keyword === "string" ? findQuery(r.keyword) : undefined;
      if (!q || q.status === "retired") continue;
      const s = sc.get(q.keyword)!;
      const activeCount = listQueries().filter((x) => x.status === "active").length;
      const guard =
        q.pinned ? "已钉住" :
        q.source === "seed" ? "是种子词" :
        s.runs < MIN_RUNS_BEFORE_RETIRE ? `只跑了 ${s.runs} 轮` :
        s.mean > median ? `收益 ${s.mean} 高于中位数` :
        q.status === "active" && activeCount <= MIN_ACTIVE ? `活跃词只剩 ${activeCount} 个` : "";
      if (guard) { log(runKey, "skip", q.keyword, `AI 建议淘汰，但${guard}，保留`); continue; }
      setQueryState(q.keyword, { status: "retired", reason: String(r.reason || "").slice(0, 80) });
      log(runKey, "retire", q.keyword, String(r.reason || ""));
      result.retired.push(q.keyword);
    }
  }
  return result;
}

export function recentLog(limit = 30) {
  return db.prepare("SELECT run_key, action, keyword, reason, created_at FROM strategy_log ORDER BY id DESC LIMIT ?").all(limit);
}
