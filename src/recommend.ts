import { db } from "./db.js";
import { applyTagFilter } from "./tags.js";
import { localDate } from "./time.js";
import { SCORING_VERSION } from "./config.js";

/**
 * 今日推荐
 *
 * 目标：每天只给你看「没看过、值得看」的一小批，看过的不再重复出现。
 *   - 候选：最新分数 ≥ MIN_SCORE、状态是 new、从没被推荐过、最近 STALE_DAYS 天内还在平台上出现
 *   - 按标签过滤（不看 / 仅看）后取前 TOP_N，打上 recommended_on = 今天
 *   - 推荐过但没处理的 → 进「待处理」，不会第二天又作为新推荐冒出来
 *   - 「稍后再看」的一直在「待处理」里，直到你标记已投或不感兴趣
 */
// 68：高于「无 JD 封顶 65」，只凭标题猜的岗位不进推荐，等补到 JD 重新打分再说（宁缺毋滥）
export const MIN_SCORE = parseFloat(process.env.MIN_SCORE || "68");
export const STALE_DAYS = parseInt(process.env.STALE_DAYS || "14", 10);
const topN = () => parseInt(process.env.TOP_N || "20", 10);
const MAX_PER_COMPANY = parseInt(process.env.MAX_PER_COMPANY || "5", 10);

const LATEST_SCORE = "JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id = j.id ORDER BY id DESC LIMIT 1)";
const COLS = `j.id, j.platform, j.title, j.company, j.salary_raw, j.salary_min, j.salary_max, j.salary_months,
  j.city, j.url, j.jd, j.tags, j.status, j.status_at, j.recommended_on, j.first_seen_at, j.last_seen_at,
  s.total, s.dims, s.verdict, s.reason, s.scored_at`;

/**
 * 重新生成某天的推荐：保留当天已处理（已投/稍后/不感兴趣）的，没处理的放回候选池重新挑。
 * 改了标签之后调用，就能按新标签重新选。
 */
export function rebuildRecommendations(date = localDate()): { added: number; hidden: number } {
  return db.transaction(() => {
    db.prepare("UPDATE jobs SET recommended_on = NULL WHERE recommended_on = ? AND status = 'new'").run(date);
    const staleBefore = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
    // 只认当前打分版本的分数：规则 / 简历换了之后，旧版本的高分不再算数
    const candidates = db.prepare(`
      SELECT ${COLS} FROM jobs j ${LATEST_SCORE}
      WHERE s.scoring_version = ? AND s.total >= ? AND j.status = 'new' AND j.recommended_on IS NULL AND j.last_seen_at >= ?
      ORDER BY s.total DESC
    `).all(SCORING_VERSION, MIN_SCORE, staleBefore) as any[];
    const { rows, hidden } = applyTagFilter(candidates);
    // 同一公司同名岗位（不同城市/批次重复发布）只推一个；
    // 同一家公司每天最多推 MAX_PER_COMPANY 个，免得腾讯官网 300 个岗位把别的平台挤掉（剩下的明天接着推）
    const seen = new Set<string>();
    const perCompany = new Map<string, number>();
    const picked: any[] = [];
    for (const r of rows) {
      const key = `${r.company}|${normTitle(r.title)}`;
      const group = companyGroup(r.company);
      if (seen.has(key) || (perCompany.get(group) ?? 0) >= MAX_PER_COMPANY) continue;
      seen.add(key);
      perCompany.set(group, (perCompany.get(group) ?? 0) + 1);
      picked.push(r);
      if (picked.length >= topN()) break;
    }
    const mark = db.prepare("UPDATE jobs SET recommended_on = ? WHERE id = ?");
    for (const r of picked) mark.run(date, r.id);
    return { added: picked.length, hidden };
  })();
}

/**
 * 追加推荐：不动今天已有的推荐，只把新出现的够格岗位补进来（浏览即采集导入后用）。
 * 同公司每天上限、同名去重都把今天已有的算进去；一天最多追加 maxAdd 个。
 */
export function topUpRecommendations(date = localDate(), maxAdd = topN()): { added: number } {
  return db.transaction(() => {
    const today = db.prepare(`SELECT company, title FROM jobs WHERE recommended_on = ?`).all(date) as { company: string; title: string }[];
    const seen = new Set(today.map((r) => `${r.company}|${normTitle(r.title)}`));
    const perCompany = new Map<string, number>();
    for (const r of today) perCompany.set(companyGroup(r.company), (perCompany.get(companyGroup(r.company)) ?? 0) + 1);
    const staleBefore = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
    const candidates = db.prepare(`
      SELECT ${COLS} FROM jobs j ${LATEST_SCORE}
      WHERE s.scoring_version = ? AND s.total >= ? AND j.status = 'new' AND j.recommended_on IS NULL AND j.last_seen_at >= ?
      ORDER BY s.total DESC
    `).all(SCORING_VERSION, MIN_SCORE, staleBefore) as any[];
    const { rows } = applyTagFilter(candidates);
    const mark = db.prepare("UPDATE jobs SET recommended_on = ? WHERE id = ?");
    let added = 0;
    for (const r of rows) {
      if (added >= maxAdd) break;
      const key = `${r.company}|${normTitle(r.title)}`;
      const g = companyGroup(r.company);
      if (seen.has(key) || (perCompany.get(g) ?? 0) >= MAX_PER_COMPANY) continue;
      seen.add(key);
      perCompany.set(g, (perCompany.get(g) ?? 0) + 1);
      mark.run(date, r.id);
      added++;
    }
    return { added };
  })();
}

/** 「腾讯·CSIG」「腾讯·IEG」算同一家 */
const companyGroup = (c: string) => (c || "").split(/[·・\-(（]/)[0].trim();

/** 去掉括号里的城市 / 批次说明，用来识别重复发布的同一岗位 */
export function normTitle(t: string): string {
  return t.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "").replace(/[\s\-—_·/]+/g, "").toLowerCase();
}

/** 最近一次生成推荐的日期（今天还没跑就显示上一次的） */
export function latestRecommendDate(): string | null {
  return (db.prepare("SELECT MAX(recommended_on) d FROM jobs").get() as { d: string | null }).d;
}

/** 某天的推荐列表（含已处理的，前端按状态区分显示），按标签实时过滤 */
export function recommendationsOn(date: string, tagFilter = true) {
  const rows = db.prepare(`SELECT ${COLS} FROM jobs j ${LATEST_SCORE} WHERE j.recommended_on = ? ORDER BY s.total DESC`).all(date) as any[];
  return applyTagFilter(rows, undefined, tagFilter);
}

/** 待处理：以前推荐过但还没处理的 + 所有「稍后再看」 */
export function backlog(beforeDate: string, tagFilter = true) {
  const rows = db.prepare(`
    SELECT ${COLS} FROM jobs j ${LATEST_SCORE}
    WHERE (j.status = 'later') OR (j.status = 'new' AND j.recommended_on < ?)
    ORDER BY j.status = 'later' DESC, s.total DESC
    LIMIT 200
  `).all(beforeDate) as any[];
  return applyTagFilter(rows, undefined, tagFilter);
}
