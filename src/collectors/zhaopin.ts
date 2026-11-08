import type { Collector, RawJob } from "../types.js";
import { humanScroll, pace } from "./base.js";
import { detectBlock, markBlocked } from "../platforms.js";
import { ZHAOPIN_LIST } from "./scripts.js";
import type { Page } from "playwright";

/**
 * 智联的城市编码。默认深圳；要采多城市就配 ZHAOPIN_CITIES（逗号分隔）。
 * 常见：765=深圳 530=北京 538=上海 763=广州 801=成都
 */
const CITY_CODES = (process.env.ZHAOPIN_CITIES || "765,530,538,763,801").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * 今天采哪些城市：深圳（第一个）常驻，其余按天轮转。
 * 全城市一起采会让请求量翻五倍，轮转只在多花一倍的情况下覆盖到北上广蓉。
 */
function citiesToday(): string[] {
  const [primary, ...rest] = CITY_CODES;
  if (!rest.length) return [primary];
  const day = Math.floor(Date.now() / 86400_000);
  return [primary, rest[day % rest.length]];
}
const CITY_CODE = CITY_CODES[0];

/** 城市编码 → 名称（以前输出里 city 写死成「深圳」，搜北京也标深圳） */
const CITY_NAME: Record<string, string> = {
  "765": "深圳", "530": "北京", "538": "上海", "763": "广州", "801": "成都",
  "736": "杭州", "719": "武汉", "7361": "南京", "854": "西安", "551": "苏州",
};

export const zhaopinCollector: Collector = {
  platform: "zhaopin",
  async collect(query: string, { maxPages, page }: { maxPages: number; page: Page }): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (const cityCode of citiesToday()) {
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.zhaopin.com/jobs/?kw=${encodeURIComponent(query)}&jl=${cityCode}&p=${p}`;
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
          salaryRaw: r.salary, city: CITY_NAME[cityCode] || "深圳", tags: r.tags ?? [],
          url: r.href || "", query,
        });
      }
    }
    }
    return out;
  },
};
