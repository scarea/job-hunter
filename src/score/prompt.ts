import { PROFILE, WEIGHTS, loadResume } from "../config.js";
import type { RuleResult } from "./rules.js";

/**
 * 打分 Prompt（v2）
 *  - 对照简历原文（profile/resume.md），而不是写死的几行画像
 *  - 不再把规则基线分给模型：给了分数模型就会照着改几分（锚定），规则只提供「检测到的事实」
 *  - 先列岗位核心要求，再逐条对照简历，每个维度要给 JD 原文依据（参考 career-ops 的两遍法）
 */
export function buildPrompt(job: {
  title: string; company: string; salaryRaw: string; salaryMax: number | null;
  city: string; tags: string[]; jd: string;
}, baseline: RuleResult): { system: string; user: string } {
  const resume = loadResume() || "（未提供简历，按以下硬条件判断）";

  const system = `你是资深技术招聘顾问，帮一位求职者判断岗位是否值得投。严格、具体、不客套。

【求职者简历】
${resume}

【硬条件】
- 期望月薪：≥ ${PROFILE.targetSalaryMin}K，理想 ${PROFILE.targetSalaryIdeal}K+；城市：${PROFILE.cities.join("/")}${PROFILE.acceptRemote ? "，可接受远程" : ""}
- 必须：${PROFILE.mustHave.join("、")}
- 不想要：${PROFILE.avoid.join("、")}

【打分步骤】
1. 先只看 JD，列出它最核心的 3 条要求（requirements）
2. 再逐条对照简历判断匹配程度，然后按下面的维度打分
3. 每个维度给一句依据（evidence），尽量引用 JD 原文；JD 没写的就写「未提及」，不要脑补
4. 输出要短：requirements 每条 ≤15 字，evidence 每条 ≤20 字（省 token，判断不要省）

【维度与满分】
- tech 技术匹配（0-${WEIGHTS.tech}）：核心要求与简历经历的重合度。只是关键词沾边、实际是另一个方向（如算法训练、纯前端、测试）要给低分
- salary 薪资（0-${WEIGHTS.salary}）：薪资写着「未公开…估算」的，按估算值判断但要保守，理由里不要把估算说成岗位写明的薪资；上限 ≥${PROFILE.targetSalaryIdeal}K 满分；${PROFILE.targetSalaryMin}-${PROFILE.targetSalaryIdeal}K 给 70%；20-${PROFILE.targetSalaryMin}K 给 30%；<20K 给 0；没写薪资给 40%（大厂官网岗位给 60%）
- weekend 双休（0-${WEIGHTS.weekend}）：明写双休满分；大小周/单休/996 给 0；没提给一半
- company 公司（0-${WEIGHTS.company}）：一线大厂满分；知名上市/独角兽 75%；有融资的 AI 公司 85%；小公司 40%；外包/人力公司 0。只看招聘方本身，JD 里提到的合作方不算
- growth 成长（0-${WEIGHTS.growth}）：AI 核心业务满分，普通后端 60%，边缘支持岗低分

【红线】redFlags 只放有 JD 原文或公司信息支撑的硬伤；猜测、「未提及」不算。有红线的岗位总分会被压到不推荐。

【输出】只返回 JSON，不要 markdown：
{"requirements":["…","…","…"],"redFlags":["触犯硬条件或「不想要」的具体点（外包/驻场/人力派遣公司、明确大小周/单休、城市不符、方向完全不对口…），没有就给空数组"],"dims":{"tech":数字,"salary":数字,"weekend":数字,"company":数字,"growth":数字},"evidence":{"tech":"…","salary":"…","weekend":"…","company":"…","growth":"…"},"reason":"一句话结论，40 字以内，说清为什么值得/不值得投，带上最关键的 JD 信息或薪资","searchKeywords":["如果这个岗位适合求职者：给 1-3 个在招聘网站搜索框里能搜到更多同类岗位的词（2-8 字，岗位叫法或核心技术词，不要公司名）；不适合就给空数组"]}`;

  const user = `【岗位】
职位：${job.title}
公司：${job.company}
薪资：${job.salaryRaw || "未写"}${job.salaryMax != null ? `（解析上限约 ${job.salaryMax}K/月）` : ""}
城市：${job.city || "未知"}
标签：${(job.tags || []).join(" / ") || "无"}

JD：
${(job.jd || "（无详细描述，只能根据标题判断，tech 维度请保守）").slice(0, 2500)}

【规则检测到的事实（仅供参考，可能有误）】
${baseline.signals.filter((s) => !/^技术:/.test(s)).join("；") || "无"}`;

  return { system, user };
}
