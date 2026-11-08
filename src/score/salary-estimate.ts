/**
 * 官网岗位的薪资估算
 *
 * 背景：大厂官网（official / tencent）共 928 个岗位，接口一律不给薪资。
 * 薪资维度占 25 分，缺了它这些岗位会被系统性地低估 —— AI infra 那种 40-70K 的岗
 * 只能拿到 59-64 分，够不到 68 的推荐门槛。
 *
 * 做法：用**自己采到的真实薪资**（智联/猎聘/BOSS 那 455 条）反推，优先级：
 *   1. 同公司 + 职位词重合   （最可信）
 *   2. 同公司整体           （可信）
 *   3. 同样职位词跨公司      （中位数，样本多为中等、少为低）
 *   4. 没有参考数据          （不估，按「未公开」中性处理）
 *
 * ⚠️ 估算结果**绝不写回数据库**，只在打分时使用：告诉 LLM 这是推测值、
 *    薪资维度按置信度封顶、推荐理由前面标「[薪资估算]」。
 */
import { db } from "../db.js";

export interface SalaryEstimate {
  max: number;          // 月薪上限（K）
  min: number;          // 月薪下限（K）
  months: number | null;
  confidence: "high" | "medium" | "low";
  basis: string;        // 为什么这么估
  samples: number;      // 参考了多少条真实数据
}

/**
 * 公司名归一：「深信服·研发体系」→「深信服」，「深信服科技股份有限公司」→「深信服」，
 * 「深圳市腾讯计算机系统有限公司」→「腾讯计算机系统」。
 * 后缀要反复去（「科技」+「股份有限公司」是两层），否则招聘平台上的全称和官网简称对不上。
 */
const CITY_PREFIX = /^(北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|长沙)(市)?/;
const SUFFIX = /(股份)?有限(责任)?公司$|集团$|科技$|网络$|信息技术$|数字技术$|技术$|控股$|股份$/;
export function normCompany(raw: string): string {
  let s = String(raw || "").split(/[·｜|]/)[0].trim();
  s = s.replace(/[（(](北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|长沙)[^）)]*[）)]/g, "");
  s = s.replace(CITY_PREFIX, "");
  for (let i = 0; i < 4 && SUFFIX.test(s); i++) s = s.replace(SUFFIX, "").trim();
  return s.trim();
}

/** 从标题里抽「职能词」+「职级词」，用于判断两条岗位是不是一类 */
const ROLE_WORDS = [
  ["infra", /infra|基础设施|算力|gpu|异构/i],
  ["AI开发", /ai\s*(应用|开发|工程|研发)|大模型开发|llm/i],
  ["推理", /推理|inference|vllm|sglang/i],
  ["网关", /网关|gateway|apigw/i],
  ["平台", /平台|platform|maas|paas/i],
  ["后端", /后端|后台|服务端|backend|java|go|golang|node/i],
  ["算法", /算法|algorithm|训练|微调|research/i],
  ["架构", /架构|architect|专家|首席|principal|staff/i],
  ["前端", /前端|frontend|web|h5/i],
  ["数据", /数据|数仓|etl|bi/i],
  ["运维", /运维|sre|devops|k8s|云原生/i],
  ["安全", /安全|security/i],
  ["测试", /测试|qa|质量/i],
  ["产品", /产品|product|pm/i],
  ["管理", /总监|经理|负责人|leader|主管/i],
] as const;

const LEVEL_WORDS: [string, RegExp][] = [
  ["实习", /实习|intern|trainee/i],
  ["初级", /初级|应届|junior|校招/i],
  ["高级", /高级|资深|senior|sr\.|expert/i],
  ["专家", /专家|首席|principal|staff|architect|架构师|总监|技术负责人/i],
];

export function roleKeys(title: string): string[] {
  return ROLE_WORDS.filter(([, re]) => re.test(title)).map(([k]) => k);
}

function levelOf(title: string): string {
  for (const [name, re] of LEVEL_WORDS) if (re.test(title)) return name;
  return "中级";
}

/** 职级系数：以「中级」为 1.0 */
const LEVEL_FACTOR: Record<string, number> = { 实习: 0.25, 初级: 0.7, 中级: 1.0, 高级: 1.25, 专家: 1.6 };

interface Sample { company: string; title: string; max: number; months: number | null }

let cache: { samples: Sample[]; version: string } | null = null;

function loadSamples(): Sample[] {
  // 缓存按「条数 + 最大 id + 薪资总和」判断：只看条数的话，删一条加一条、或补详情改了薪资都识别不出来
  const sig = db.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) m, COALESCE(SUM(salary_max),0) s FROM jobs WHERE salary_max > 0").get() as any;
  const n = `${sig.c}:${sig.m}:${sig.s}`;
  if (cache && cache.version === n) return cache.samples;
  const rows = db.prepare(`
    SELECT company, title, salary_max AS max, salary_months AS months
    FROM jobs WHERE salary_max > 0 AND salary_max >= 3 AND title != ''
  `).all() as any[];
  const samples: Sample[] = rows
    .filter((r) => !/实习|intern/i.test(r.title))   // 实习薪资会严重拉低
    .map((r) => ({ company: normCompany(r.company), title: String(r.title), max: Number(r.max), months: r.months ?? null }));
  cache = { samples, version: n };
  return samples;
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 判断这一对该不该按同一职级归一（避免「专家」和「实习」直接平均） */
function sameLevel(a: string, b: string) {
  return levelOf(a) === levelOf(b);
}

export function estimateSalary(company: string, title: string): SalaryEstimate | null {
  const samples = loadSamples();
  if (!samples.length) return null;

  const co = normCompany(company);
  const keys = roleKeys(title);
  const level = levelOf(title);

  // ---- 1) 同公司 + 职位词重合 + 同职级 ----
  if (co && keys.length) {
    const hit = samples.filter((s) => s.company === co && sameLevel(s.title, title) && roleKeys(s.title).some((k) => keys.includes(k)));
    if (hit.length >= 2) {
      const max = median(hit.map((s) => s.max));
      const months = commonMonths(hit);
      return {
        max: round(max), min: round(max * 0.7), months,
        confidence: "high", basis: `${co} 同类岗位 ${hit.length} 条`, samples: hit.length,
      };
    }
  }

  // ---- 2) 同公司整体（按职级折算）----
  if (co) {
    const hit = samples.filter((s) => s.company === co);
    if (hit.length >= 2) {
      const base = median(hit.filter((s) => levelOf(s.title) === "中级").map((s) => s.max)) || median(hit.map((s) => s.max));
      const max = base * (LEVEL_FACTOR[level] ?? 1);
      return {
        max: round(max), min: round(max * 0.7), months: commonMonths(hit),
        confidence: "medium", basis: `${co} 整体 ${hit.length} 条 × ${level}系数`, samples: hit.length,
      };
    }
  }

  // ---- 3) 跨公司参考（同职能 + 同职级的中位数）----
  // 不再按「大厂」「热门方向」往上抬：那些都是拍脑袋的假设，估高了会把薪资不达标的岗位推给你。
  // 样本主要来自智联 / 猎聘的中小公司，对大厂偏保守——宁可低估，也不虚高。
  if (keys.length) {
    const hit = samples.filter((s) => roleKeys(s.title).some((k) => keys.includes(k)) && sameLevel(s.title, title));
    if (hit.length >= 3) {
      const max = median(hit.map((s) => s.max));
      return {
        max: round(max), min: round(max * 0.7), months: commonMonths(hit),
        confidence: hit.length >= 10 ? "medium" : "low",
        basis: `同类岗位 ${hit.length} 条的中位数`, samples: hit.length,
      };
    }

    // 3b) 同职级样本太少 → 放宽职级，用全部同类岗位的中位数按职级折算
    const anyLevel = samples.filter((s) => roleKeys(s.title).some((k) => keys.includes(k)));
    if (anyLevel.length >= 5) {
      const base = median(anyLevel.filter((s) => levelOf(s.title) === "中级").map((s) => s.max)) || median(anyLevel.map((s) => s.max));
      const max = base * (LEVEL_FACTOR[level] ?? 1);
      return {
        max: round(max), min: round(max * 0.7), months: commonMonths(anyLevel),
        confidence: "low", basis: `同类岗位 ${anyLevel.length} 条 × ${level}系数`, samples: anyLevel.length,
      };
    }
  }

  // ---- 4) 没有可参考的真实数据：不估（调用方按「薪资未公开、中性处理」）----
  return null;
}
function commonMonths(hit: Sample[]): number | null {
  const ms = hit.map((s) => s.months).filter((m): m is number => m != null && m > 0);
  if (!ms.length) return null;
  return Math.round(median(ms));
}

const round = (v: number) => Math.round(v * 10) / 10;

/** 估算值能拿到的薪资分比例：越不确定，给分越少 */
export const CONFIDENCE_FACTOR = { high: 0.9, medium: 0.75, low: 0.55 } as const;
