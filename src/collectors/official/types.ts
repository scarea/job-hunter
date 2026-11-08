import type { RawJob } from "../../types.js";

/**
 * 大厂官网招聘源：公开接口、不需要登录、没有签名，零账号风险。
 * 每家公司一个适配器，统一挂在「official」平台下（看板上是一张卡片）。
 * externalId 统一写成 `<source id>:<岗位 id>`，补详情时按前缀找回适配器。
 */
export interface OfficialJob {
  id: string;            // 公司内的岗位 id
  title: string;
  city: string;
  dept?: string;         // 部门 / BU
  jd?: string;           // 列表里就带 JD 的直接给
  tags?: string[];
  url: string;           // 给人看的岗位详情页
  updatedAt?: string;
}

export interface OfficialSource {
  id: string;            // 短 id，如 "bytedance"
  company: string;       // 显示用公司名，如 "字节跳动"
  /** 搜一页：关键词 + 深圳 + 社招；返回本页岗位和总数 */
  search(keyword: string, page: number): Promise<{ jobs: OfficialJob[]; total: number }>;
  /** 列表里没有 JD 时，按岗位 id 取 JD */
  detail?(id: string): Promise<string>;
  pageSize: number;
}

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export async function http(url: string, init: RequestInit & { json?: unknown; form?: Record<string, string | number> } = {}): Promise<any> {
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/json, text/plain, */*", ...(init.headers as Record<string, string> | undefined) };
  let body = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] ??= "application/json"; }
  if (init.form) {
    body = new URLSearchParams(Object.entries(init.form).map(([k, v]) => [k, String(v)])).toString();
    headers["content-type"] ??= "application/x-www-form-urlencoded; charset=UTF-8";
  }
  const res = await fetch(url, { ...init, headers, body, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`非 JSON 响应 ${url.split("?")[0]}`); }
}

/** HTML / 多余空白 → 纯文本 JD */
export function textify(s: unknown): string {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function toRaw(src: OfficialSource, j: OfficialJob, query: string): RawJob {
  return {
    platform: "official",
    externalId: `${src.id}:${j.id}`,
    title: j.title.trim(),
    company: j.dept ? `${src.company}·${j.dept}` : src.company,
    salaryRaw: "",
    city: j.city || "",
    district: "",
    tags: (j.tags ?? []).filter(Boolean).slice(0, 8),
    jd: (j.jd ?? "").slice(0, 3000),
    url: j.url,
    query,
  };
}
