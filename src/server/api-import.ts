import type { Platform, RawJob } from "../types.js";
import { findJobArray, toRawJobs } from "../collectors/auto-json.js";
import { liepinId } from "../collectors/liepin.js";
import { parseSalary } from "../score/salary.js";

/**
 * 解析「页面自己发的接口响应」→ 岗位
 *
 * 由油猴脚本 / MV3 插件被动抓取页面原本就发出的 XHR 响应，原样转发过来，
 * 这里负责把它翻译成内部结构。好处是字段规则集中在一处，脚本只管转发。
 *
 * externalId 与「自动采集」保持一致，避免同一岗位重复入库：
 *   BOSS   → encryptJobId（接口明文，列表页 DOM 里薪资是加密字体，不可用）
 *   猎聘   → liepinId()（/a/ 猎头岗加 a 前缀，和 /job/ 直招岗不撞号）
 *   智联   → 接口里的 position number
 */
/** list = 列表接口；detail = BOSS 详情接口；detail-dom = 脚本从你打开的详情页上读到的 JD */
export type ImportKind = "list" | "detail" | "detail-dom";

export interface ApiPayload {
  platform: Platform;
  kind?: ImportKind;
  /** 触发时的搜索词，用于关键词策略统计收益 */
  query?: string;
  /** 页面地址，用于拼岗位链接 */
  pageUrl?: string;
  /** 接口原始 JSON */
  raw: unknown;
}

export interface ParsedImport {
  jobs: RawJob[];
  detailJob?: { externalId: string; platform: Platform; jd: string; salaryRaw: string };
  /** 给前端/日志看的说明 */
  note: string;
}

/** 从 BOSS 列表项取 id：encryptJobId 优先（与自动采集一致） */
function pickDeep(item: any, keys: string[]): any {
  if (!item) return undefined;
  for (const k of keys) if (item[k] != null && item[k] !== "") return item[k];
  for (const nest of ["job", "data", "jobInfo", "position"]) {
    const sub = item[nest];
    if (sub && typeof sub === "object") for (const k of keys) if (sub[k] != null && sub[k] !== "") return sub[k];
  }
  return undefined;
}

function bossId(item: any): string | null {
  const v = pickDeep(item, ["encryptJobId", "encryptBossId", "jobId", "lid"]);
  return v != null && String(v) !== "" ? String(v) : null;
}

/** 从猎聘列表项取 id：拼成标准 URL 后走 liepinId，保证与 DOM 采集同源 */
function liepinIdOf(item: any): string | null {
  const raw = pickDeep(item, ["jobId", "id"]);
  if (raw == null || String(raw) === "") return null;
  const id = String(raw);
  // 猎头代招的 jobKind 常见取值 1/2；有 url 字段时以 url 为准最稳
  const url: string | undefined = pickDeep(item, ["url", "jobUrl"]);
  if (url) return liepinId(url);
  const kind = pickDeep(item, ["jobKind"]);
  return kind === 1 || kind === "1" ? `a${id}` : id;
}

function withIds(jobs: RawJob[], platform: Platform, items: any[], query: string): RawJob[] {
  return jobs.map((j, i) => {
    const item = items[i];
    let externalId = j.externalId;
    if (platform === "boss") {
      const id = bossId(item);
      if (id) externalId = id;
    } else if (platform === "liepin") {
      const id = liepinIdOf(item);
      if (id) externalId = id;
    }
    return { ...j, externalId, query };
  });
}

/** 详情接口：BOSS job/detail.json → { zpData: { jobInfo: {...}, bossInfo: {...} } } */
function parseBossDetail(raw: any): { externalId?: string; jd: string; salaryRaw: string } | null {
  const d = raw?.zpData ?? raw?.data ?? raw;
  const info = d?.jobInfo ?? d?.job ?? d;
  if (!info || typeof info !== "object") return null;
  const jd = String(info.jobDescription ?? info.postDescription ?? info.description ?? "").trim();
  const salaryRaw = String(info.salaryDesc ?? info.salary ?? "").trim();
  const externalId = info.encryptJobId ?? info.encryptId ?? undefined;
  if (!jd && !salaryRaw) return null;
  return { externalId: externalId ? String(externalId) : undefined, jd, salaryRaw };
}

export function parseApiPayload(p: ApiPayload): ParsedImport {
  const platform = p.platform;
  const query = String(p.query || "").trim();

  // ---- 详情页文字：脚本已经算好了 externalId（和采集同一套规则） ----
  if (p.kind === "detail-dom") {
    const r = p.raw as any;
    if (r?.externalId && String(r.jd || "").trim().length > 40) {
      return { jobs: [], detailJob: { externalId: String(r.externalId), platform, jd: String(r.jd).slice(0, 3000), salaryRaw: String(r.salaryRaw || "") }, note: "详情页" };
    }
    return { jobs: [], note: "详情页没读到 JD" };
  }

  // ---- 详情：只有一条岗位，补 JD / 薪资 ----
  if (p.kind === "detail") {
    if (platform === "boss") {
      const d = parseBossDetail(p.raw);
      if (d?.externalId && (d.jd || d.salaryRaw)) {
        return { jobs: [], detailJob: { externalId: d.externalId, platform, jd: d.jd, salaryRaw: d.salaryRaw }, note: "BOSS 详情" };
      }
      return { jobs: [], note: "BOSS 详情没解析出内容" };
    }
    return { jobs: [], note: `${platform} 详情暂不支持` };
  }

  // ---- 列表 ----
  const cand = findJobArray(p.raw);
  if (!cand?.items.length) return { jobs: [], note: "没找到岗位数组" };

  let jobs = toRawJobs(cand.items, platform, query);
  jobs = withIds(jobs, platform, cand.items, query);

  // 用页面地址补岗位链接（接口里常常不给 url）
  const base = p.pageUrl || "";
  for (const j of jobs) {
    if (j.url) continue;
    if (platform === "boss") j.url = `https://www.zhipin.com/job_detail/${j.externalId}.html`;
    else if (platform === "liepin") j.url = `https://www.liepin.com/${j.externalId.startsWith("a") ? "a" : "job"}/${j.externalId.replace(/^a/, "")}.shtml`;
    else if (platform === "zhaopin") j.url = `https://www.zhaopin.com/jobdetail/${j.externalId}.htm`;
    void base;
  }
  return { jobs, note: `列表 ${jobs.length} 条` };
}

export { parseSalary };
