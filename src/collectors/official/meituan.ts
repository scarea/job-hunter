import { http, textify, type OfficialSource } from "./types.js";

/**
 * 美团：POST zhaopin.meituan.com/api/official/job/getJobList
 * 深圳 cityList code = 001019002；jobType code 3 = 社招；成功时 status == 1
 * 注意：关键词会匹配 JD 正文，结果偏宽（会混进采购类岗位），交给规则 + 初筛去筛
 */
export const meituan: OfficialSource = {
  id: "meituan", company: "美团", pageSize: 20,
  async search(keyword, page) {
    const d = await http("https://zhaopin.meituan.com/api/official/job/getJobList", {
      method: "POST",
      headers: { origin: "https://zhaopin.meituan.com", referer: "https://zhaopin.meituan.com/web/social" },
      json: {
        page: { pageNo: page, pageSize: 20 }, jobShareType: "1", keywords: keyword,
        cityList: [{ code: "001019002", name: "深圳市" }], department: [], jfJgList: [],
        jobType: [{ code: "3", subCode: [] }], typeCode: [], specialCode: [],
      },
    });
    if (d?.status !== 1) throw new Error(`接口返回 status=${d?.status} ${d?.message ?? ""}`);
    const list: any[] = d.data?.list ?? [];
    return {
      total: d.data?.page?.totalCount ?? list.length,
      jobs: list.map((x) => ({
        id: String(x.jobUnionId),
        title: String(x.name ?? ""),
        city: (x.cityList ?? []).map((c: any) => c.name).filter(Boolean).join("/"),
        dept: (x.department ?? []).map((c: any) => c.name).filter(Boolean)[0]?.slice(0, 12),
        jd: textify([x.jobDuty && `【职责】\n${x.jobDuty}`, x.jobRequirement && `【要求】\n${x.jobRequirement}`].filter(Boolean).join("\n\n")),
        tags: [x.jobFamily, x.jobFamilyGroup].filter(Boolean),
        url: `https://zhaopin.meituan.com/web/position/detail?jobUnionId=${x.jobUnionId}&jobShareType=1`,
        updatedAt: x.refreshTime ? new Date(Number(x.refreshTime)).toISOString() : undefined,
      })),
    };
  },
};
