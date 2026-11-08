import "./_setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSalary } from "../src/score/salary.ts";
import { liepinId } from "../src/collectors/liepin.ts";
import { findJobArray, toRawJobs } from "../src/collectors/auto-json.ts";
import { parseApiPayload } from "../src/server/api-import.ts";
import { classifyApiRejection } from "../src/platforms.ts";
import { normTitle } from "../src/recommend.ts";

test("薪资解析：各平台写法", () => {
  const cases: [string, number | null, number | null, number | null][] = [
    ["30-50K·15薪", 30, 50, 15],
    ["25-50k", 25, 50, null],
    ["1.5-2.5万/月", 15, 25, null],
    ["200-300元/天", 4.4, 6.5, null],
    ["15001-30000", 15, 30, null],           // 智联接口：元/月
    ["20001-40000·14薪", 20, 40, 14],
    ["8000-12000元/月", 8, 12, null],
    ["30K以上", 30, 30, null],
    ["面议", null, null, null],
    ["0-0", null, null, null],
    ["", null, null, null],
  ];
  for (const [raw, min, max, months] of cases) {
    const s = parseSalary(raw);
    assert.deepEqual([s.salaryMin, s.salaryMax, s.months], [min, max, months], raw);
  }
});

test("猎聘 ID：直招 / 猎头代招 / 去掉追踪参数（防重复入库）", () => {
  assert.equal(liepinId("https://www.liepin.com/job/1977224135.shtml?d_sfrom=search"), "1977224135");
  assert.equal(liepinId("https://www.liepin.com/a/78400887.shtml?pgRef=xx"), "a78400887");
  assert.equal(liepinId("https://www.liepin.com/a/78400887.shtml?pgRef=yy"), "a78400887"); // 参数不同仍是同一个岗位
  assert.equal(liepinId("https://www.liepin.com/x/abc?y=1#z"), "https://www.liepin.com/x/abc");
});

test("智联接口：用接口自带的岗位链接（不自己拼 404 链接）、城市取 workCity、标签取 showSkillTags", () => {
  const resp = { data: { list: [
    { jobId: 40909980403, name: "AI Agent开发工程师", companyName: "某科技有限公司", salaryReal: "12001-20000",
      workCity: "深圳", cityDistrict: "福田", positionURL: "http://jobs.zhaopin.com/CCL1286707520J40909980403.htm",
      showSkillTags: [{ tag: "Python" }, { tag: "本科" }], workingExp: "1-3年" },
    { jobId: 2, name: "后端开发", companyName: "公司B", salaryReal: "20001-30000", workCity: "深圳", positionURL: "http://jobs.zhaopin.com/x.htm" },
    { jobId: 3, name: "测试开发", companyName: "公司C", salaryReal: "10001-15000", workCity: "深圳", positionURL: "http://jobs.zhaopin.com/y.htm" },
  ] } };
  const cand = findJobArray(resp);
  assert.ok(cand, "能找到岗位数组");
  const [j] = toRawJobs(cand!.items, "zhaopin", "Agent");
  assert.equal(j.externalId, "40909980403");
  assert.equal(j.url, "https://jobs.zhaopin.com/CCL1286707520J40909980403.htm");
  assert.equal(j.city, "深圳");
  assert.equal(j.district, "福田");
  assert.equal(j.salaryRaw, "12001-20000");
  assert.ok(j.tags.includes("Python") && j.tags.includes("1-3年"), `标签：${j.tags}`);
});

test("浏览即采集：BOSS 列表 → ID 用 encryptJobId、薪资取明文 salaryDesc、记录搜索词", () => {
  const r = parseApiPayload({
    platform: "boss", kind: "list", query: "AI网关",
    raw: { code: 0, zpData: { jobList: [
      { encryptJobId: "abc123", jobName: "AI网关工程师", salaryDesc: "30-50K·15薪", brandName: "测试公司", cityName: "深圳", areaDistrict: "南山区" },
      { encryptJobId: "def456", jobName: "Agent开发", salaryDesc: "25-40K", brandName: "公司2", cityName: "深圳" },
      { encryptJobId: "ghi789", jobName: "后端开发", salaryDesc: "20-30K", brandName: "公司3", cityName: "深圳" },
    ] } },
  });
  assert.equal(r.jobs.length, 3);
  const [j] = r.jobs;
  assert.equal(j.externalId, "abc123");
  assert.equal(j.salaryRaw, "30-50K·15薪");
  assert.equal(j.query, "AI网关");
  assert.equal(j.url, "https://www.zhipin.com/job_detail/abc123.html");
});

test("浏览即采集：详情页 JD（脚本从你打开的页面读到的）", () => {
  const ok = parseApiPayload({ platform: "liepin", kind: "detail-dom", raw: { externalId: "a123", jd: "岗位职责：".padEnd(60, "做事"), salaryRaw: "30-50k" } });
  assert.equal(ok.detailJob?.externalId, "a123");
  assert.equal(ok.detailJob?.platform, "liepin");
  const tooShort = parseApiPayload({ platform: "boss", kind: "detail-dom", raw: { externalId: "x", jd: "太短" } });
  assert.equal(tooShort.detailJob, undefined, "JD 太短（多半是没加载完）不入库");
});

test("浏览即采集：BOSS 详情接口", () => {
  const r = parseApiPayload({ platform: "boss", kind: "detail", raw: { zpData: { jobInfo: { encryptJobId: "abc123", postDescription: "负责模型网关", salaryDesc: "30-50K" } } } });
  assert.deepEqual(r.detailJob, { externalId: "abc123", platform: "boss", jd: "负责模型网关", salaryRaw: "30-50K" });
});

test("接口拒绝分类：BOSS 风控码 / 登录", () => {
  assert.equal(classifyApiRejection("您的IP地址存在异常行为.", 35), "need_verify");
  assert.equal(classifyApiRejection("您的访问行为异常", 37), "need_verify");
  assert.equal(classifyApiRejection("请登录后查看", 1), "need_login");
  assert.equal(classifyApiRejection("成功", 0), null);
});

test("同岗去重：去掉括号里的城市 / 批次", () => {
  assert.equal(normTitle("AI 网关研发工程师 - 网络（北京/深圳）"), normTitle("AI网关研发工程师-网络(深圳)"));
  assert.notEqual(normTitle("后端开发"), normTitle("前端开发"));
});
