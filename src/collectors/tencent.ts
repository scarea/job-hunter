import type { Collector, RawJob } from "../types.js";
import { pace } from "./base.js";

/**
 * 腾讯官网招聘（careers.tencent.com）
 * 公开 JSON 接口，不需要登录、没有签名 → 零封号风险。
 * 官网岗位没有薪资，JD 在详情接口里（由每日任务的「补详情」步骤调用 fetchTencentDetail）。
 */
const BASE = "https://careers.tencent.com/tencentcareer/api/post";
const CITY_ID = process.env.TENCENT_CITY_ID || "1"; // 1 = 深圳
const PAGE_SIZE = 50;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": UA, referer: "https://careers.tencent.com/" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`腾讯招聘 HTTP ${res.status}`);
  return res.json();
}

export const tencentCollector: Collector = {
  platform: "tencent",
  async collect(query: string, { maxPages }: { maxPages: number }): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (let p = 1; p <= maxPages; p++) {
      if (p > 1) await pace("tencent", "page");
      const qs = new URLSearchParams({
        timestamp: String(Date.now()), cityId: CITY_ID, attrId: "1", keyword: query,
        pageIndex: String(p), pageSize: String(PAGE_SIZE), language: "zh-cn", area: "cn",
      });
      const d = (await getJson(`${BASE}/Query?${qs}`))?.Data;
      const posts: any[] = d?.Posts ?? [];
      for (const x of posts) {
        if (x.IsValid === "False") continue;
        out.push({
          platform: "tencent",
          externalId: String(x.PostId),
          title: String(x.RecruitPostName || "").trim(),
          company: `腾讯${x.BGName ? `·${x.BGName}` : ""}`,
          salaryRaw: "",
          city: x.LocationName || "",
          district: "",
          tags: [x.CategoryName, x.ProductName, x.RequireWorkYearsName].filter(Boolean),
          url: `https://careers.tencent.com/jobdesc.html?postId=${x.PostId}`,
          query,
        });
      }
      if (posts.length < PAGE_SIZE || out.length >= (d?.Count ?? 0)) break;
    }
    return out;
  },
};

/** 详情：岗位职责 + 任职要求 */
export async function fetchTencentDetail(postId: string): Promise<{ jd: string; salaryRaw: string }> {
  const qs = new URLSearchParams({ timestamp: String(Date.now()), postId, language: "zh-cn" });
  const d = (await getJson(`${BASE}/ByPostId?${qs}`))?.Data;
  if (!d) return { jd: "", salaryRaw: "" };
  const jd = [`【岗位职责】\n${d.Responsibility || ""}`, `【任职要求】\n${d.Requirement || ""}`].join("\n\n").trim();
  return { jd: jd.slice(0, 3000), salaryRaw: "" };
}
