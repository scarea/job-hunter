import type { Platform, RawJob } from "../types.js";
import type { CapturedRequest } from "./capture.js";
import { findJobArray, toRawJobs } from "./auto-json.js";
import { classifyApiRejection, markBlocked } from "../platforms.js";

/**
 * 纯 HTTP 回放采集器
 * - 用捕获到的接口 URL + cookie + headers 直接请求
 * - 不需要浏览器，速度快 10 倍，不占屏幕
 * - 自动翻页；接口返回空就停
 */

export interface ReplayResult {
  jobs: RawJob[];
  pages: number;
  error?: string;
  /** 平台明确拒绝（登录/验证/风控），不要再换方式重试 */
  blocked?: boolean;
}

/** cookie 的 domain 是否覆盖请求的 host（".zhaopin.com" 覆盖 "fe-api.zhaopin.com"） */
function domainMatches(host: string, domain: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return host === d || host.endsWith("." + d);
}

/**
 * 只带目标域名的 cookie。
 * ⚠️ 旧版快照里存的是整个浏览器的 cookie（含 BOSS、Google 等），这里再过滤一次，绝不跨站发送。
 */
export function cookieHeader(c: CapturedRequest, url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return c.cookies.filter((x) => domainMatches(host, x.domain)).map((x) => `${x.name}=${x.value}`).join("; ");
}

/**
 * 把 URL / body 里的「页码」和「搜索词」替换成目标值
 * ⚠️ 搜索词必须替换，否则不同关键词会命中同一份快照、返回重复结果
 */
export function withPage(c: CapturedRequest, page: number, query: string, cityCode?: string): { url: string; body?: string } {
  let url = c.url;
  let body = c.postData;

  // --- 替换搜索词（URL 里的 + body 里的）---
  if (c.query && query && c.query !== query) {
    const encOld = encodeURIComponent(c.query);
    url = url.split(encOld).join(encodeURIComponent(query));
    url = url.split(c.query).join(encodeURIComponent(query));
    if (body) {
      const jsonOld = JSON.stringify(c.query).slice(1, -1); // 不带引号
      const jsonNew = JSON.stringify(query).slice(1, -1);
      body = body.split(jsonOld).join(jsonNew);
    }
  }

  // --- 替换城市（智联的 postData 里是 "S_SOU_WORK_CITY":"765"）---
  // 以前只换了关键词，城市一直沿用抓包时的深圳，导致「切城市」根本不生效
  if (cityCode && body) {
    body = body.replace(/("S_SOU_WORK_CITY"\s*:\s*")[^"]*(")/, `$1${cityCode}$2`);
    body = body.replace(/("cityId"\s*:\s*")[^"]*(")/, `$1${cityCode}$2`);
  }

  // 常见分页参数（curPage 从 0 开始，其余从 1 开始；智联用 pageIndex）
  const ONE_BASED = ["page", "pageNo", "pageIndex", "pageNum", "currentPage", "p"];
  for (const k of ONE_BASED) url = url.replace(new RegExp(`([?&]${k}=)\\d+`), `$1${page}`);
  url = url.replace(/([?&]curPage=)\d+/, `$1${page - 1}`);

  if (body) {
    for (const k of ONE_BASED) body = body.replace(new RegExp(`("${k}"\\s*:\\s*)\\d+`), `$1${page}`);
    body = body.replace(/("curPage"\s*:\s*)\d+/, `$1${page - 1}`);
  }
  return { url, body };
}

/** 各平台「城市」所在的配置（值是抓包接口里的城市编码） */
const CITY_ENV: Partial<Record<Platform, string>> = {
  zhaopin: "ZHAOPIN_CITIES",
};
/** 没配环境变量时的默认城市（第一个常驻，其余轮转） */
const DEFAULT_CITIES: Partial<Record<Platform, string>> = {
  zhaopin: "765,530,538,763,801", // 深圳 北京 上海 广州 成都
};

export async function replayCollect(
  cap: CapturedRequest,
  platform: Platform,
  query: string,
  maxPages: number
): Promise<ReplayResult> {
  // 回放时必须把城市一起换掉，否则不管搜哪个城市都返回抓包时的那个城市
  const cityEnv = CITY_ENV[platform];
  const allCities = cityEnv ? (process.env[cityEnv] || DEFAULT_CITIES[platform] || "").split(",").map((x) => x.trim()).filter(Boolean) : [];
  // 第一个城市常驻，其余按天轮转一个（全采会让请求量翻几倍）
  let cities: (string | undefined)[] = [undefined];
  if (allCities.length === 1) cities = [allCities[0]];
  else if (allCities.length > 1) {
    const day = Math.floor(Date.now() / 86400_000);
    cities = [allCities[0], allCities[1 + (day % (allCities.length - 1))]];
  }
  const cityCode = cities[0];
  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  let pages = 0;

  for (const city of cities) {
  for (let p = 1; p <= maxPages; p++) {
    const { url, body } = withPage(cap, p, query, city);
    try {
      const res = await fetch(url, {
        method: cap.method === "POST" ? "POST" : "GET",
        headers: {
          ...cap.headers,
          cookie: cookieHeader(cap, url),
        },
        body: cap.method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        if (p === 1) return { jobs, pages, error: `HTTP ${res.status}` };
        break;
      }

      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { break; }

      // 有些接口用 code 表示失败
      const code = json?.code ?? json?.statusCode ?? json?.rc ?? 0;
      if (String(code) !== "0" && json?.message) {
        const kind = classifyApiRejection(String(json.message), code);
        if (kind) {
          markBlocked(platform, { kind, reason: `接口拒绝：${json.message}`, url: "" });
          return { jobs, pages, error: `接口拒绝：${json.message}`, blocked: true };
        }
      }

      const cand = findJobArray(json);
      if (!cand?.items.length) break;

      let added = 0;
      for (const j of toRawJobs(cand.items, platform, query)) {
        const key = `${j.platform}:${j.externalId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(j);
        added++;
      }
      pages++;
      if (added === 0) break; // 同一页重复返回，说明到底了
    } catch (e: any) {
      if (p === 1) return { jobs, pages, error: e.message };
      break;
    }
  }

  }
  return { jobs, pages };
}
