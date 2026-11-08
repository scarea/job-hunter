import "./_setup.ts";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { feishuSource } from "../src/collectors/official/feishu.ts";
import { meituan } from "../src/collectors/official/meituan.ts";
import { alibaba } from "../src/collectors/official/alibaba.ts";
import { tencentCollector } from "../src/collectors/tencent.ts";
import { toRaw } from "../src/collectors/official/types.ts";

/** 用模拟响应代替真实网络：测字段映射，不请求任何网站 */
const realFetch = globalThis.fetch;
const calls: { url: string; init: any }[] = [];
function mockFetch(body: unknown) {
  calls.length = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

test("飞书招聘（字节 / 小米 / 影石…）：深圳 CT_128、社招、JD 拼职责 + 要求、外部 ID 带公司前缀", async () => {
  mockFetch({ code: 0, data: { count: 1, job_post_list: [{
    id: "7447", title: "大模型推理平台-火山引擎", city_list: [{ name: "深圳" }, { name: "北京" }],
    description: "负责推理平台", requirement: "熟悉 vLLM", job_category: { name: "研发" }, publish_time: 1733899224738,
  }] } });
  const src = feishuSource({ id: "bytedance", company: "字节跳动", host: "jobs.bytedance.com", portalType: 2, detailUrl: (id) => `https://jobs.bytedance.com/experienced/position/${id}/detail` });
  const { jobs, total } = await src.search("大模型", 1);
  assert.equal(total, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.location_code_list, ["CT_128"]);
  assert.equal(calls[0].init.headers["website-path"], undefined, "字节不能带 website-path（会报 site not exist）");
  const raw = toRaw(src, jobs[0], "大模型");
  assert.equal(raw.platform, "official");
  assert.equal(raw.externalId, "bytedance:7447");
  assert.equal(raw.city, "深圳/北京");
  assert.equal(raw.company, "字节跳动·大模型推理平台");
  assert.match(raw.jd!, /【职责】[\s\S]*负责推理平台[\s\S]*【要求】[\s\S]*熟悉 vLLM/);
});

test("飞书招聘：接口返回错误码时报错（单家公司失败只跳过这家）", async () => {
  mockFetch({ code: -9000003, message: "site not exist" });
  const src = feishuSource({ id: "x", company: "X", host: "x.jobs.feishu.cn", portalType: 2, detailUrl: (id) => id });
  await assert.rejects(src.search("AI", 1), /site not exist/);
});

test("美团：社招 + 深圳城市码、status==1 才算成功", async () => {
  mockFetch({ status: 1, data: { page: { totalCount: 1 }, list: [{
    jobUnionId: "2486", name: "AI Builder", cityList: [{ name: "深圳市" }], department: [{ name: "核心本地商业" }],
    jobDuty: "做平台", jobRequirement: "会 Go", refreshTime: 1746777600000,
  }] } });
  const { jobs } = await meituan.search("AI", 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.cityList[0].code, "001019002");
  assert.equal(body.jobType[0].code, "3");
  assert.equal(jobs[0].dept, "核心本地商业");
  assert.match(jobs[0].url, /jobUnionId=2486/);
});

test("阿里：XSRF 双提交（cookie 和请求头是同一个值）、深圳 440300", async () => {
  mockFetch({ content: { totalCount: 1, datas: [{ id: 1000, name: "阿里云智能-AI Infra-深圳", workLocations: ["深圳"], description: "职责", requirement: "要求" }] } });
  const { jobs } = await alibaba.search("AI", 1);
  const h = calls[0].init.headers;
  assert.equal(h.cookie, `XSRF-TOKEN=${h["x-xsrf-token"]}`);
  assert.equal(JSON.parse(calls[0].init.body).regions, "440300");
  assert.equal(jobs[0].dept, "阿里云智能");
});

test("腾讯：只要深圳（cityId=1）、过滤已失效岗位", async () => {
  mockFetch({ Data: { Count: 2, Posts: [
    { PostId: "1", RecruitPostName: "AI后台开发", LocationName: "深圳", BGName: "TEG", CategoryName: "技术", IsValid: "True" },
    { PostId: "2", RecruitPostName: "已下线岗位", LocationName: "深圳", IsValid: "False" },
  ] } });
  const jobs = await tencentCollector.collect("AI", { maxPages: 1, page: null as any });
  assert.match(calls[0].url, /cityId=1/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, "腾讯·TEG");
  assert.equal(jobs[0].url, "https://careers.tencent.com/jobdesc.html?postId=1");
});
