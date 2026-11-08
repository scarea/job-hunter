import "./_setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRules, type RuleInput } from "../src/score/rules.ts";

const job = (p: Partial<RuleInput>): RuleInput => ({
  title: "AI 后端工程师", company: "某科技", jd: "", tags: [], salaryMax: 30, salaryMonths: null, city: "深圳", ...p,
});
const rejectOf = (p: Partial<RuleInput>) => applyRules(job(p)).reject?.id ?? null;

test("一票否决：外包公司名、JD 写明外包驻场", () => {
  assert.equal(rejectOf({ company: "外企德科数字技术有限公司" }), "outsource");
  assert.equal(rejectOf({ company: "深圳市某某人力资源服务有限公司" }), "outsource");
  assert.equal(rejectOf({ jd: "本岗位为驻场开发，派驻甲方现场" }), "outsource");
});

test("不误杀：「非外包」「不接受外包」这类否定说法；名字里碰巧带「德科」「中智」的公司", () => {
  assert.equal(rejectOf({ jd: "本岗位非外包，自研团队" }), null);
  assert.equal(rejectOf({ jd: "不接受外包，正式编制" }), null);
  assert.equal(rejectOf({ company: "深圳华德科技有限公司" }), null);
  assert.equal(rejectOf({ company: "中智行科技" }), null);
});

test("一票否决：销售 / 产品运营 / 标注 / 实习", () => {
  assert.equal(rejectOf({ title: "大客户销售经理" }), "sales");
  assert.equal(rejectOf({ title: "AI 产品经理" }), "pm");
  assert.equal(rejectOf({ title: "数据标注员" }), "labeling");
  assert.equal(rejectOf({ title: "后端开发实习生" }), "intern");
});

test("城市：标题写外地 → 否决；多城市含深圳 / 远程 → 保留；城市字段是默认值时以标题为准", () => {
  assert.equal(rejectOf({ title: "AI网关研发工程师-杭州", city: "深圳" }), "city");
  assert.equal(rejectOf({ title: "AI 网关研发工程师 - 网络（北京）" }), "city");
  assert.equal(rejectOf({ title: "TIONE-AI智能网关（上海/杭州/深圳）" }), null);
  assert.equal(rejectOf({ title: "远程 AI 应用开发（北京）" }), null);
  assert.equal(rejectOf({ title: "AI 应用开发", city: "北京" }), "city");
  assert.equal(rejectOf({ title: "AI 应用开发", city: "" }), null);
});

test("关键词：英文短词按单词边界匹配（Go 不命中 Google / MongoDB）", () => {
  const goJob = applyRules(job({ title: "后端", jd: "熟悉 Go 语言" })).dims.tech;
  const googleJob = applyRules(job({ title: "后端", jd: "熟悉 Google 和 MongoDB" })).dims.tech;
  assert.ok(goJob > googleJob, `Go=${goJob} Google=${googleJob}`);
});

test("公司档次只看公司名：JD 里提到阿里云 / 百度不算大厂", () => {
  const small = applyRules(job({ company: "某小公司", jd: "对接阿里云和百度千帆" }));
  assert.ok(!small.signals.some((s) => s.startsWith("S级")), small.signals.join(","));
  const big = applyRules(job({ company: "腾讯科技（深圳）有限公司" }));
  assert.ok(big.signals.some((s) => s.startsWith("S级")));
});

test("双休：同时出现「双休」和「大小周」时按负面算", () => {
  const r = applyRules(job({ jd: "双休，项目期偶尔大小周" }));
  assert.equal(r.dims.weekend, 0);
});

test("融资信号：要在融资语境里，「轮岗」「一轮面试」不算", () => {
  assert.ok(!applyRules(job({ jd: "入职后轮岗，一轮面试" })).signals.includes("融资/上市信号"));
  assert.ok(applyRules(job({ jd: "公司已完成 B 轮融资" })).signals.includes("融资/上市信号"));
});

test("估算薪资：不触发「开得起高薪」加分，信号里标明是估算", () => {
  const est = applyRules(job({ salaryMax: 40, salaryEstimated: true }));
  assert.ok(!est.signals.includes("薪资≥30K(有钱)"));
  assert.ok(est.signals.some((s) => s.includes("估算")));
  const real = applyRules(job({ salaryMax: 40 }));
  assert.ok(real.signals.includes("薪资≥30K(有钱)"));
});
