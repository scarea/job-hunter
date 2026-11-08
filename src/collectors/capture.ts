import type { Page } from "playwright";
import type { Platform } from "../types.js";
import fs from "node:fs";
import path from "node:path";
import { findJobArray } from "./auto-json.js";
import { detectBlock, markBlocked } from "../platforms.js";

/**
 * 接口探测：用 headless 浏览器打开搜索页，旁听 XHR，
 * 找到真正返回岗位列表的那个接口，连同 cookie / headers 一起存下来。
 *
 * 之后就能用纯 HTTP 回放，不再需要浏览器。
 */
export interface CapturedRequest {
  platform: Platform;
  query: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  cookies: { name: string; value: string; domain: string }[];
  sampleCount: number;
  capturedAt: string;
}

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

const cachePath = (platform: Platform) => path.join(CACHE_DIR, `${platform}-api.json`);

export function loadCapture(platform: Platform): CapturedRequest | null {
  try {
    const p = cachePath(platform);
    if (!fs.existsSync(p)) return null;
    const c = JSON.parse(fs.readFileSync(p, "utf8")) as CapturedRequest;
    // 超过 12 小时视为过期
    if (Date.now() - new Date(c.capturedAt).getTime() > 12 * 3600_000) return null;
    return c;
  } catch { return null; }
}

export function saveCapture(c: CapturedRequest) {
  fs.writeFileSync(cachePath(c.platform), JSON.stringify(c, null, 2), "utf8");
}

const SEARCH_URL: Partial<Record<Platform, (q: string, page: number) => string>> = {
  boss: (q, p) => `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(q)}&city=101280600&page=${p}`,
  zhaopin: (q, p) => `https://www.zhaopin.com/jobs/?kw=${encodeURIComponent(q)}&jl=765&p=${p}`,
  liepin: (q, p) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(q)}&city=050020&curPage=${p - 1}`,
};

/** 打开搜索页，旁听网络，返回最可能的岗位接口 */
export async function captureApi(page: Page, platform: Platform, query: string): Promise<CapturedRequest | null> {
  const found: { url: string; method: string; headers: Record<string, string>; postData?: string; count: number }[] = [];

  const handler = async (res: any) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;

      const body = await res.text().catch(() => "");
      if (!body || body.length < 200) return;

      let json: any;
      try { json = JSON.parse(body); } catch { return; }

      const cand = findJobArray(json);
      if (!cand) return;

      found.push({
        url: res.url(),
        method: req.method(),
        headers: { ...(req.headers() as Record<string, string>) },
        postData: req.postData() || undefined,
        count: cand.items.length,
      });
    } catch { /* ignore */ }
  };

  const searchUrl = SEARCH_URL[platform];
  if (!searchUrl) return null;
  page.on("response", handler);
  try {
    await page.goto(searchUrl(query, 1), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    await page.evaluate("window.scrollBy(0, 600)").catch(() => {});
    await page.waitForTimeout(2500);
  } finally {
    page.off("response", handler);
  }

  // 被拦了就别存快照（存下来的是验证页的请求）
  const block = await detectBlock(page, platform);
  if (block) { markBlocked(platform, block); return null; }

  if (!found.length) return null;
  const best = found.sort((a, b) => b.count - a.count)[0];

  // 只取会随该接口请求发送的 cookie（按域名/路径过滤），不存整个浏览器的 cookie
  const ctxCookies = await page.context().cookies(best.url);
  const cookies = ctxCookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain }));

  const captured: CapturedRequest = {
    platform, query,
    url: best.url,
    method: best.method,
    headers: pickHeaders(best.headers),
    postData: best.postData,
    cookies,
    sampleCount: best.count,
    capturedAt: new Date().toISOString(),
  };
  saveCapture(captured);
  return captured;
}

/** 只保留回放需要的头，避免带上浏览器的临时指纹 */
function pickHeaders(h: Record<string, string>): Record<string, string> {
  const keep = ["user-agent", "accept", "accept-language", "content-type", "referer", "origin", "x-requested-with"];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (keep.includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}
