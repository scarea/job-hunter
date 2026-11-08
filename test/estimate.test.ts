import "./_setup.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, upsertJob } from "../src/db.ts";
import { estimateSalary, normCompany } from "../src/score/salary-estimate.ts";
import { scoreJob } from "../src/score/scorer.ts";

let n = 0;
const sample = (company: string, title: string, max: number) => upsertJob(
  { platform: "zhaopin", externalId: `e:${++n}`, title, company, salaryRaw: `${max - 10}-${max}K`, tags: [], url: "u" },
  { min: max - 10, max, months: null },
);

beforeEach(() => { db.exec("DELETE FROM jobs;"); });

test("没有任何真实薪资样本：不估（按未公开中性处理），不凭空编数字", () => {
  assert.equal(estimateSalary("字节跳动", "大模型推理平台工程师"), null);
});

test("同公司同类岗位：取真实样本中位数，置信度高", () => {
  sample("字节跳动", "推理平台后端开发", 40);
  sample("字节跳动", "推理服务后端开发", 50);
  sample("字节跳动", "推理加速后端", 60);
  const e = estimateSalary("字节跳动·火山引擎", "推理平台后端工程师")!;
  assert.equal(e.confidence, "high");
  assert.equal(e.max, 50);
});

test("跨公司：只用中位数，不再给大厂写死下限 / 乘系数", () => {
  for (const m of [20, 22, 24]) sample(`小公司${m}`, "后端开发", m);
  const e = estimateSalary("腾讯", "后端开发工程师")!;
  assert.equal(e.max, 22);
  assert.equal(e.confidence, "low");
});

test("公司名归一", () => {
  assert.equal(normCompany("深信服·研发体系"), "深信服");
  assert.equal(normCompany("深圳市某某科技有限公司"), "某某");
  assert.equal(normCompany("深信服科技股份有限公司"), "深信服");     // 招聘平台全称要能对上官网简称
  assert.equal(normCompany("字节跳动（深圳）有限公司"), "字节跳动");
});

test("没配 API key：只用规则分；没有 JD 的封顶 65（不会进推荐）", async () => {
  const r = await scoreJob({ title: "AI网关后端工程师", company: "某公司", salaryRaw: "40-60K", salaryMax: 60, salaryMonths: 15, city: "深圳", tags: [], jd: "" });
  assert.ok(r.total <= 65, `total=${r.total}`);
  assert.ok(!r.failed);
  assert.match(r.reason, /规则分/);
});
