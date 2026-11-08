/** 仅用于冒烟测试：写入几条模拟岗位，验证 DB → 打分 → 报告 → 看板 全链路 */
import "dotenv/config";
import { upsertJob, saveScore } from "../db.js";
import { parseSalary } from "../score/salary.js";
import { scoreJob, SCORING_VERSION } from "../score/scorer.js";

const MOCK = [
  { platform: "boss" as const, externalId: "m1", title: "AI Infra 工程师（偏 MaaS 开发）", company: "深信服", salaryRaw: "40-70K·16薪", city: "深圳", tags: ["3-5年", "本科"], jd: "负责 MaaS 平台建设，模型接入、推理服务、网关、Provider 适配、分流调度，熟悉 vLLM/SGLang 优先", url: "https://example.com/1" },
  { platform: "boss" as const, externalId: "m2", title: "大模型推理工程师", company: "元象科技", salaryRaw: "30-50K·15薪", city: "深圳", tags: ["3-5年"], jd: "模型推理优化，量化，Temporal 编排，推理平台建设", url: "https://example.com/2" },
  { platform: "zhaopin" as const, externalId: "m3", title: "AI 协作工具-全栈开发", company: "腾讯", salaryRaw: "25-50K·14薪", city: "深圳", tags: ["双休", "3-5年"], jd: "AI 应用开发，Node.js + React，双休，不加班", url: "https://example.com/3" },
  { platform: "liepin" as const, externalId: "m4", title: "AI 数据标注工程师", company: "某数据公司", salaryRaw: "8-12K", city: "深圳", tags: [], jd: "数据标注、审核", url: "https://example.com/4" },
  { platform: "liepin" as const, externalId: "m5", title: "后端开发（外包驻场）", company: "中软国际", salaryRaw: "20-30K", city: "深圳", tags: [], jd: "外包驻场，甲方现场", url: "https://example.com/5" },
];

async function main() {
  for (const m of MOCK) {
    const sal = parseSalary(m.salaryRaw);
    const { id } = upsertJob(m, { min: sal.salaryMin, max: sal.salaryMax, months: sal.months });
    const result = await scoreJob({
      title: m.title, company: m.company, salaryRaw: m.salaryRaw,
      salaryMax: sal.salaryMax, salaryMonths: sal.months,
      city: m.city, tags: m.tags, jd: m.jd,
    });
    if (!result.failed) saveScore(id, SCORING_VERSION, "seed", result);
    console.log(`${result.total.toFixed(1).padStart(5)}  ${m.title}  ← ${result.reason}`);
  }
}
main();
