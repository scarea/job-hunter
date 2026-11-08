import "./_setup.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, upsertJob, saveScore } from "../src/db.ts";
import { SCORING_VERSION } from "../src/config.ts";
import { seedQueries, addQuery, setQueryState, selectQueries, recordHit, scoreQueries, reviewStrategy, listQueries } from "../src/strategy.ts";

beforeEach(() => { db.exec("DELETE FROM search_queries; DELETE FROM query_hits; DELETE FROM strategy_log; DELETE FROM scores; DELETE FROM jobs;"); });

let n = 0;
function hit(runKey: string, kw: string, total: number) {
  const { id } = upsertJob(
    { platform: "zhaopin", externalId: `s:${++n}`, title: `岗位${n}`, company: "c", salaryRaw: "", tags: [], url: "u" },
    { min: null, max: null, months: null },
  );
  saveScore(id, SCORING_VERSION, "test", { total, dims: { tech: 0, salary: 0, weekend: 0, company: 0, growth: 0 }, verdict: "可投", reason: "" });
  recordHit(runKey, kw, "zhaopin", id, true);
}

test("种子词去重（大小写 / 空格不同算同一个）", () => {
  seedQueries(["AI Agent", "ai  agent", "推理服务"]);
  assert.equal(listQueries().length, 2);
});

test("选词：钉住的必跑、保留探索名额给新词、其余按收益", () => {
  seedQueries(["好词", "差词", "钉住的词"]);
  for (let i = 0; i < 3; i++) {
    const rk = `2026-11-0${i + 1}T04:00`;
    hit(rk, "好词", 80); hit(rk, "好词", 75);
    hit(rk, "差词", 30);
    hit(rk, "钉住的词", 20);
  }
  setQueryState("钉住的词", { pinned: true });
  addQuery("新词", "ai", "测试");
  const plan = selectQueries(3).map((p) => p.keyword);
  assert.ok(plan.includes("钉住的词"), "钉住的必跑");
  assert.ok(plan.includes("新词"), "新词进探索名额");
  assert.equal(plan.length, 3);
  const sc = scoreQueries();
  assert.ok(sc.get("好词")!.mean > sc.get("差词")!.mean);
});

test("复盘护栏（无 API key 时只做规则调整）：种子词不会被淘汰；跑够 2 轮且收益达标的候选词转正", async () => {
  seedQueries(["种子"]);
  addQuery("候选", "ai", "测试");
  for (let i = 0; i < 2; i++) { hit(`2026-11-0${i + 1}T04:00`, "候选", 80); hit(`2026-11-0${i + 1}T04:00`, "种子", 10); }
  const r = await reviewStrategy("2026-11-03T04:00", () => {});
  assert.ok(r.promoted.includes("候选"));
  assert.equal(listQueries().find((q) => q.keyword === "种子")!.status, "active");
});
