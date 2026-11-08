import type { Collector, Platform } from "../types.js";
import { bossCollector } from "./boss.js";
import { zhaopinCollector } from "./zhaopin.js";
import { liepinCollector } from "./liepin.js";
import { tencentCollector } from "./tencent.js";
import { officialCollector } from "./official/index.js";

export const COLLECTORS: Record<Platform, Collector> = {
  boss: bossCollector,
  zhaopin: zhaopinCollector,
  liepin: liepinCollector,
  tencent: tencentCollector,
  official: officialCollector,
};

/** 采集顺序：零风险的官网接口在前，需要浏览器的平台在后 */
/** 全部平台（含需要浏览器自动化的） */
export const ALL_PLATFORMS: Platform[] = ["tencent", "official", "zhaopin", "liepin", "boss"];

/**
 * ⭐ 自动采集范围：只跑「公开接口、免登录、零账号风险」的平台
 *
 * tencent / official 是公司官网的公开职位接口，没有登录、没有签名、不涉及机器人检测。
 *
 * 以下平台被排除，原因是它们会主动识别并拦截自动化浏览器（实测：打开搜索页直接被清空成 about:blank），
 * 而绕过检测属于规避平台的机器人检测机制，不做。
 * 需要时请在页面上手动点「跑一次」（你在场、由你决定）。
 */
export const AUTO_PLATFORMS: Platform[] = ["tencent", "official", "zhaopin"];

/**
 * 需要人工在场的平台
 * 智联已加回自动采集：它走的是接口回放（captured XHR + cookie），实测稳定，
 * 不触发人机验证；一旦回放失败会自己退回 DOM，届时再看状态。
 */
export const MANUAL_PLATFORMS: Platform[] = ["liepin", "boss"];

/** 走浏览器、有封号/验证风险的平台 */
export const BROWSER_PLATFORMS: Platform[] = ["boss", "zhaopin", "liepin"];
