import type { Collector, RawJob } from "../types.js";
import { humanScroll, pace } from "./base.js";
import { detectBlock, markBlocked } from "../platforms.js";
import { ZHAOPIN_LIST } from "./scripts.js";
import type { Page } from "playwright";

const CITY_CODE = "765"; // 深圳

export const zhaopinCollector: Collector = {
  platform: "zhaopin",
  async collect(query: string, { maxPages, page }: { maxPages: number; page: Page }): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.zhaopin.com/jobs/?kw=${encodeURIComponent(query)}&jl=${CITY_CODE}&p=${p}`;
      if (p !== 1) await pace("zhaopin", "page");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await humanScroll(page, 3);

      const block = await detectBlock(page, "zhaopin");
      if (block) { markBlocked("zhaopin", block); break; }

      const rows = (await page.evaluate(ZHAOPIN_LIST)) as any[];
      if (!rows?.length) break;

      for (const r of rows) {
        if (!r.title) continue;
        const id = r.href?.match(/jobdetail\/([A-Za-z0-9]+)/)?.[1] || `${r.company}-${r.title}`;
        out.push({
          platform: "zhaopin", externalId: id, title: r.title, company: r.company,
          salaryRaw: r.salary, city: "深圳", tags: r.tags ?? [],
          url: r.href || "", query,
        });
      }
    }
    return out;
  },
};
