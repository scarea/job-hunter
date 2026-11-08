import "dotenv/config";
import { applyRules } from "./rules.js";
import { estimateSalary, CONFIDENCE_FACTOR } from "./salary-estimate.js";
import { buildPrompt } from "./prompt.js";
import { SCORING_VERSION, WEIGHTS } from "../config.js";
import type { ScoreResult, ScoreDims } from "../types.js";

const BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const KEY = process.env.DEEPSEEK_API_KEY || "";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

/** 存进 scores.model 的标签：没配 key 时是纯规则分 */
export const MODEL_LABEL = KEY ? MODEL : "rules";

/** 连续失败这么多次就停（多半是 key 失效 / 余额不足 / 网络断了），别空跑 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * 统一封顶：所有出口（LLM 成功 / LLM 失败 / 无 key）都必须过这一道。
 * 否则 API 抖动时无 JD 的岗位会用规则分冲破 65，混进推荐。
 */
function capTotal(total: number, job: { jd?: string | null }): number {
  let t = total;
  if ((job.jd || "").trim().length < 80) t = Math.min(t, NO_JD_CAP);
  return t;
}

/** 触红线的岗位最高分（低于推荐门槛 50） */
const RED_FLAG_CAP = 45;
/** 没有 JD 的岗位最高分（还能进推荐，但排在有 JD 的后面） */
const NO_JD_CAP = 65;

/** 定价（元 / 百万 tokens），2026-11 DeepSeek-V4-Pro */
const PRICE_IN = parseFloat(process.env.PRICE_IN || "3");
const PRICE_OUT = parseFloat(process.env.PRICE_OUT || "6");
/** 命中前缀缓存的输入单价（DeepSeek 缓存命中远低于未命中；默认按 1/10 估，以官网价格为准） */
const PRICE_IN_HIT = parseFloat(process.env.PRICE_IN_HIT || String(PRICE_IN / 10));

/** 初筛等模块共用的 LLM 配置 */
export const LLM = { base: BASE, key: KEY, model: MODEL };

export interface ScoreInput {
  title: string; company: string; salaryRaw: string; salaryMax: number | null;
  salaryMonths: number | null; city: string; tags: string[]; jd: string;
}

/** 官网岗位普遍不给薪资：用自己采到的真实薪资反推，避免系统性低估 */
interface SalaryHint { text: string; factor: number; estimated: boolean }

function resolveSalary(job: ScoreInput): { salaryMax: number | null; salaryMonths: number | null; hint: SalaryHint } {
  if (job.salaryMax != null && job.salaryMax > 0) {
    return { salaryMax: job.salaryMax, salaryMonths: job.salaryMonths, hint: { text: "", factor: 1, estimated: false } };
  }
  const e = estimateSalary(job.company, job.title);
  if (!e) {
    // 完全估不出：给薪资维度一半的分，别当 0 也别当满分
    return { salaryMax: null, salaryMonths: null, hint: { text: "薪资未公开，按中性处理", factor: 0.5, estimated: true } };
  }
  return {
    salaryMax: e.max,
    salaryMonths: e.months ?? job.salaryMonths,
    hint: {
      text: `薪资官网未公开，估算 ${e.min}-${e.max}K${e.months ? `·${e.months}薪` : ""}（${e.basis}）`,
      factor: CONFIDENCE_FACTOR[e.confidence],
      estimated: true,
    },
  };
}

/**
 * 两段式打分：本地规则先算基线 → LLM 修正
 * LLM 失败时回退到规则分并标记 failed：调用方展示即可，不入库，下次重新打分
 * （否则一次超时就会让这个岗位在当前版本里永远只有规则分，也会污染版本对比）
 */
export async function scoreJob(job: ScoreInput): Promise<ScoreResult> {
  const sal = resolveSalary(job);
  const baseline = applyRules({
    title: job.title, company: job.company, jd: job.jd,
    tags: job.tags, salaryMax: sal.salaryMax, salaryMonths: sal.salaryMonths, city: job.city,
    salaryEstimated: sal.hint.estimated && sal.salaryMax != null,
  });
  // 估算是推测值，薪资维度按置信度打折（high 0.9 / medium 0.75 / low 0.55 / 估不出 0.5）
  if (sal.hint.estimated) {
    baseline.dims.salary = Math.round(baseline.dims.salary * sal.hint.factor * 10) / 10;
    baseline.total = Math.round((baseline.dims.tech + baseline.dims.salary + baseline.dims.weekend + baseline.dims.company + baseline.dims.growth) * 10) / 10;
  }

  // 一票否决，不必调 LLM（省钱）
  if (baseline.reject) {
    return {
      total: 0, dims: baseline.dims, verdict: "不投",
      reason: `命中否决规则：${baseline.reject.label}`,
      rejectRule: baseline.reject.id,
    };
  }

  if (!KEY) {
    const total = capTotal(baseline.total, job);
    return {
      total, dims: baseline.dims,
      verdict: total >= 70 ? "建议投" : total >= 50 ? "可投" : "不投",
      reason: `[规则分] ${baseline.signals.slice(0, 3).join("；")}`,
    };
  }

  // 薪资是估算的：明确告诉 LLM「这是推测」，不要让它把估算当成岗位写明的薪资
  const promptJob = sal.hint.estimated ? { ...job, salaryRaw: `未公开。${sal.hint.text}，这是推测值，不是岗位写明的薪资`, salaryMax: null } : job;
  const { system, user } = buildPrompt(promptJob, baseline);

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(60_000), // 网络卡住时别让每日任务一直挂着
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: 700, // 要输出 requirements + evidence，300 会被截断
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const usage = { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0, cacheHit: data.usage?.prompt_cache_hit_tokens ?? 0 };

    const parsed = JSON.parse(extractJson(raw));
    const dims = normalizeDims(parsed.dims, baseline.dims);
    // 估算薪资最多拿到「满分 × 置信度」：推测出来的钱不能和写明的钱一样算
    if (sal.hint.estimated) dims.salary = Math.min(dims.salary, round1(WEIGHTS.salary * sal.hint.factor));
    let total = round1(dims.tech + dims.salary + dims.weekend + dims.company + dims.growth);
    // 分数要和结论一致：模型认定触红线的（外包、大小周、方向不对口…）不管其他维度多高都不推荐
    const redFlags: string[] = Array.isArray(parsed.redFlags) ? parsed.redFlags.filter((x: unknown) => typeof x === "string" && x.trim()) : [];
    if (redFlags.length) total = Math.min(total, RED_FLAG_CAP);
    // 没有 JD 只能凭标题猜，技术匹配无从验证：封顶，让有 JD 的优先
    if ((job.jd || "").trim().length < 80) total = Math.min(total, NO_JD_CAP);
    // 结论只由总分决定，不让模型给出和分数矛盾的结论
    const verdict = total >= 70 ? "建议投" : total >= 50 ? "可投" : "不投";

    return {
      total, dims, verdict,
      reason: (redFlags.length ? `⚠️${redFlags[0].slice(0, 30)}｜` : (job.jd || "").trim().length < 80 ? "[无JD] " : "")
        + (sal.hint.estimated ? "[薪资估算] " : "") + String(parsed.reason || "").slice(0, 100),
      aiRaw: raw, usage,
      searchKeywords: Array.isArray(parsed.searchKeywords) ? parsed.searchKeywords.filter((k: unknown) => typeof k === "string").slice(0, 3) : [],
    };
  } catch (e: any) {
    const total = capTotal(baseline.total, job);
    return {
      total, dims: baseline.dims,
      verdict: total >= 70 ? "建议投" : total >= 50 ? "可投" : "不投",
      reason: `[LLM失败，用规则分] ${baseline.signals.slice(0, 3).join("；")}`,
      aiRaw: `ERROR: ${e.message}`,
      failed: true,
    };
  }
}

function extractJson(s: string): string {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : "{}";
}

function normalizeDims(d: any, fallback: ScoreDims): ScoreDims {
  const n = (v: any, def: number, max: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : def;
  };
  return {
    tech: n(d?.tech, fallback.tech, 30),
    salary: n(d?.salary, fallback.salary, 25),
    weekend: n(d?.weekend, fallback.weekend, 20),
    company: n(d?.company, fallback.company, 15),
    growth: n(d?.growth, fallback.growth, 10),
  };
}

function round1(v: number) { return Math.round(v * 10) / 10; }

/** 成本估算（元） */
export function estimateCost(inputTokens: number, outputTokens: number, cacheHit = 0) {
  return ((inputTokens - cacheHit) / 1_000_000) * PRICE_IN + (cacheHit / 1_000_000) * PRICE_IN_HIT + (outputTokens / 1_000_000) * PRICE_OUT;
}

export { SCORING_VERSION };
