import { randomUUID } from "node:crypto";
import { http, textify, type OfficialSource } from "./types.js";

/**
 * 阿里巴巴：POST talent.alibaba.com/position/search
 * 需要 XSRF：自己生成一个值，cookie 和 x-xsrf-token 头放同一个（双提交 cookie，不是签名）
 * 深圳 regions = "440300"；列表自带职责 + 要求
 */
export const alibaba: OfficialSource = {
  id: "alibaba", company: "阿里巴巴", pageSize: 50,
  async search(keyword, page) {
    const tok = randomUUID();
    const d = await http("https://talent.alibaba.com/position/search", {
      method: "POST",
      headers: { cookie: `XSRF-TOKEN=${tok}`, "x-xsrf-token": tok, origin: "https://talent.alibaba.com", referer: "https://talent.alibaba.com/off-campus/position-list?lang=zh" },
      json: { channel: "group_official_site", language: "zh", batchId: "", categories: "", deptCodes: [], key: keyword, pageIndex: page, pageSize: 50, regions: "440300", subCategories: "" },
    });
    const list: any[] = d?.content?.datas ?? [];
    return {
      total: d?.content?.totalCount ?? list.length,
      jobs: list.map((x) => ({
        id: String(x.id),
        title: String(x.name ?? ""),
        city: (x.workLocations ?? []).join("/"),
        dept: String(x.name ?? "").includes("-") ? String(x.name).split("-")[0].trim().slice(0, 12) : undefined,
        jd: textify([x.description && `【职责】\n${x.description}`, x.requirement && `【要求】\n${x.requirement}`].filter(Boolean).join("\n\n")),
        tags: [x.categoryName, ...(x.experience ? [x.experience] : [])].filter(Boolean),
        url: `https://talent.alibaba.com/off-campus/position-detail?lang=zh&positionId=${x.id}`,
        updatedAt: x.modifyTime ? new Date(Number(x.modifyTime)).toISOString() : undefined,
      })),
    };
  },
};

/** 蚂蚁集团：和阿里同一套系统，接口在 hrcareersweb.antgroup.com，不需要 XSRF */
export const antgroup: OfficialSource = {
  id: "antgroup", company: "蚂蚁集团", pageSize: 20,
  async search(keyword, page) {
    const d = await http("https://hrcareersweb.antgroup.com/api/social/position/search", {
      method: "POST",
      headers: { origin: "https://talent.antgroup.com", referer: "https://talent.antgroup.com/off-campus-position" },
      json: { channel: "group_official_site", language: "zh", key: keyword, pageIndex: page, pageSize: 20, regions: "440300" },
    });
    const list: any[] = Array.isArray(d?.content) ? d.content : [];
    return {
      total: d?.totalCount ?? list.length,
      jobs: list.map((x) => ({
        id: String(x.id),
        title: String(x.name ?? ""),
        city: (x.workLocations ?? []).join("/"),
        dept: x.department ? String(x.department).slice(0, 12) : undefined,
        jd: textify([x.description && `【职责】\n${x.description}`, x.requirement && `【要求】\n${x.requirement}`].filter(Boolean).join("\n\n")),
        tags: (x.categories ?? []).map((c: any) => (typeof c === "string" ? c : c?.name)).filter(Boolean),
        url: `https://talent.antgroup.com/off-campus-position?positionId=${x.id}`,
        updatedAt: x.publishTime ? String(x.publishTime) : undefined,
      })),
    };
  },
};
