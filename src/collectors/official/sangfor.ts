import { http, textify, type OfficialSource } from "./types.js";

/**
 * 深信服 自有招聘站（Nuxt + .NET API）
 *
 * 走的是它自己的公开接口，无需登录：
 *   GET  /api/api/connect/token   匿名令牌：官网前端每个访客打开页面都会这样请求（并每 10 分钟刷新），这里照做
 *   POST /api/api/Jobs            { pageIndex, pageSize } → 全部岗位（含 HTML 格式 JD）
 *
 * 实测：144 个岗位，其中 103 个是「社会招聘」，其余是校招/实习/博士专项（会在下面过滤掉）。
 * 注意：官网不公开薪资（minSalary/maxSalary 都是 0），JD 很完整。
 * 关键词接口不支持服务端筛选，所以一次性拉全量再本地过滤。
 */
const BASE = "https://hr.sangfor.com";
const PAGE_SIZE = 300;

let cachedToken: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.token;
  // 和官网前端完全一致：直接 GET，不带任何凭据
  const d = await http(`${BASE}/api/api/connect/token`, {
    headers: { referer: `${BASE}/Sociology`, origin: BASE },
  });
  const token = String(d?.access_token || "");
  if (!token) throw new Error("拿不到 token");
  // 提前 5 分钟过期，避免边界
  const ttl = Number(d?.expires_in || 3600) * 1000 - 5 * 60_000;
  cachedToken = { token, exp: Date.now() + Math.max(ttl, 60_000) };
  return token;
}

/** 只要社招：排除校园/实习/博士专项 */
const isSocial = (channelName: string) => !/校园|校招|实习|博士|X-STAR/i.test(channelName || "");

function stripHtml(html: string): string {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const sangfor: OfficialSource = {
  id: "sangfor",
  company: "深信服",
  pageSize: PAGE_SIZE,

  async search(keyword, page) {
    if (page > 1) return { jobs: [], total: 0 }; // 一次拉全量，不分页
    const token = await getToken();
    const d = await http(`${BASE}/api/api/Jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      json: { pageIndex: 1, pageSize: PAGE_SIZE },
    });
    if (d?.code !== 0) throw new Error(`接口返回 ${d?.code} ${d?.message ?? ""}`);

    const list: any[] = d?.data?.listData ?? [];
    const kw = String(keyword || "").trim().toLowerCase();

    const jobs = list
      .filter((x) => isSocial(String(x.channelName || "")))
      .map((x) => {
        const jd = stripHtml(String(x.description || ""));
        return {
          id: String(x.positionId),
          title: String(x.title || ""),
          city: String(x.locationText || x.workPlaceText || ""),
          dept: String(x.departmentName || "") || undefined,
          jd: textify(jd),
          tags: [String(x.functionName || ""), x.minExperience ? `${x.minExperience}-${x.maxExperience}年` : "", String(x.education || "")].filter(Boolean),
          url: `${BASE}/Sociology`,
          updatedAt: x.appendTime ? new Date(x.appendTime).toISOString() : undefined,
        };
      })
      .filter((j) => !kw || (j.title + j.jd).toLowerCase().includes(kw));

    return { jobs, total: jobs.length };
  },
};
