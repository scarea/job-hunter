import type { Collector, RawJob } from "../types.js";
import { humanScroll, pace } from "./base.js";
import { detectBlock, markBlocked } from "../platforms.js";
import { LIEPIN_LIST } from "./scripts.js";
import type { Page } from "playwright";

const CITY_CODE = "050020"; // 深圳

export const liepinCollector: Collector = {
  platform: "liepin",
  async collect(query: string, { maxPages, page }: { maxPages: number; page: Page }): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (let p = 0; p < maxPages; p++) {
      const url = `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(query)}&city=${CITY_CODE}&curPage=${p}`;
      if (p !== 0) await pace("liepin", "page");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await humanScroll(page, 3);

      const block = await detectBlock(page, "liepin");
      if (block) { markBlocked("liepin", block); break; }

      const rows = (await page.evaluate(LIEPIN_LIST)) as any[];
      if (!rows?.length) break;

      for (const r of rows) {
        if (!r.title || !r.href) continue;
        const id = liepinId(r.href);
        const [city, district] = (r.loc || "").split("-");
        out.push({
          platform: "liepin", externalId: id, title: r.title, company: r.company,
          salaryRaw: r.salary, city: city || "", district: district || "", // 解析不到就留空，别默认成深圳
          tags: [], url: r.href.split("?")[0], query,
        });
      }
    }
    return out;
  },
};

/**
 * 猎聘岗位 ID：
 *   /job/1977224135.shtml → "1977224135"（企业直招）
 *   /a/78400887.shtml     → "a78400887"（猎头代招，加前缀避免和直招 ID 撞号）
 * 认不出的链接用去掉查询参数的 URL：参数里的 pgRef 每次搜索都不同，带上就会重复入库
 */
export function liepinId(href: string): string {
  const m = href.match(/\/(job|a)\/(\d+)\.shtml/);
  if (m) return m[1] === "a" ? `a${m[2]}` : m[2];
  return href.split(/[?#]/)[0];
}
