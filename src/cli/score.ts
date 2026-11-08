import "dotenv/config";
import { acquireTaskLock } from "../lock.js";
import { scorePending } from "../pipeline.js";

/** 给还没打分的岗位打分：pnpm score [--limit 300] */
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  return { limit: parseInt(get("limit", "100") || "100", 10) };
}

async function main() {
  acquireTaskLock("score");
  const { limit } = parseArgs();
  const r = await scorePending({
    limit, log: console.log,
    onEach: (j, result, i, n) => {
      const flag = result.rejectRule ? "⛔" : result.total >= 70 ? "🔥" : result.total >= 50 ? "✅" : "·";
      console.log(`  ${flag} [${String(i + 1).padStart(3)}/${n}] ${result.total.toFixed(1).padStart(5)}  ${String(j.title).slice(0, 28)} @ ${String(j.company).slice(0, 14)}`);
    },
  });
  console.log(`💰 输入 ${r.inTok.toLocaleString()} / 输出 ${r.outTok.toLocaleString()} tokens ≈ ¥${r.cost.toFixed(3)}`);
  // 浏览即采集导入后由看板触发：打完分把够格的新岗位追加进今天的推荐
  if (process.env.SCORE_TOPUP === "1") {
    const { topUpRecommendations } = await import("../recommend.js");
    const { added } = topUpRecommendations();
    console.log(`📌 追加到今日推荐：${added} 个`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
