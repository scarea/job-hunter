import type { Page } from "playwright";
import type { Platform } from "./types.js";
import { collectHybrid } from "./collectors/hybrid.js";
import { fetchDetail } from "./collectors/detail.js";
import { pace } from "./collectors/base.js";
import { TARGET_COMPANIES } from "./config.js";
import { db, upsertJob, startRun, finishRun, unscoredJobs, saveScore, setJobStatus } from "./db.js";
import { parseSalary } from "./score/salary.js";
import { applyRules } from "./score/rules.js";
import { scoreJob, estimateCost, SCORING_VERSION, MODEL_LABEL, MAX_CONSECUTIVE_FAILURES, LLM } from "./score/scorer.js";
import { triage } from "./score/triage.js";
import { normTitle } from "./recommend.js";
import { PLATFORMS, platformName, inCooldown, blockedSince, markOk, isLoggedIn, getStatus } from "./platforms.js";
import { recordHit, recordSuggestions } from "./strategy.js";

type Log = (...a: any[]) => void;

/**
 * 每日流水线的三个步骤，daily / collect / score 共用。
 */

// ---------------- 1. 采集 ----------------

/**
 * 官网接口只有一家公司的岗位，细分关键词（「Temporal」「模型接入」）大多搜不到，
 * 用宽一点的词把相关岗位都捞回来，交给规则 + LLM 去筛
 */
function queriesFor(platform: Platform, queries: string[]): string[] {
  if (platform !== "tencent" && platform !== "official") return queries;
  const env = platform === "tencent" ? process.env.TENCENT_QUERIES : process.env.OFFICIAL_QUERIES;
  return (env || "大模型,AI,Agent,推理,后台开发,后端").split(",").map((s) => s.trim()).filter(Boolean);
}

export interface CollectSummary { found: number; inserted: number; skipped: Platform[]; blocked: Platform[]; empty: Platform[] }

export async function collectPlatforms(opts: {
  platforms: Platform[]; queries: string[]; maxPages: number; page: Page; log: Log; ignoreCooldown?: boolean;
  /** 传了就记账：每个关键词带来了哪些岗位，给关键词策略算收益 */
  runKey?: string;
}): Promise<CollectSummary> {
  const { platforms, queries, maxPages, page, log } = opts;
  const runStart = new Date().toISOString();
  const sum: CollectSummary = { found: 0, inserted: 0, skipped: [], blocked: [], empty: [] };

  for (const platform of platforms) {
    const cool = !opts.ignoreCooldown && inCooldown(platform);
    if (cool) {
      log(`  ⏸ ${platformName(platform)} 冷却中（${cool.reason}），跳过。看板上点「去处理」可立即恢复`);
      sum.skipped.push(platform);
      continue;
    }

    let platformFound = 0, zeroStreak = 0;
    const isBrowser = PLATFORMS[platform].kind === "browser";
    for (const [qi, q] of queriesFor(platform, queries).entries()) {
      if (blockedSince(platform, runStart)) { log(`  ⏭ ${platformName(platform)} 被拦截，跳过剩余关键词`); break; }
      // 熔断只对浏览器平台：连续没结果多半是被拦或页面改版，继续请求只会更糟；官网接口搜不到就是真没有
      if (isBrowser && zeroStreak >= 2) { log(`  ⏭ ${platformName(platform)} 连续 2 个关键词无结果，跳过剩余关键词`); break; }
      if (qi > 0) await pace(platform, "page"); // 关键词之间也按平台节奏歇一下

      const runId = startRun(platform, q);
      let found = 0, inserted = 0, updated = 0, via = "none";
      const errors: string[] = [];
      try {
        const res = await collectHybrid(platform, q, { maxPages, page });
        via = res.via;

        // 公司专搜：招聘网站的「公司名」匹配很松（搜「万兴科技」会把杭州万兴、南京嘉瑞万兴都带出来），
        // 所以这里按公司名再过滤一次，只留真正对得上的。
        let jobs = res.jobs;
        if (TARGET_COMPANIES.includes(q)) {
          const core = q.replace(/科技|集团|股份|有限公司|公司|创新/g, "").slice(0, 4);
          const before = jobs.length;
          jobs = jobs.filter((j) => String(j.company || "").includes(core));
          if (jobs.length < before) log(`     🏢 公司名过滤：${before} → ${jobs.length}（只留含「${core}」的）`);
        }
        found = jobs.length;
        for (const job of jobs) {
          const sal = parseSalary(job.salaryRaw);
          const r = upsertJob(job, { min: sal.salaryMin, max: sal.salaryMax, months: sal.months });
          r.isNew ? inserted++ : updated++;
          // 只记浏览器平台：官网用的是自己的宽词，不参与关键词策略
          if (opts.runKey && isBrowser) recordHit(opts.runKey, q, platform, r.id, r.isNew);
        }
        if (res.note && !found) errors.push(res.note);
      } catch (e: any) {
        errors.push(e.message);
        log(`  ❌ ${platform}/${q}: ${e.message}`);
      }
      finishRun(runId, found, inserted, updated, errors);
      zeroStreak = found ? 0 : zeroStreak + 1;
      platformFound += found; sum.found += found; sum.inserted += inserted;
      log(`  采集 ${platformName(platform)} · ${q} → ${found}（新 ${inserted}）via=${via}`);
    }

    if (blockedSince(platform, runStart)) sum.blocked.push(platform);
    else if (platformFound > 0) {
      const loggedIn = PLATFORMS[platform].kind === "browser" ? await isLoggedIn(page.context(), platform, page).catch(() => null) : null;
      markOk(platform, { found: platformFound, loggedIn });
    } else sum.empty.push(platform);
  }
  return sum;
}

// ---------------- 2. 补详情 ----------------

/** 每个平台每天最多补多少个详情页：浏览器平台慢且有风险，官网接口随便补 */
function detailBudget(p: Platform): number {
  const base = parseInt(process.env.DETAIL_LIMIT || "30", 10);
  return { tencent: 300, official: 300, zhaopin: base, boss: base, liepin: Math.ceil(base / 2) }[p];
}

export async function fillDetails(opts: { platforms: Platform[]; page: Page; log: Log; since?: string }) {
  const { page, log } = opts;
  const since = opts.since ?? new Date().toISOString();
  for (const platform of opts.platforms) {
    if (inCooldown(platform) && getStatus(platform).updatedAt! < since) continue; // 冷却中的平台不去碰
    if (blockedSince(platform, since)) continue;

    const rows = db.prepare(`
      SELECT j.id, j.platform, j.url, j.external_id, j.title, j.company, j.tags, j.city FROM jobs j
      WHERE j.platform = ? AND (j.jd IS NULL OR j.jd = '') AND j.url != ''
        AND COALESCE(j.status, 'new') NOT IN ('ignored', 'applied', 'closed')
      ORDER BY j.last_seen_at DESC LIMIT 500
    `).all(platform) as { id: number; platform: Platform; url: string; external_id: string; title: string; company: string; tags: string; city: string }[];

    // 标题就能一票否决的（外包/销售/实习…）不浪费详情页请求
    const need = rows.filter((r) => !applyRules({ title: r.title, company: r.company, jd: "", tags: [], salaryMax: null, salaryMonths: null, city: r.city }).reject)
      .slice(0, detailBudget(platform));
    if (!need.length) continue;

    log(`📄 补详情 ${platformName(platform)}：${need.length} 个`);
    let ok = 0;
    for (const [i, j] of need.entries()) {
      if (i > 0) await pace(platform, "detail");
      const info = await fetchDetail(page, platform, j.url, j.external_id);
      if (info.blocked) { log(`  ⛔ ${platformName(platform)} 详情页被拦截，停止补详情`); break; }
      if (info.closed) { setJobStatus(j.id, "closed"); continue; } // 岗位已下线，不再推荐
      if (info.jd || info.salaryRaw) {
        const sal = info.salaryRaw ? parseSalary(info.salaryRaw) : { salaryMin: null, salaryMax: null, months: null };
        db.prepare(`UPDATE jobs SET jd = ?, salary_raw = COALESCE(NULLIF(?,''), salary_raw),
                    salary_min = COALESCE(?, salary_min), salary_max = COALESCE(?, salary_max),
                    salary_months = COALESCE(?, salary_months) WHERE id = ?`)
          .run(info.jd, info.salaryRaw, sal.salaryMin, sal.salaryMax, sal.months, j.id);
        // 之前只凭标题打过分的，拿到 JD 后作废那次分数，按完整 JD 重新打
        if (info.jd) db.prepare("DELETE FROM scores WHERE job_id = ? AND scoring_version = ?").run(j.id, SCORING_VERSION);
        ok++;
      }
      if ((i + 1) % 10 === 0) log(`  详情 ${i + 1}/${need.length}`);
    }
    log(`  ${platformName(platform)} 详情完成：${ok}/${need.length}`);
  }
}

// ---------------- 3. 打分 ----------------

/** 同时打分的请求数：串行 700 个要四十多分钟，4 路并发十分钟左右 */
const SCORE_CONCURRENCY = Math.max(1, parseInt(process.env.SCORE_CONCURRENCY || "4", 10));

export async function scorePending(opts: { limit: number; log: Log; onEach?: (j: any, r: any, i: number, n: number) => void }) {
  const all = unscoredJobs(SCORING_VERSION, opts.limit);
  opts.log(`🧠 打分：${all.length} 个岗位（打分卡 ${SCORING_VERSION}，并发 ${SCORE_CONCURRENCY}）`);
  let inTok = 0, outTok = 0, hitTok = 0, failed = 0, streak = 0, ok = 0, rejected = 0, done = 0, copied = 0, triaged = 0;

  // ① 重复发布的同一岗位（同公司 + 同岗位名 + 同 JD）：已有当前版本分数的直接复用；本批里的只打第一个
  const dupKey = (j: any) => `${j.company}|${normTitle(j.title)}|${(j.jd || "").length}`;
  const scoredByKey = new Map<string, number>(); // key → scores.id
  for (const r of db.prepare(`
    SELECT j.company, j.title, j.jd, s.id sid FROM jobs j JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id = j.id AND scoring_version = ? ORDER BY id DESC LIMIT 1)
  `).all(SCORING_VERSION) as any[]) scoredByKey.set(dupKey(r), r.sid);
  const copyScore = (jobId: number, sid: number) => db.prepare(`
    INSERT INTO scores (job_id, scored_at, scoring_version, model, total, dims, verdict, reason, reject_rule, ai_raw, cost_input, cost_output, cost_cache_hit)
    SELECT ?, ?, scoring_version, 'copy', total, dims, verdict, reason, reject_rule, ai_raw, 0, 0, 0 FROM scores WHERE id = ?`).run(jobId, new Date().toISOString(), sid);

  const leaders: any[] = [];
  const followers = new Map<string, any[]>();
  for (const j of all) {
    const k = dupKey(j);
    const sid = scoredByKey.get(k);
    if (sid) { copyScore(j.id, sid); copied++; continue; }
    if (followers.has(k)) { followers.get(k)!.push(j); continue; }
    followers.set(k, []);
    leaders.push(j);
  }

  // ② 规则能直接否决的不用初筛（scoreJob 里也不会调 LLM）；其余批量初筛，明显无关的不做完整打分
  const toInput = (j: any) => ({ title: j.title, company: j.company, salaryRaw: j.salary_raw || "", salaryMax: j.salary_max, salaryMonths: j.salary_months, city: j.city || "", tags: safeJson(j.tags, []), jd: j.jd || "" });
  const notRejected = leaders.filter((j) => !applyRules({ ...toInput(j) }).reject);
  let jobs = leaders;
  if (LLM.key && notRejected.length) {
    const t = await triage(notRejected.map((j) => ({ id: j.id, title: j.title, company: j.company, jd: j.jd || "" })), LLM);
    inTok += t.usage.input; outTok += t.usage.output; hitTok += t.usage.cacheHit;
    for (const j of notRejected) {
      const why = t.drop.get(j.id);
      if (!why) continue;
      const base = applyRules(toInput(j));
      const total = Math.min(base.total, 35);
      saveScore(j.id, SCORING_VERSION, "triage", { total, dims: base.dims, verdict: "不投", reason: `[初筛] ${why}`, aiRaw: "triage" });
      triaged++;
      for (const f of followers.get(dupKey(j)) ?? []) { saveScore(f.id, SCORING_VERSION, "triage", { total, dims: base.dims, verdict: "不投", reason: `[初筛] ${why}` }); copied++; }
    }
    jobs = leaders.filter((j) => !t.drop.has(j.id));
    opts.log(`  初筛：${notRejected.length} 个里排除 ${triaged} 个明显无关的，复用重复岗位分数 ${copied} 个`);
  }

  // ③ 完整打分
  let next = 0, stop = false;
  const worker = async () => {
    while (!stop && next < jobs.length) {
      const j = jobs[next++];
      const result = await scoreJob(toInput(j));
      // LLM 失败的临时规则分不入库，下次重试；连续失败多半是 key / 余额 / 网络问题，整体停下
      if (result.failed) {
        failed++; streak++;
        if (streak >= MAX_CONSECUTIVE_FAILURES && !stop) {
          stop = true;
          opts.log(`  ⛔ 连续 ${streak} 次 LLM 失败，停止打分：${(result.aiRaw || "").slice(0, 120)}`);
        }
        continue;
      }
      streak = 0;
      saveScore(j.id, SCORING_VERSION, result.rejectRule ? "rules" : MODEL_LABEL, result);
      recordSuggestions(j.id, result.searchKeywords, result.total); // 高分岗位的建议词 → 关键词策略
      // 本批里的重复岗位直接复用这个分数
      const sid = (db.prepare("SELECT id FROM scores WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(j.id) as { id: number }).id;
      for (const f of followers.get(dupKey(j)) ?? []) { copyScore(f.id, sid); copied++; }
      inTok += result.usage?.input ?? 0;
      outTok += result.usage?.output ?? 0;
      hitTok += result.usage?.cacheHit ?? 0;
      result.rejectRule ? rejected++ : ok++;
      done++;
      opts.onEach?.(j, result, done - 1, jobs.length);
      if (!opts.onEach && done % 50 === 0) opts.log(`  打分进度 ${done}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: SCORE_CONCURRENCY }, worker));

  const cost = estimateCost(inTok, outTok, hitTok);
  const hitRate = inTok ? Math.round((hitTok / inTok) * 100) : 0;
  opts.log(`  打分完成：${ok} 个完整打分，${rejected} 个规则否决，${triaged} 个初筛排除，${copied} 个复用${failed ? `，${failed} 个 LLM 失败（未入库，下次重试）` : ""}；本次 ¥${cost.toFixed(3)}（缓存命中 ${hitRate}%）`);
  return { ok, rejected, failed, triaged, copied, cost, inTok, outTok, hitTok };
}

export function safeJson(s: string, d: any) { try { return JSON.parse(s); } catch { return d; } }
