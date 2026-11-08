import type { Collector, RawJob } from "../../types.js";
import { sleep } from "../base.js";
import { toRaw, type OfficialSource } from "./types.js";
import { SOURCES } from "./sources.js";

/**
 * 「大厂官网」平台：依次请求每家公司的公开招聘接口
 * 单家公司失败（改版、超时）只跳过这家，不影响其他公司。
 */
const MAX_PAGES = parseInt(process.env.OFFICIAL_MAX_PAGES || "2", 10);
export const enabledSources = (): OfficialSource[] => {
  const only = (process.env.OFFICIAL_SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
};

export const officialCollector: Collector = {
  platform: "official",
  async collect(query: string): Promise<RawJob[]> {
    const out: RawJob[] = [];
    const seen = new Set<string>();
    for (const src of enabledSources()) {
      for (let p = 1; p <= MAX_PAGES; p++) {
        try {
          const { jobs, total } = await src.search(query, p);
          for (const j of jobs) {
            const raw = toRaw(src, j, query);
            if (seen.has(raw.externalId) || !raw.title) continue;
            seen.add(raw.externalId);
            out.push(raw);
          }
          // 按总数判断是否还有下一页（有的公司本地去重 / 过滤后单页不满，不能用「不满一页」判断）
          if (!jobs.length || p * src.pageSize >= total) break;
        } catch (e: any) {
          console.log(`    ⚠️ ${src.company} 官网：${e.message}（跳过）`);
          break;
        }
        await sleep(800 + Math.random() * 700);
      }
      await sleep(500 + Math.random() * 500);
    }
    return out;
  },
};

/** 补详情：externalId = "<source>:<id>" */
export async function fetchOfficialDetail(externalId: string): Promise<string> {
  const i = externalId.indexOf(":");
  const src = SOURCES.find((s) => s.id === externalId.slice(0, i));
  if (!src?.detail) return "";
  return src.detail(externalId.slice(i + 1));
}

/** 每家公司的岗位数（看板用） */
export function sourceList() {
  return SOURCES.map((s) => ({ id: s.id, company: s.company }));
}
