import "dotenv/config";
import { acquireTaskLock } from "../lock.js";
import { ALL_PLATFORMS } from "../collectors/index.js";
import { newPage, closeBrowser } from "../collectors/base.js";
import { collectPlatforms } from "../pipeline.js";
import type { Platform } from "../types.js";
import { seedQueries, selectQueries, newRunKey } from "../strategy.js";

/**
 * 只采集（不补详情、不打分）
 *   pnpm collect
 *   pnpm collect --platforms boss,tencent --queries "大模型,Agent" --pages 1
 *   pnpm collect --force        忽略冷却期（被拦后想立刻重试时用）
 */
const DEFAULT_QUERIES = [
  "AI大模型", "大模型平台", "模型接入", "推理服务", "AI网关",
  "Agent开发", "LLM", "AI应用开发", "后端开发 AI",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const platforms = (get("platforms") || ALL_PLATFORMS.join(",")).split(",").map((s) => s.trim()) as Platform[];
  const unknown = platforms.filter((p) => !ALL_PLATFORMS.includes(p));
  if (unknown.length) { console.error(`未知平台：${unknown.join(",")}（可选 ${ALL_PLATFORMS.join(",")}）`); process.exit(2); }
  return {
    platforms,
    /** 没指定 --queries 时按关键词策略选词，并记账 */
    explicitQueries: !!get("queries"),
    queries: (get("queries") || process.env.DAILY_QUERIES || DEFAULT_QUERIES.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    maxPages: parseInt(get("pages", process.env.MAX_PAGES || "2") || "2", 10),
    force: args.includes("--force"),
  };
}

async function main() {
  acquireTaskLock("collect");
  const { platforms, explicitQueries, maxPages, force } = parseArgs();
  let { queries } = parseArgs();
  let runKey: string | undefined;
  if (!explicitQueries) {
    seedQueries(queries);
    queries = selectQueries().map((p) => p.keyword);
    runKey = newRunKey();
  }
  console.log(`\n🔍 采集开始：${platforms.join(" / ")} | ${queries.length} 个关键词 | 每词 ${maxPages} 页\n`);
  const page = await newPage();
  const sum = await collectPlatforms({ platforms, queries, maxPages, page, log: console.log, ignoreCooldown: force, runKey });
  console.log(`\n✅ 采集完成：共 ${sum.found} 条，新增 ${sum.inserted}`);
  if (sum.blocked.length || sum.skipped.length) console.log(`⚠️ 被拦/冷却中的平台：${[...sum.blocked, ...sum.skipped].join("、")}，到看板点「去处理」`);
  await closeBrowser();
}

main().catch(async (e) => { console.error(e); await closeBrowser(); process.exit(1); });
