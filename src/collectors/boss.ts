import type { Collector, RawJob } from "../types.js";
import type { Page, Response } from "playwright";
import { humanScroll, pace, sleep } from "./base.js";
import { findJobArray, toRawJobs } from "./auto-json.js";
import { detectBlock, markBlocked, classifyApiRejection } from "../platforms.js";

/**
 * BOSS 直聘：被动监听
 *
 * 只打开真实搜索页、像人一样滚动，旁听页面自己发出的 /wapi/zpgeek/search/joblist.json。
 * 不自己发请求、不回放接口：开源项目实测（eatmoreduck/boss-zhipin-scraper#53）
 * 程序发起的请求会被判「环境异常」(code 37)，页面自己发的正常。
 * 接口里的 salaryDesc 是明文，不用解字体。
 */
const CITY_CODE = "101280600"; // 深圳
const JOBLIST = /\/wapi\/zpgeek\/search\/joblist\.json/;

export const bossCollector: Collector = {
  platform: "boss",
  async collect(query: string, { maxPages, page }: { maxPages: number; page: Page }): Promise<RawJob[]> {
    const bodies: any[] = [];
    let rejected: { message: string; code: unknown } | null = null;

    let verifyUrl = "";
    const onResponse = async (res: Response) => {
      const url = res.url();
      if (/\/web\/passport\/zp\/verify/.test(url)) verifyUrl ||= url; // 被重定向到验证页
      if (!/zhipin\.com\/wapi\//.test(url)) return;
      try {
        const j = await res.json();
        if (JOBLIST.test(url) && j?.code === 0) bodies.push(j);
        // 任何接口返回风控码（35 IP 异常 / 37 环境异常）都算被拦，不只是岗位列表接口
        else if ((JOBLIST.test(url) && j?.code !== 0) || [35, 36, 37].includes(j?.code)) {
          rejected ??= { message: String(j?.message ?? ""), code: j?.code };
        }
      } catch { /* 非 JSON */ }
    };

    const out: RawJob[] = [];
    const seen = new Set<string>();
    page.on("response", onResponse);
    try {
      await page.goto(`https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${CITY_CODE}`, { waitUntil: "domcontentloaded" });

      for (let p = 1; p <= maxPages; p++) {
        // 等这一页的接口响应（第 2 页起靠滚动触发）
        const deadline = Date.now() + 15_000;
        while (bodies.length < p && !rejected && Date.now() < deadline) {
          await sleep(500);
          if (p > 1 && Date.now() > deadline - 8_000) await humanScroll(page, 2); // 滚一次没触发就再滚
        }

        const block = await detectBlock(page, "boss");
        if (block) { markBlocked("boss", block); break; }
        if (verifyUrl && !rejected) { markBlocked("boss", { kind: "need_verify", reason: "被重定向到验证页", url: verifyUrl }); break; }
        if (rejected) {
          const { message, code } = rejected as { message: string; code: unknown };
          const kind = classifyApiRejection(message, code);
          const at = verifyUrl || (/^https?:/.test(page.url()) ? page.url() : "https://www.zhipin.com/web/geek/jobs");
          if (kind) markBlocked("boss", { kind, reason: `${message || "接口拒绝"}（code ${code}）`, url: at });
          break;
        }
        if (bodies.length < p) break; // 没有更多

        const body = bodies[p - 1];
        const cand = findJobArray(body);
        for (const j of toRawJobs(cand?.items ?? [], "boss", query)) {
          if (seen.has(j.externalId)) continue;
          seen.add(j.externalId);
          out.push(j);
        }
        if (body?.zpData?.hasMore === false || !cand?.items.length) break;
        if (p < maxPages) { await pace("boss", "page"); await humanScroll(page, 4); }
      }
    } finally {
      page.off("response", onResponse);
    }
    return out;
  },
};
