import { REJECT_RULES, TECH_KEYWORDS, WEEKEND_SIGNALS, COMPANY_TIERS, WEIGHTS, PROFILE } from "../config.js";
import type { ScoreDims } from "../types.js";

export interface RuleInput {
  title: string;
  company: string;
  jd: string;
  tags: string[];
  salaryMax: number | null;
  salaryMonths: number | null;
  city?: string;
  /** salaryMax 是估算值（官网不公开薪资时用真实样本推出来的），不是岗位写明的 */
  salaryEstimated?: boolean;
}

export interface RuleResult {
  reject?: { id: string; label: string };
  /** 规则给出的基线分（0-100），LLM 可在此基础上微调 */
  dims: ScoreDims;
  total: number;
  signals: string[];
}

/** 本地硬规则 → 先算一版确定性分数，再用 LLM 修正。这样 LLM 挂了也有分可用。 */
export function applyRules(j: RuleInput): RuleResult {
  // 去掉「非外包 / 不接受驻场」这类否定说法，免得被当成命中
  const hay = `${j.title} ${j.company} ${j.jd} ${(j.tags || []).join(" ")}`
    .replace(/(非|不是|无|拒绝|不接受|不招|并非)\s*(外包|驻场|外派)/g, "");
  const low = hay.toLowerCase();
  const signals: string[] = [];

  // 1) 一票否决
  for (const r of REJECT_RULES) {
    if (r.test({ title: j.title, company: j.company, jd: j.jd, tags: j.tags, city: j.city })) {
      return { reject: { id: r.id, label: r.label }, dims: zeroDims(), total: 0, signals: [`否决:${r.label}`] };
    }
  }

  // 2) 技术匹配（30）
  let techHits = 0;
  for (const k of TECH_KEYWORDS.high) if (hasKeyword(low, k)) { techHits += 3; signals.push(`技术+${k}`); }
  for (const k of TECH_KEYWORDS.mid) if (hasKeyword(low, k)) { techHits += 1; }
  for (const k of TECH_KEYWORDS.low) if (hasKeyword(low, k)) { techHits += 0.3; }
  const tech = clamp(techHits, 0, WEIGHTS.tech);
  if (techHits === 0) signals.push("技术:无命中关键词");

  // 3) 薪资（25）
  let salary = 0;
  if (j.salaryMax != null) {
    if (j.salaryMax >= PROFILE.targetSalaryIdeal) salary = WEIGHTS.salary;
    else if (j.salaryMax >= PROFILE.targetSalaryMin) salary = WEIGHTS.salary * 0.7;
    else if (j.salaryMax >= 20) salary = WEIGHTS.salary * 0.3;
    else salary = 0;
    signals.push(j.salaryEstimated ? `薪资未公开（估算上限约${j.salaryMax}K，仅供参考）` : `薪资上限${j.salaryMax}K`);
  } else {
    salary = WEIGHTS.salary * 0.4; // 面议给中性分
    signals.push("薪资面议");
  }
  // 薪数加成
  if (j.salaryMonths && j.salaryMonths >= 15) { salary = Math.min(WEIGHTS.salary, salary + 2); signals.push(`${j.salaryMonths}薪`); }

  // 4) 双休（20）
  let weekend = WEIGHTS.weekend * 0.5; // 默认中性
  const pos = WEEKEND_SIGNALS.positive.filter((k) => hay.includes(k));
  const neg = WEEKEND_SIGNALS.negative.filter((k) => hay.includes(k));
  // 「双休，项目期偶尔大小周」这种：负面信号优先，宁可保守
  if (neg.length) { weekend = 0; signals.push(`加班信号:${neg.join("/")}`); }
  else if (pos.length) { weekend = WEIGHTS.weekend; signals.push(`双休信号:${pos.join("/")}`); }
  else signals.push("双休:未标注");

  // 5) 公司质量（15）
  //  ⚠️ 以前未知公司只给 0.4（6 分），比大厂低 9 分 —— 这等于系统性歧视
  //     「小而有钱、正在上升期」的公司。实际上这类公司常常比大厂更舍得给钱。
  //  现在改为：未知公司 0.6（9 分），并额外奖励「开得起高薪」「有融资/上市信号」。
  let company = WEIGHTS.company * 0.6;
  // 只看公司名：JD 里写「对接阿里云 / 熟悉百度千帆」不代表是大厂
  for (const name of COMPANY_TIERS.s) if (j.company.includes(name)) { company = WEIGHTS.company; signals.push(`S级:${name}`); break; }
  if (company < WEIGHTS.company) for (const name of COMPANY_TIERS.a) if (j.company.includes(name)) { company = WEIGHTS.company * 0.85; signals.push(`A级:${name}`); break; }
  if (company < WEIGHTS.company * 0.6) for (const name of COMPANY_TIERS.b) if (j.company.includes(name)) { company = WEIGHTS.company * 0.9; signals.push(`B级:${name}`); break; }

  // 成长型信号（不看公司名，看「有没有钱 / 缺不缺人」）
  // 开得起 30K+ 的公司不会是作坊；有融资/上市信号的说明在上升期
  // 只认岗位写明的薪资：估算值本身就来自「大厂多半给得起」这类假设，再拿它加分就重复计算了
  if (!j.salaryEstimated && (j.salaryMax ?? 0) >= 30) { company += 2; signals.push("薪资≥30K(有钱)"); }
  // 「轮」要带上融资语境，否则「轮岗」「一轮面试」「轮班」都会命中
  if (/[A-F]\+?\s*轮|天使轮|种子轮|Pre-?[A-F]|战略融资|完成.{0,6}融资|已上市|上市公司|独角兽|IPO/i.test(hay)) { company += 2; signals.push("融资/上市信号"); }
  company = Math.min(company, WEIGHTS.company);

  // 6) 成长性（10）
  let growth = WEIGHTS.growth * 0.5;
  if (/AI|大模型|LLM|Agent|推理|平台/.test(j.title)) growth = WEIGHTS.growth;
  else if (/后端|服务端|开发/.test(j.title)) growth = WEIGHTS.growth * 0.6;
  const avoid = PROFILE.avoid.find((a) => hay.includes(a));
  if (avoid) { growth = Math.max(0, growth - 4); signals.push(`规避项:${avoid}`); }

  const dims: ScoreDims = {
    tech: round1(tech), salary: round1(salary), weekend: round1(weekend),
    company: round1(company), growth: round1(growth),
  };
  return { dims, total: round1(dims.tech + dims.salary + dims.weekend + dims.company + dims.growth), signals };
}

/**
 * 关键词匹配：英文短词按单词边界匹配（避免 "Go" 命中 Google / MongoDB），中文按子串
 */
function hasKeyword(lowHay: string, k: string): boolean {
  const kl = k.toLowerCase();
  if (/^[a-z0-9.+#\s-]+$/i.test(k)) {
    const esc = kl.replace(/[.+#-]/g, (c) => "\\" + c);
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(lowHay);
  }
  return lowHay.includes(kl);
}

function zeroDims(): ScoreDims {
  return { tech: 0, salary: 0, weekend: 0, company: 0, growth: 0 };
}
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function round1(v: number) { return Math.round(v * 10) / 10; }
