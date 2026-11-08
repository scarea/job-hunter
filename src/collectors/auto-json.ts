import type { RawJob, Platform } from "../types.js";

/**
 * 通用 JSON → RawJob 适配器
 *
 * 不硬编码各平台的字段名，而是：
 *  1. 递归找出 JSON 里「最大的、像岗位列表的数组」
 *  2. 按候选 key 列表猜字段
 *
 * 这样平台改字段名（jobName → jobTitle）也不会立刻失效。
 */

const TITLE_KEYS = ["jobName", "jobTitle", "positionName", "title", "name", "position", "job_name", "job_title"];
const SALARY_KEYS = ["salaryDesc", "salaryReal", "salary", "salary60", "salaryMonth", "compensation", "salaryDescList", "jobSalary"];
const COMPANY_KEYS = ["brandName", "companyName", "compName", "company", "companyShortName", "brandNameStr"];
const CITY_KEYS = ["workCity", "cityName", "city", "location", "addr", "areaDistrict", "cityDistrict"];
const DISTRICT_KEYS = ["cityDistrict", "areaDistrict", "businessDistrict", "district"];
/** 接口自带的岗位链接（智联 positionURL 等），比自己拼的可靠 */
const URL_KEYS = ["positionURL", "positionUrl", "jobUrl", "jobURL", "detailUrl", "url", "link"];
const ID_KEYS = ["encryptJobId", "jobId", "positionId", "id", "jobid", "job_id", "positionNumber"];
const JD_KEYS = ["jobDescription", "postDescription", "description", "jobDesc", "jd", "requirements"];

/**
 * 拍平一层嵌套。
 * 猎聘的列表项形如 { job: { jobId, title, salary }, comp: { compName } }，
 * 字段都在子对象里；BOSS/智联基本是平的。统一拍平后再用同一套候选键取值。
 */
const NEST_KEYS = ["job", "comp", "company", "jobInfo", "data", "position", "recruit"];
function flatten(item: any): any {
  if (!item || typeof item !== "object") return item;
  let out = item;
  for (const k of NEST_KEYS) {
    const v = item[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (out === item) out = { ...item };
      for (const [kk, vv] of Object.entries(v)) if (out[kk] === undefined) out[kk] = vv;
    }
  }
  return out;
}

export interface JsonJobCandidate {
  arrayPath: string;
  items: any[];
  score: number;
}

/** 递归找最像岗位列表的数组 */
export function findJobArray(root: any): JsonJobCandidate | null {
  const candidates: JsonJobCandidate[] = [];

  const walk = (node: any, path: string, depth: number) => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      if (node.length >= 1 && node.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
        const sample = node.slice(0, 5).map(flatten);
        let hits = 0;
        for (const k of TITLE_KEYS) if (sample.some((s) => typeof s[k] === "string" && s[k].length > 1)) { hits += 3; break; }
        for (const k of SALARY_KEYS) if (sample.some((s) => s[k] != null)) { hits += 2; break; }
        for (const k of COMPANY_KEYS) if (sample.some((s) => typeof s[k] === "string" && s[k].length > 1)) { hits += 2; break; }
        for (const k of ID_KEYS) if (sample.some((s) => s[k] != null)) { hits += 1; break; }
        if (hits >= 5) candidates.push({ arrayPath: path, items: node, score: hits * 100 + node.length });
      }
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node === "object") {
      for (const k of Object.keys(node).slice(0, 60)) walk(node[k], `${path}.${k}`, depth + 1);
    }
  };

  walk(root, "$", 0);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.score - a.score)[0];
}

function pick(obj: any, keys: string[]): any {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "" && typeof v !== "object") return v;
    if (v && typeof v === "object") {
      // 有些字段是 { desc: "20-30K" } 或 [{name:"深圳"}]
      if (typeof v.desc === "string") return v.desc;
      if (Array.isArray(v) && v[0]?.name) return v.map((x: any) => x.name).join("·");
      if (typeof v.name === "string") return v.name;
    }
  }
  return null;
}

export function toRawJobs(rawItems: any[], platform: Platform, query: string): RawJob[] {
  const out: RawJob[] = [];
  for (const it of rawItems.map(flatten)) {
    const title = String(pick(it, TITLE_KEYS) ?? "").trim();
    if (!title) continue;

    const company = String(pick(it, COMPANY_KEYS) ?? "").trim();
    const salaryRaw = String(pick(it, SALARY_KEYS) ?? "").trim();
    const loc = String(pick(it, CITY_KEYS) ?? "").trim();
    const district = String(pick(it, DISTRICT_KEYS) ?? "").trim();
    const apiUrl = URL_KEYS.map((k) => it?.[k]).find((v) => typeof v === "string" && /^https?:\/\//.test(v)) as string | undefined;
    const jd = String(pick(it, JD_KEYS) ?? "").trim();
    const rawId = pick(it, ID_KEYS);
    const externalId = rawId != null ? String(rawId) : `${company}::${title}`;

    out.push({
      platform,
      externalId,
      title,
      company,
      salaryRaw,
      city: loc.split(/[·\-]/)[0] || "",
      district: district || loc.split(/[·\-]/).slice(1).join("·"),
      tags: extractTags(it),
      jd: jd.slice(0, 3000),
      url: apiUrl ? apiUrl.replace(/^http:\/\//, "https://") : buildUrl(platform, externalId, rawId),
      query,
    });
  }
  return out;
}

function extractTags(it: any): string[] {
  const tags: string[] = [];
  for (const k of ["skills", "welfare", "welfareLabel", "jobLabels", "labels", "tags", "jobTag", "skillLabels", "showSkillTags", "jobSkillTags"]) {
    const v = it?.[k];
    if (Array.isArray(v)) tags.push(...v.map((x: any) => (typeof x === "string" ? x : x?.name ?? x?.tag ?? x?.value)).filter(Boolean));
    else if (typeof v === "string" && v.length < 60) tags.push(...v.split(/[,，|]/).map((s) => s.trim()).filter(Boolean));
  }
  for (const k of ["experience", "degree", "eduLevel", "jobExperience", "workingExp", "jobDegree", "subJobTypeLevelName"]) {
    const v = it?.[k];
    if (typeof v === "string" && v.length < 20) tags.push(v);
  }
  return [...new Set(tags)].slice(0, 8);
}

function buildUrl(platform: Platform, externalId: string, rawId: any): string {
  switch (platform) {
    case "boss": return `https://www.zhipin.com/job_detail/${externalId}.html`;
    case "zhaopin": return `https://www.zhaopin.com/jobdetail/${externalId}.htm`;
    case "liepin": return `https://www.liepin.com/job/${externalId}.shtml`;
    default: return "";
  }
}
