import type { Page } from "playwright";
import type { Platform } from "../types.js";
import { jitter, humanScroll } from "./base.js";
import { DETAIL_INFO } from "./scripts.js";
import { fetchTencentDetail } from "./tencent.js";
import { fetchOfficialDetail } from "./official/index.js";
import { detectBlock, markBlocked } from "../platforms.js";

/**
 * 详情页抓取：拿 JD + 真实薪资
 * - 腾讯：走公开详情接口
 * - 其他：打开详情页读正文；BOSS 列表接口没有 JD，只能靠详情页
 * - 被拦截时返回 blocked，调用方停止该平台的详情抓取
 */
export interface DetailInfo {
  jd: string;
  salaryRaw: string;
  blocked?: boolean;
  /** 岗位已下线 / 链接失效 */
  closed?: boolean;
}

/** 已下线 / 404 页面的特征：这种页面的正文绝不能当 JD 存 */
const CLOSED_TEXT = /页面不小心走丢了|页面不存在|您访问的页面|职位已(关闭|下线|失效|过期|暂停)|该职位已|停止招聘|岗位已(下线|关闭)|招聘已结束|404 Not Found/;

/** 抽到的不是 JD 而是页脚 / 登录页（备案号、举报电话这类）：当成没拿到 */
const JUNK_JD = /ICP经营许可证|ICP备\d|公网安备|举报投诉|个人信息保护政策|用户服务协议/;
const isJunkJd = (jd: string) => JUNK_JD.test(jd) && jd.length < 800;

export async function fetchDetail(page: Page, platform: Platform, url: string, externalId = ""): Promise<DetailInfo> {
  if (platform === "official") {
    return { jd: await fetchOfficialDetail(externalId).catch(() => ""), salaryRaw: "" };
  }
  if (!url) return { jd: "", salaryRaw: "" };

  if (platform === "tencent") {
    const postId = new URL(url).searchParams.get("postId");
    return postId ? fetchTencentDetail(postId).catch(() => ({ jd: "", salaryRaw: "" })) : { jd: "", salaryRaw: "" };
  }

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await jitter(1500, 3000);

    const block = await detectBlock(page, platform);
    if (block) { markBlocked(platform, block); return { jd: "", salaryRaw: "", blocked: true }; }

    // 有些详情页需要滚一下才渲染正文，顺便模拟阅读
    const head = await page.evaluate(() => (document.body?.innerText || "").slice(0, 600)).catch(() => "");
    if (CLOSED_TEXT.test(head)) return { jd: "", salaryRaw: "", closed: true };

    await humanScroll(page, 2);
    const info = (await page.evaluate(DETAIL_INFO + `(${JSON.stringify(platform)})`)) as DetailInfo;
    if (CLOSED_TEXT.test(info.jd.slice(0, 300))) return { jd: "", salaryRaw: "", closed: true };
    if (isJunkJd(info.jd)) return { ...info, jd: "" };
    return info;
  } catch {
    return { jd: "", salaryRaw: "" };
  }
}
