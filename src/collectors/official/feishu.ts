import { http, textify, type OfficialSource } from "./types.js";

/**
 * 飞书招聘（字节、小米等很多公司的官网都是这套）
 * POST /api/v1/search/job/posts；深圳 = CT_128；列表自带职责 + 要求
 * 注意：字节不能带 website-path 头（会报 site not exist），小米必须带 website-path: index
 */
export function feishuSource(opt: {
  id: string; company: string; host: string; portalType: number; websitePath?: string; detailUrl: (id: string) => string;
}): OfficialSource {
  const headers: Record<string, string> = {
    "portal-channel": "office", "portal-platform": "pc",
    origin: `https://${opt.host}`, referer: `https://${opt.host}/`,
  };
  if (opt.websitePath) headers["website-path"] = opt.websitePath;
  const pageSize = 20;
  return {
    id: opt.id, company: opt.company, pageSize,
    async search(keyword, page) {
      const d = await http(`https://${opt.host}/api/v1/search/job/posts`, {
        method: "POST", headers,
        json: {
          keyword, limit: pageSize, offset: (page - 1) * pageSize,
          location_code_list: ["CT_128"], recruitment_id_list: ["1"],
          portal_type: opt.portalType, portal_entrance: 1, language: "zh",
        },
      });
      if (d?.code !== 0) throw new Error(`接口返回 ${d?.code} ${d?.message ?? ""}`);
      const list: any[] = d.data?.job_post_list ?? [];
      return {
        total: d.data?.count ?? list.length,
        jobs: list.map((x) => ({
          id: String(x.id),
          title: String(x.title ?? ""),
          city: (x.city_list ?? []).map((c: any) => c.name).filter(Boolean).join("/") || x.city_info?.name || "",
          dept: String(x.title ?? "").includes("-") ? String(x.title).split("-")[0].trim().slice(0, 12) : undefined,
          jd: textify([x.description && `【职责】\n${x.description}`, x.requirement && `【要求】\n${x.requirement}`].filter(Boolean).join("\n\n")),
          tags: [x.job_category?.name, x.recruit_type?.name].filter(Boolean),
          url: opt.detailUrl(String(x.id)),
          updatedAt: x.publish_time ? new Date(Number(x.publish_time)).toISOString() : undefined,
        })),
      };
    },
  };
}
