import type { Platform, RawJob } from "../types.js";
import type { Page } from "playwright";
import { loadCapture, captureApi } from "./capture.js";
import { replayCollect } from "./api.js";
import { COLLECTORS } from "./index.js";

/**
 * 按平台选采集方式（依据开源项目的实测经验）：
 *   tencent  公开 JSON 接口，直接请求
 *   zhaopin  接口回放（快照 12h 内）→ 浏览器探一次接口 → DOM 兜底；智联回放实测稳定
 *   boss     只被动监听页面自己的请求：主动回放会触发 code 37「环境异常」
 *   liepin   读 DOM（慢节奏）：连续请求很快触发短信验证
 */
type Via = "api" | "api-fresh" | "passive" | "dom" | "none";
const STRATEGY: Record<Platform, "public-api" | "replay" | "passive" | "dom"> = {
  tencent: "public-api",
  official: "public-api",
  zhaopin: "replay",
  boss: "passive",
  liepin: "dom",
};

export async function collectHybrid(
  platform: Platform,
  query: string,
  opts: { maxPages: number; page: Page }
): Promise<{ jobs: RawJob[]; via: Via; note?: string }> {
  const strategy = STRATEGY[platform];

  if (strategy === "replay") {
    const cached = loadCapture(platform);
    if (cached) {
      const r = await replayCollect(cached, platform, query, opts.maxPages);
      if (r.blocked) return { jobs: [], via: "none", note: r.error };
      if (!r.error && r.jobs.length) return { jobs: r.jobs, via: "api" };
      if (r.error) console.log(`  ↩️ 接口回放失败（${r.error}），尝试重新捕获`);
    }
    try {
      const cap = await captureApi(opts.page, platform, query);
      if (cap) {
        console.log(`  🔍 捕获接口：${new URL(cap.url).pathname}（样本 ${cap.sampleCount} 条）`);
        const r = await replayCollect(cap, platform, query, opts.maxPages);
        if (r.blocked) return { jobs: [], via: "none", note: r.error };
        if (!r.error && r.jobs.length) return { jobs: r.jobs, via: "api-fresh" };
      }
    } catch (e: any) {
      console.log(`  ⚠️ 接口捕获失败：${e.message}`);
    }
  }

  try {
    const jobs = await COLLECTORS[platform].collect(query, opts);
    const via: Via = strategy === "passive" ? "passive" : strategy === "public-api" ? "api" : "dom";
    return jobs.length ? { jobs, via } : { jobs: [], via: "none", note: "未取到数据" };
  } catch (e: any) {
    return { jobs: [], via: "none", note: e.message };
  }
}
