import type { OfficialSource } from "./types.js";
import { feishuSource } from "./feishu.js";
import { alibaba, antgroup } from "./alibaba.js";
import { meituan } from "./meituan.js";
import { baidu, huawei, vivo, netease, jd_com } from "./others.js";
import { sangfor } from "./sangfor.js";

/**
 * 已接入的公司（每家都实测过：无需登录、无签名）
 * 腾讯单独是一个平台（careers.tencent.com），不在这里。
 */
export const SOURCES: OfficialSource[] = [
  feishuSource({
    id: "bytedance", company: "字节跳动", host: "jobs.bytedance.com", portalType: 2,
    detailUrl: (id) => `https://jobs.bytedance.com/experienced/position/${id}/detail`,
  }),
  // 影石 Insta360：同样是飞书招聘，但社招站在 website-path: social（index 是实习站，只有 16 个南京实习岗）
  feishuSource({
    id: "insta360", company: "影石Insta360", host: "arashivision.jobs.feishu.cn", portalType: 2, websitePath: "social",
    detailUrl: (id) => `https://arashivision.jobs.feishu.cn/social/position/${id}/detail`,
  }),
  feishuSource({
    id: "xiaomi", company: "小米", host: "xiaomi.jobs.f.mioffice.cn", portalType: 6, websitePath: "index",
    detailUrl: (id) => `https://xiaomi.jobs.f.mioffice.cn/index/position/${id}/detail`,
  }),
  alibaba,
  antgroup,
  meituan,
  baidu,
  huawei,
  vivo,
  netease,
  jd_com,
  sangfor,
];
