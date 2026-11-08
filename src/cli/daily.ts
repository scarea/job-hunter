import "dotenv/config";
import { acquireTaskLock } from "../lock.js";
import { AUTO_PLATFORMS } from "../collectors/index.js";
import { newPage, closeBrowser } from "../collectors/base.js";
import { collectPlatforms, fillDetails, scorePending } from "../pipeline.js";
import { rebuildRecommendations, recommendationsOn } from "../recommend.js";
import { allStatuses, PLATFORMS } from "../platforms.js";
import { SCORING_VERSION } from "../score/scorer.js";
import { localDate } from "../time.js";
import { seedQueries, selectQueries, reviewStrategy, newRunKey } from "../strategy.js";
import fs from "node:fs";
import path from "node:path";

/**
 * 每日任务：采集 → 补详情 → 打分 → 选出今日新推荐 → 通知
 * 只在「有新推荐」或「有平台需要你处理」时才发通知，没事不打扰。
 */
/** 种子关键词（配置里的）：永不淘汰；每天实际跑哪些词由关键词策略决定 */
const SEED_QUERIES = (process.env.DAILY_QUERIES ||
  "AI大模型,大模型平台,模型接入,推理服务,AI网关,Agent开发,LLM,AI应用开发,后端开发 AI"
).split(",").map((s) => s.trim()).filter(Boolean);

const MAX_PAGES = parseInt(process.env.MAX_PAGES || "2", 10);
const SCORE_LIMIT = parseInt(process.env.SCORE_LIMIT || "200", 10);
const DASHBOARD = `http://localhost:${process.env.PORT || "5173"}`;

const T0 = Date.now();
const log = (...a: any[]) => console.log(`[${new Date().toLocaleTimeString("zh-CN")}]`, ...a);

async function main() {
  acquireTaskLock("daily");
  const runStart = new Date().toISOString();
  log("🚀 每日任务开始");

  // ---------- 0. 选关键词（利用 + 探索）----------
  seedQueries(SEED_QUERIES);
  const runKey = newRunKey();
  const picked = selectQueries();
  log(`🔑 今日关键词 ${picked.length} 个：${picked.map((p) => `${p.keyword}〔${p.why}〕`).join("、")}`);


  // ---------- 1. 采集 ----------
  const page = await newPage();
  const sum = await collectPlatforms({ platforms: AUTO_PLATFORMS, queries: picked.map((p) => p.keyword), maxPages: MAX_PAGES, page, log, runKey });
  log(`📦 采集完成：${sum.found} 条，新增 ${sum.inserted}`);

  // ---------- 2. 补详情（JD + 真实薪资）----------
  await fillDetails({ platforms: AUTO_PLATFORMS, page, log, since: runStart });
  await closeBrowser(); // 后面不需要浏览器了

  // ---------- 3. 打分 ----------
  await scorePending({ limit: SCORE_LIMIT, log });

  // ---------- 3.5 关键词复盘：按这轮的收益和 AI 建议调整明天的词 ----------
  const rv = await reviewStrategy(runKey, log);
  log(`🔁 关键词复盘（${rv.mode === "broaden" ? "拓宽模式" : "常规"}）：新增 ${rv.added.join("、") || "无"}；淘汰 ${rv.retired.join("、") || "无"}；转正 ${rv.promoted.join("、") || "无"}${rv.summary ? `｜${rv.summary}` : ""}`);

  // ---------- 4. 今日新推荐 ----------
  const today = localDate();
  const { added, hidden } = rebuildRecommendations(today);
  const { rows } = recommendationsOn(today);
  if (hidden) log(`  🏷 标签过滤掉 ${hidden} 个岗位`);
  const outPath = path.join(process.cwd(), "data", `today-${today}.md`);
  fs.writeFileSync(outPath, renderMarkdown(rows, today, hidden), "utf8");
  log(`✅ 今日新推荐 ${added} 个 → ${outPath}`);
  log(`⏱  耗时 ${((Date.now() - T0) / 1000 / 60).toFixed(1)} 分钟`);

  // ---------- 5. 通知：只说需要你知道 / 处理的 ----------
  const attention = allStatuses().filter((s) => PLATFORMS[s.platform].kind === "browser" && (s.state === "need_verify" || s.state === "need_login"));
  const hot = rows.filter((r: any) => r.status === "new" && r.total >= 70).length;
  const parts: string[] = [];
  if (added) parts.push(`${added} 个新岗位${hot ? `（${hot} 个 ≥70 分）` : ""}`);
  if (attention.length) parts.push(`${attention.map((s) => s.name).join("、")} 需要你点一下「去处理」`);
  if (parts.length) await notify(attention.length && !added ? "Job Hunter：需要处理" : "Job Hunter：今日推荐", `${parts.join("；")}。打开 ${DASHBOARD}`);
  else log("🔕 没有新岗位、也没有要处理的平台，不发通知");
}

function renderMarkdown(rows: any[], today: string, hidden = 0) {
  const L: string[] = [];
  L.push(`# 今日推荐 · ${today}`, "");
  L.push(`> 打分卡 ${SCORING_VERSION} ｜ 只读采集${hidden ? ` ｜ 标签过滤掉 ${hidden} 个` : ""}`, "");
  if (!rows.length) { L.push("今天没有新的推荐岗位。"); return L.join("\n"); }
  L.push("| # | 分数 | 岗位 | 公司 | 薪资 | 标签 | 理由 |");
  L.push("|---|---|---|---|---|---|---|");
  const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  rows.forEach((r, i) => {
    L.push(`| ${i + 1} | **${Number(r.total).toFixed(1)}** | [${cell(r.title)}](${r.url}) | ${cell(r.company)} | ${cell(r.salary_raw || "面议")} | ${cell((r.matchedTags || []).join("、"))} | ${cell(r.reason)} |`);
  });
  return L.join("\n");
}

async function notify(title: string, body: string) {
  try {
    const { execFile } = await import("node:child_process");
    const esc = (x: string) => x.replace(/["\\]/g, "\\$&");
    execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`]);
    log(`🔔 已发通知：${title} — ${body}`);
  } catch { /* 静默 */ }
}

main()
  .then(() => closeBrowser())
  .catch(async (e) => { console.error(e); await closeBrowser(); process.exit(1); });
