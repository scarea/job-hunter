/**
 * 每周更新「值得关注的公司」
 *
 * 做两件事：
 *  1) 从 jobs 表重算公司画像（岗位数、薪资、平台、城市），并补上官网/招聘页链接
 *  2) 让 AI 逐个看一遍：这家值不值得关注、为什么、给个 0-100 的关注度
 *
 * 为什么需要 AI：光靠「最高薪 + 岗位数」排序会把化工、地产、证券也排上来，
 * 也会把「钱多但方向不对」的公司排到前面。AI 能结合岗位标题判断方向是否对口。
 */
import "dotenv/config";
import { acquireTaskLock } from "../lock.js";
import { aggregateCompanies, saveWatch, setAnnotation, listWatch, type CompanyWatchRow } from "../companies.js";
import { OUTSOURCE_COMPANIES, COMPANY_TIERS } from "../config.js";
import { db } from "../db.js";

const BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const KEY = process.env.DEEPSEEK_API_KEY || "";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const PRICE_IN = parseFloat(process.env.PRICE_IN || "3");
const PRICE_OUT = parseFloat(process.env.PRICE_OUT || "6");

const tierOf = (co: string) =>
  COMPANY_TIERS.s.some((n) => co.includes(n)) ? "S"
  : COMPANY_TIERS.a.some((n) => co.includes(n)) ? "A"
  : COMPANY_TIERS.b.some((n) => co.includes(n)) ? "B" : "成长型";

interface Judge { company: string; watch: number; note: string }

async function judgeBatch(batch: { company: string; titles: string[]; maxSalary: number | null; jobs: number; city: string }[]): Promise<{ judges: Judge[]; inTok: number; outTok: number }> {
  const payload = batch.map((b) => ({
    company: b.company,
    岗位数: b.jobs,
    最高月薪K: b.maxSalary,
    城市: b.city,
    在招岗位样例: b.titles.slice(0, 5),
  }));

  const system = `你在帮一位 AI 平台工程师（做模型接入、AI 网关、多模型分流、推理服务、Agent 平台）评估公司。
对每家公司判断：值得关注吗？关注度 0-100，并给一句 20 字以内的理由。

判断要点：
- 方向对口最重要：有 AI 平台/推理/网关/MaaS/Agent/大模型 相关岗位 → 高分
- 刚融资、在扩招的成长型公司 → 加分（有钱且缺人，往往比大厂更舍得给钱）
- 与 AI 无关的传统行业（化工、地产、证券、物流）即使开高薪 → 低分
- 外包/人力派遣 → 0 分
- 招聘岗位明显是销售/HR/行政/助理 → 低分

只输出 JSON：{"results":[{"company":"...","watch":数字,"note":"..."}]}`;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const d: any = await res.json();
  const text = d?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(text);
  return {
    judges: Array.isArray(parsed.results) ? parsed.results : [],
    inTok: d?.usage?.prompt_tokens ?? 0,
    outTok: d?.usage?.completion_tokens ?? 0,
  };
}

async function main() {
  acquireTaskLock("companies");
  const log = console.log;
  log("🏢 更新「值得关注的公司」");

  // 1) 重算画像
  // 门槛放宽到「开得起 20K + 至少 1 个技术岗」：严格按 2 个岗筛会只剩个位数，
  // 噪声交给 AI 的关注度打分去排
  const agg = aggregateCompanies(20, 1).filter((c) => !OUTSOURCE_COMPANIES.test(c.company));
  log(`  从 jobs 聚合到 ${agg.length} 家（已排除外包/人力）`);
  saveWatch(agg);

  // 2) AI 点评
  if (!KEY) {
    log("  ⚠️ 没配 DEEPSEEK_API_KEY，跳过 AI 点评（只更新画像和链接）");
    for (const c of agg) setAnnotation(c.company, "", 0, tierOf(c.company));
    return;
  }

  // 带上岗位标题样例，AI 才能判断方向
  const titlesOf = db.prepare("SELECT title FROM jobs WHERE company LIKE ? LIMIT 8");
  const items = agg.map((c) => ({
    company: c.company,
    jobs: c.jobs,
    maxSalary: c.maxSalary,
    city: c.city,
    titles: (titlesOf.all(`%${c.company.split(/[·｜|(（]/)[0]}%`) as any[]).map((r) => String(r.title)),
  }));

  let inTok = 0, outTok = 0;
  const BATCH = 8;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      const r = await judgeBatch(batch);
      inTok += r.inTok; outTok += r.outTok;
      for (const j of r.judges) {
        if (!j?.company) continue;
        setAnnotation(String(j.company), String(j.note || "").slice(0, 60), Number(j.watch) || 0, tierOf(String(j.company)));
      }
      log(`  AI 点评 ${Math.min(i + BATCH, items.length)}/${items.length}`);
    } catch (e: any) {
      log(`  ❌ 批次失败：${e.message}`);
      for (const b of batch) setAnnotation(b.company, "", 0, tierOf(b.company));
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const cost = (inTok / 1e6) * PRICE_IN + (outTok / 1e6) * PRICE_OUT;
  log(`💰 ${inTok} / ${outTok} tokens ≈ ¥${cost.toFixed(3)}`);

  // 3) 结果
  const top = listWatch(20);
  log("\n值得关注 TOP10：");
  top.slice(0, 10).forEach((c: CompanyWatchRow, i) => {
    log(`  ${i + 1}. [${c.watch}] ${c.company.slice(0, 22)} ${c.maxSalary}K ${c.jobs}岗  ${c.note}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
