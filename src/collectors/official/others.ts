import { http, textify, type OfficialSource } from "./types.js";

const jd = (duty: unknown, req: unknown) =>
  textify([duty && `【职责】\n${duty}`, req && `【要求】\n${req}`].filter(Boolean).join("\n\n"));
const ms = (v: unknown) => (v ? new Date(Number(v)).toISOString() : undefined);

/** 百度：表单 POST；深圳 workPlace=4403；同一个 jobId 可能对应多个 postId，按 jobId 去重 */
export const baidu: OfficialSource = {
  id: "baidu", company: "百度", pageSize: 20,
  async search(keyword, page) {
    const d = await http("https://talent.baidu.com/httservice/getPostListNew", {
      method: "POST",
      headers: { referer: "https://talent.baidu.com/jobs/social-list", origin: "https://talent.baidu.com" },
      form: { recruitType: "SOCIAL", keyWord: keyword, curPage: page, pageSize: 20, workPlace: "4403" },
    });
    const list: any[] = d?.data?.list ?? [];
    const seen = new Set<string>();
    return {
      total: Number(d?.data?.total ?? list.length),
      jobs: list.filter((x) => { const k = String(x.jobId ?? x.postId); if (seen.has(k)) return false; seen.add(k); return true; })
        .map((x) => ({
          id: String(x.postId),
          title: String(x.name ?? ""),
          city: String(x.workPlace ?? "").replace(/,/g, "/"),
          dept: x.bgShortName ? String(x.bgShortName).slice(0, 12) : undefined,
          jd: jd(x.workContent, x.serviceCondition),
          tags: [x.postType, x.workYears].filter(Boolean),
          url: `https://talent.baidu.com/jobs/detail/SOCIAL/${x.postId}`,
          updatedAt: x.updateDate ? String(x.updateDate) : undefined,
        })),
    };
  },
};

/** 华为：新官网的 API 网关；需要固定的应用 id 头（前端公开写死的，不是签名）；SR = 社招 */
export const huawei: OfficialSource = {
  id: "huawei", company: "华为", pageSize: 50,
  async search(keyword, page) {
    const d = await http("https://apigw-dgg-b0.huawei.com/api/apig/channelhw/recruitmentPosition/pub/getJobPage?X-HW-ID=app_000000035886", {
      method: "POST",
      headers: {
        referer: "https://career.huawei.com/", origin: "https://career.huawei.com",
        "x-hw-id": "app_000000035886", "x-jalor-tenantalias": "hcm", "x-language": "zh_CN", "x-referer": "https://career.huawei.com/cn",
      },
      json: { curPage: page, pageSize: 50, jobType: "SR", keyWord: keyword, jobAddress: "China\\Guangdong-Shenzhen" },
    });
    const list: any[] = d?.data?.result ?? [];
    return {
      total: d?.data?.pageVO?.totalRows ?? list.length,
      jobs: list.map((x) => ({
        id: String(x.jobId),
        title: String(x.jobName ?? ""),
        city: String(x.workPlace || x.jobAddress || ""),
        dept: x.deptName ? String(x.deptName).slice(0, 12) : undefined,
        jd: jd(x.mainBusiness, x.jobRequire),
        tags: [x.jobFamilyName].filter(Boolean),
        url: `https://career.huawei.com/cn/job-details?advertisementId=${x.advertisementId ?? ""}`,
        updatedAt: x.lastUpdateDate ? String(x.lastUpdateDate) : undefined,
      })),
    };
  },
};

/** vivo：深圳要传中文「深圳」 */
export const vivo: OfficialSource = {
  id: "vivo", company: "vivo", pageSize: 50,
  async search(keyword, page) {
    const d = await http("https://hr.vivo.com/api/social/webSite/portal/page", {
      method: "POST",
      headers: { referer: "https://hr.vivo.com/jobs", origin: "https://hr.vivo.com" },
      json: { keyword, page, max_results: 50, city_code_list: ["深圳"], yoe_list: [], company_id: 1, group_id: 1 },
    });
    const list: any[] = Array.isArray(d?.data) ? d.data : [];
    return {
      total: d?.meta?.total ?? list.length,
      jobs: list.map((x) => ({
        id: String(x.job_id),
        title: String(x.job_title ?? ""),
        city: (x.job_location_list ?? []).map((c: any) => c.city).filter(Boolean).join("/"),
        dept: x.requirement_org_name ? String(x.requirement_org_name).slice(0, 12) : undefined,
        jd: textify(x.job_desc),
        tags: [x.job_category].filter(Boolean),
        url: `https://hr.vivo.com/job-detail?_irjid=${x.job_id}`,
        updatedAt: ms(x.publish_timestamp),
      })),
    };
  },
};

/** 网易：城市参数对匿名调用无效，只能本地按深圳（131）过滤；每页最多 200，只取第一页 */
export const netease: OfficialSource = {
  id: "netease", company: "网易", pageSize: 200,
  async search(keyword, page) {
    if (page > 1) return { jobs: [], total: 0 };
    const d = await http("https://hr.163.com/api/hr163/position/queryPage", {
      method: "POST",
      headers: { referer: "https://hr.163.com/job-list.html", origin: "https://hr.163.com" },
      json: { currentPage: 1, pageSize: 200, workType: "0", keyword },
    });
    const list: any[] = (d?.data?.list ?? []).filter((x: any) => (x.workPlaceList ?? []).includes(131) || /深圳/.test((x.workPlaceNameList ?? []).join("")));
    return {
      total: list.length,
      jobs: list.map((x) => ({
        id: String(x.id),
        title: String(x.name ?? ""),
        city: (x.workPlaceNameList ?? []).join("/"),
        dept: String(x.firstDepName || x.productName || "").slice(0, 12) || undefined,
        jd: jd(x.description, x.requirement),
        url: `https://hr.163.com/job-detail.html?id=${x.id}`,
        updatedAt: ms(x.updateTime),
      })),
    };
  },
};

/** 京东：城市只能筛到广东省（44）；官网没有单独的详情页，JD 在列表里 */
export const jd_com: OfficialSource = {
  id: "jd", company: "京东", pageSize: 50,
  async search(keyword, page) {
    const list: any[] = await http("https://zhaopin.jd.com/web/job/job_list", {
      method: "POST",
      headers: { referer: "https://zhaopin.jd.com/web/job/job_info_list/3", "x-requested-with": "XMLHttpRequest", origin: "https://zhaopin.jd.com" },
      form: { pageIndex: page, pageSize: 50, jobSearch: keyword, workCityJson: '["44"]', jobTypeJson: "[]", depTypeJson: "[]" },
    });
    const arr = Array.isArray(list) ? list : [];
    return {
      total: arr.length < 50 ? (page - 1) * 50 + arr.length : page * 50 + 1,
      jobs: arr.map((x) => ({
        id: String(x.id),
        title: String(x.positionNameOpen || x.positionName || ""),
        city: String(x.workCity ?? ""),
        dept: x.positionDeptName ? String(x.positionDeptName).slice(0, 12) : undefined,
        jd: jd(x.workContent, x.qualification),
        url: "https://zhaopin.jd.com/web/job/job_info_list/3",
        updatedAt: x.formatPublishTime ? String(x.formatPublishTime) : undefined,
      })),
    };
  },
};
