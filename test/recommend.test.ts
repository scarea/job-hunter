import "./_setup.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, upsertJob, saveScore, setJobStatus } from "../src/db.ts";
import { SCORING_VERSION } from "../src/config.ts";
import { rebuildRecommendations, topUpRecommendations, recommendationsOn, backlog } from "../src/recommend.ts";
import { createTag } from "../src/tags.ts";
import type { ScoreResult } from "../src/types.ts";

const DATE = "2026-11-08";
let n = 0;
function addJob(o: { title: string; company: string; total: number; version?: string; jd?: string }) {
  const { id } = upsertJob(
    { platform: "official", externalId: `t:${++n}`, title: o.title, company: o.company, salaryRaw: "", city: "深圳", tags: [], jd: o.jd ?? "职责".padEnd(100, "x"), url: `https://x/${n}` },
    { min: null, max: null, months: null },
  );
  const r: ScoreResult = { total: o.total, dims: { tech: 0, salary: 0, weekend: 0, company: 0, growth: 0 }, verdict: "可投", reason: "测试" };
  saveScore(id, o.version ?? SCORING_VERSION, "test", r);
  return id;
}

beforeEach(() => { db.exec("DELETE FROM scores; DELETE FROM jobs; DELETE FROM tags;"); });

test("只推当前打分版本 ≥ 门槛 的新岗位", () => {
  addJob({ title: "A", company: "甲", total: 80 });
  addJob({ title: "B", company: "乙", total: 60 });                        // 低于门槛 68
  addJob({ title: "C", company: "丙", total: 90, version: "v-old" });      // 旧版本的高分不算
  const ignored = addJob({ title: "D", company: "丁", total: 85 });
  setJobStatus(ignored, "ignored");                                         // 不感兴趣的不推
  rebuildRecommendations(DATE);
  assert.deepEqual(recommendationsOn(DATE).rows.map((r: any) => r.title), ["A"]);
});

test("同公司每天最多 5 个（「腾讯·CSIG」「腾讯·IEG」算一家）；同名岗位只推一个", () => {
  for (let i = 0; i < 7; i++) addJob({ title: `后端${i}`, company: i % 2 ? "腾讯·CSIG" : "腾讯·IEG", total: 90 - i });
  addJob({ title: "AI 网关（北京/深圳）", company: "字节跳动", total: 88 });
  addJob({ title: "AI网关(深圳)", company: "字节跳动", total: 87 });
  rebuildRecommendations(DATE);
  const rows = recommendationsOn(DATE).rows as any[];
  assert.equal(rows.filter((r) => r.company.startsWith("腾讯")).length, 5);
  assert.equal(rows.filter((r) => r.company === "字节跳动").length, 1);
});

test("推荐过没处理的进「待处理」，第二天不再作为新推荐", () => {
  addJob({ title: "A", company: "甲", total: 80 });
  rebuildRecommendations("2026-11-07");
  const r = rebuildRecommendations(DATE);
  assert.equal(r.added, 0);
  assert.equal(backlog(DATE).rows.length, 1);
});

test("追加推荐：不动已有推荐，只补新的够格岗位", () => {
  addJob({ title: "A", company: "甲", total: 80 });
  rebuildRecommendations(DATE);
  addJob({ title: "B", company: "乙", total: 75 });
  const { added } = topUpRecommendations(DATE);
  assert.equal(added, 1);
  assert.deepEqual((recommendationsOn(DATE).rows as any[]).map((r) => r.title).sort(), ["A", "B"]);
});

test("标签：「不看」排除、「仅看」只留命中的、「不看」优先", () => {
  addJob({ title: "Java 后端", company: "甲", total: 90 });
  addJob({ title: "Agent 平台开发", company: "乙", total: 85 });
  addJob({ title: "Agent Java 开发", company: "丙", total: 80 });
  createTag({ name: "Java", mode: "exclude" });
  rebuildRecommendations(DATE);
  assert.deepEqual((recommendationsOn(DATE).rows as any[]).map((r) => r.title), ["Agent 平台开发"]);

  createTag({ name: "Agent", mode: "only" });
  db.exec("UPDATE jobs SET recommended_on = NULL");
  rebuildRecommendations(DATE);
  assert.deepEqual((recommendationsOn(DATE).rows as any[]).map((r) => r.title), ["Agent 平台开发"]); // 「Agent Java」被「不看」压过
});
