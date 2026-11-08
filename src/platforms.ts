import type { BrowserContext, Page } from "playwright";
import { db } from "./db.js";
import type { Platform } from "./types.js";

/**
 * 平台元信息 + 会话状态管理
 *
 * 「登录」只是手段，真正要管的是每个平台「现在能不能采」：
 *   ok           能采（loggedIn 区分匿名可用 / 已登录）
 *   need_verify  被人机验证 / 风控拦截，需要人工过一次
 *   need_login   遇到登录墙，需要登录
 *   unknown      还没跑过
 *
 * 状态由采集结果自动写入（不额外请求平台）；被拦后进入冷却期，定时任务跳过该平台，
 * 避免在被拦状态下反复请求、把风控等级越推越高。人工「去处理」成功后状态立即恢复。
 */

export interface PlatformMeta {
  name: string;
  /** browser = 走浏览器、有登录/验证问题；api = 公开接口，零账号风险 */
  kind: "browser" | "api";
  home: string;
  loginUrl: string;
  /** cookie 所在域名（用于读 cookie） */
  cookieUrl: string;
  /** 任一 cookie 存在即视为已登录；空数组表示该平台不靠 cookie 判断 */
  loginCookies: string[];
  /** 页面上出现这些元素 = 未登录（cookie 判断不了的平台用） */
  loggedOutSelectors: string[];
  /** URL 命中 = 被拦截（人机验证 / 风控） */
  verifyUrl: RegExp;
  /** URL 命中 = 登录墙 */
  loginWallUrl: RegExp;
}

export const PLATFORMS: Record<Platform, PlatformMeta> = {
  boss: {
    name: "BOSS直聘",
    kind: "browser",
    home: "https://www.zhipin.com/",
    loginUrl: "https://www.zhipin.com/web/user/?ka=header-login",
    cookieUrl: "https://www.zhipin.com/",
    // 参考 loks666/get_jobs 的登录判断
    loginCookies: ["wt2", "zp_at", "bst", "geek_zp_token"],
    loggedOutSelectors: [],
    verifyUrl: /zhipin\.com\/web\/(passport\/zp\/verify|common\/security-check)|zhipin\.com\/web\/user\/safe/,
    loginWallUrl: /zhipin\.com\/web\/user\/(\?|$|#)/,
  },
  zhaopin: {
    name: "智联招聘",
    kind: "browser",
    home: "https://www.zhaopin.com/",
    loginUrl: "https://passport.zhaopin.com/login",
    cookieUrl: "https://www.zhaopin.com/",
    loginCookies: ["at", "rt"],
    loggedOutSelectors: ["a.home-header__c-no-login"],
    verifyUrl: /zhaopin\.com\/.*(verify|captcha)/,
    loginWallUrl: /passport\.zhaopin\.com\/login/,
  },
  liepin: {
    name: "猎聘",
    kind: "browser",
    home: "https://www.liepin.com/",
    loginUrl: "https://www.liepin.com/login",
    cookieUrl: "https://www.liepin.com/",
    // 实测（2026-11）：登录后有持久 cookie lt_auth / liepin_login_valid，重启浏览器不会掉
    loginCookies: ["lt_auth", "liepin_login_valid"],
    loggedOutSelectors: ["#header-quick-menu-login"],
    verifyUrl: /safe\.liepin\.com|liepin\.com\/.*(verify|intercept)/,
    // 匿名访问过多后，搜索页会被重定向到 wow.liepin.com 的登录落地页
    loginWallUrl: /passport\.liepin\.com|liepin\.com\/login|wow\.liepin\.com/,
  },
  official: {
    name: "大厂官网",
    kind: "api",
    home: "https://www.baidu.com/",
    loginUrl: "https://www.baidu.com/",
    cookieUrl: "https://www.baidu.com/",
    loginCookies: [],
    loggedOutSelectors: [],
    verifyUrl: /a^/,
    loginWallUrl: /a^/,
  },
  tencent: {
    name: "腾讯招聘",
    kind: "api",
    home: "https://careers.tencent.com/",
    loginUrl: "https://careers.tencent.com/",
    cookieUrl: "https://careers.tencent.com/",
    loginCookies: [],
    loggedOutSelectors: [],
    verifyUrl: /a^/, // 公开接口，没有验证页
    loginWallUrl: /a^/,
  },
};

export const platformName = (p: Platform) => PLATFORMS[p].name;
export const platformHome = (p: Platform) => PLATFORMS[p].home;

// ---------------- 拦截检测 ----------------

export type BlockKind = "need_verify" | "need_login";
export interface BlockInfo { kind: BlockKind; reason: string; url: string }

/** 页面正文里的验证特征（URL 认不出来时兜底，比如智联的 EdgeOne 是同 URL 内嵌的） */
const VERIFY_TEXT: [RegExp, string][] = [
  [/正在验证连接安全性|勾选下方复选框|Protected by EdgeOne/i, "人机验证（EdgeOne）"],
  [/访问验证|安全验证|滑动验证|拖动滑块|verify you are human/i, "人机验证"],
  [/账号异常|您的账号存在风险|您的环境存在异常|请完成验证/, "账号风控"],
];

/** 页面正文里的登录墙特征（URL 认不出来时兜底）：整页只剩登录框、没有岗位内容 */
const LOGIN_WALL_TEXT = /我已有账号，直接登录|登录后查看更多|请登录后(查看|继续)|扫码登录.{0,20}获取验证码/;

/** 检查当前页面是否被拦截。只读：不点击、不跳转 */
export async function detectBlock(page: Page, platform: Platform): Promise<BlockInfo | null> {
  const meta = PLATFORMS[platform];
  const url = page.url();
  if (meta.verifyUrl.test(url)) return { kind: "need_verify", reason: "跳转到了验证页", url };
  if (meta.loginWallUrl.test(url)) return { kind: "need_login", reason: "跳转到了登录页", url };
  try {
    const { text, len } = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return { text: t.slice(0, 1500), len: t.length };
    });
    for (const [re, reason] of VERIFY_TEXT) if (re.test(text)) return { kind: "need_verify", reason, url };
    // 正常搜索页也可能有浮动登录框，只有整页基本只剩登录框（文字很少）才算登录墙
    if (len < 2500 && LOGIN_WALL_TEXT.test(text)) return { kind: "need_login", reason: "要求登录才能继续", url };
  } catch { /* 页面正在跳转，下次再看 */ }
  return null;
}

/** 接口返回体里的拒绝信息 → 拦截类型（BOSS code 37 = 环境异常） */
export function classifyApiRejection(message: string, code?: unknown): BlockKind | null {
  // BOSS：35 = IP 异常，36/37 = 环境异常，都要过一次验证
  if (["35", "36", "37"].includes(String(code)) || /环境|异常|验证|频繁|风控/.test(message)) return "need_verify";
  if (/登录|login/i.test(message)) return "need_login";
  return null;
}

// ---------------- 登录检测 ----------------

/**
 * 是否已登录：
 *  - 有登录 cookie 的平台看 cookie（不需要打开页面）
 *  - 否则需要传入一个停在该平台页面上的 page，看「登录/注册」入口在不在
 * 判断不了返回 null
 */
export async function isLoggedIn(ctx: BrowserContext, platform: Platform, page?: Page): Promise<boolean | null> {
  const meta = PLATFORMS[platform];
  if (meta.loginCookies.length) {
    const names = new Set((await ctx.cookies(meta.cookieUrl)).map((c) => c.name));
    if (meta.loginCookies.some((n) => names.has(n))) return true;
    if (!meta.loggedOutSelectors.length) return false;
  }
  if (page && meta.loggedOutSelectors.length && page.url().includes(new URL(meta.home).hostname.replace(/^www\./, ""))) {
    try {
      const loggedOut = await page.locator(meta.loggedOutSelectors.join(",")).count();
      return loggedOut === 0;
    } catch { return null; }
  }
  return null;
}

// ---------------- 状态存储 ----------------

export type PlatformState = "ok" | BlockKind | "unknown";

export interface PlatformStatus {
  platform: Platform;
  name: string;
  state: PlatformState;
  loggedIn: boolean | null;
  reason: string;
  /** 被拦时的页面地址，「去处理」直接打开它 */
  url: string;
  updatedAt: string | null;
  lastOkAt: string | null;
  lastFound: number | null;
}

db.exec(`
CREATE TABLE IF NOT EXISTS platform_status (
  platform TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'unknown',
  logged_in INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  last_ok_at TEXT,
  last_found INTEGER
);
`);

interface Row { platform: string; state: string; logged_in: number | null; reason: string; url: string; updated_at: string | null; last_ok_at: string | null; last_found: number | null }

export function getStatus(platform: Platform): PlatformStatus {
  const r = db.prepare("SELECT * FROM platform_status WHERE platform = ?").get(platform) as Row | undefined;
  return {
    platform, name: platformName(platform),
    state: (r?.state as PlatformState) ?? "unknown",
    loggedIn: r?.logged_in == null ? null : r.logged_in === 1,
    reason: r?.reason ?? "", url: r?.url ?? "",
    updatedAt: r?.updated_at ?? null, lastOkAt: r?.last_ok_at ?? null, lastFound: r?.last_found ?? null,
  };
}

export function allStatuses(): PlatformStatus[] {
  return (Object.keys(PLATFORMS) as Platform[]).map(getStatus);
}

function upsert(platform: Platform, fields: Partial<Row>) {
  const cur = db.prepare("SELECT platform FROM platform_status WHERE platform = ?").get(platform);
  if (!cur) db.prepare("INSERT INTO platform_status (platform) VALUES (?)").run(platform);
  const keys = Object.keys(fields) as (keyof Row)[];
  if (!keys.length) return;
  db.prepare(`UPDATE platform_status SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE platform = ?`)
    .run(...keys.map((k) => fields[k] as any), platform);
}

const now = () => new Date().toISOString();

/** 采集成功：清掉拦截状态 */
export function markOk(platform: Platform, opts: { found?: number; loggedIn?: boolean | null } = {}) {
  upsert(platform, {
    state: "ok", reason: "", url: "", updated_at: now(), last_ok_at: now(),
    ...(opts.found != null ? { last_found: opts.found } : {}),
    ...(opts.loggedIn != null ? { logged_in: opts.loggedIn ? 1 : 0 } : {}),
  });
}

/** 被拦截：记下原因和页面地址 */
export function markBlocked(platform: Platform, info: BlockInfo) {
  upsert(platform, { state: info.kind, reason: info.reason, url: info.url, updated_at: now() });
  console.log(`  ⛔ ${platformName(platform)}：${info.reason}（${info.kind === "need_login" ? "需要登录" : "需要验证"}）`);
}

export function setLoggedIn(platform: Platform, loggedIn: boolean | null) {
  if (loggedIn == null) return;
  upsert(platform, { logged_in: loggedIn ? 1 : 0 });
}

/** 被拦后的冷却期：期间定时任务不再碰这个平台，等人工处理或自然解封 */
export const COOLDOWN_HOURS = parseFloat(process.env.BLOCK_COOLDOWN_HOURS || "12");

export function inCooldown(platform: Platform): PlatformStatus | null {
  const s = getStatus(platform);
  if (s.state !== "need_verify" && s.state !== "need_login") return null;
  if (!s.updatedAt) return null;
  const ageH = (Date.now() - new Date(s.updatedAt).getTime()) / 3600_000;
  return ageH < COOLDOWN_HOURS ? s : null;
}

/** 本次运行中是否被拦（运行开始后才写入的拦截状态） */
export function blockedSince(platform: Platform, sinceIso: string): PlatformStatus | null {
  const s = getStatus(platform);
  return (s.state === "need_verify" || s.state === "need_login") && s.updatedAt && s.updatedAt >= sinceIso ? s : null;
}
