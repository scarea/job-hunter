import { latestScores } from "../db.js";
import { applyTagFilter } from "../tags.js";
import { localDate } from "../time.js";
import { SCORING_VERSION } from "../config.js";
import fs from "node:fs";
import path from "node:path";

const TOP_N = 20;

function main() {
  // 按标签过滤（不看 / 仅看）后再取前 N
  const { rows, hidden } = (() => { const r = applyTagFilter(latestScores(100_000)); return { rows: r.rows.slice(0, TOP_N), hidden: r.hidden }; })();
  if (hidden) console.log(`🏷 标签过滤掉 ${hidden} 个岗位`);
  if (!rows.length) { console.log("还没有打分结果。先跑 collect + score。"); return; }

  const today = localDate();
  const lines: string[] = [];

  lines.push(`# 今日 TOP${rows.length} 岗位 · ${today}`);
  lines.push("");
  lines.push(`> 打分卡 ${SCORING_VERSION} ｜ 只读采集，不自动投递${hidden ? ` ｜ 标签过滤掉 ${hidden} 个` : ""}`);
  lines.push("");
  lines.push("| # | 分数 | 岗位 | 公司 | 薪资 | 城市 | 平台 | 理由 |");
  lines.push("|---|---|---|---|---|---|---|---|");

  rows.forEach((r, i) => {
    const dims = safeJson(r.dims, {});
    const sal = r.salary_raw || "面议";
    const link = r.url ? `[${escapeMd(r.title)}](${r.url})` : escapeMd(r.title);
    lines.push(
      `| ${i + 1} | **${Number(r.total).toFixed(1)}** | ${link} | ${escapeMd(r.company || "")} | ${sal} | ${r.city || ""} | ${r.platform} | ${escapeMd(r.reason || "")} |`
    );
  });

  lines.push("");
  lines.push("## 分维度明细");
  lines.push("");
  lines.push("| # | 岗位 | 技术 | 薪资 | 双休 | 公司 | 成长 |");
  lines.push("|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const d = safeJson(r.dims, {});
    lines.push(`| ${i + 1} | ${escapeMd(r.title)} | ${d.tech ?? "-"} | ${d.salary ?? "-"} | ${d.weekend ?? "-"} | ${d.company ?? "-"} | ${d.growth ?? "-"} |`);
  });

  const outPath = path.resolve(process.cwd(), `data/top${rows.length}-${today}.md`);
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");

  console.log(lines.join("\n"));
  console.log(`\n📄 已保存：${outPath}\n`);
}

function safeJson(s: string, d: any) { try { return JSON.parse(s); } catch { return d; } }
function escapeMd(s: string) { return String(s).replace(/\|/g, "\\|"); }

main();
