import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";
import type { Platform } from "../types.js";

/**
 * 只读浏览器会话
 * - 复用本机 Chrome（channel: chrome），不额外下载 Chromium
 * - 持久化 userDataDir：登录态、验证通过的 cookie 都保存在 .chrome-profile
 * - ⚠️ 本模块不做任何「投递 / 打招呼」点击，只导航 + 读取
 *
 * 浏览器模式：
 *   默认            有界面 + 窗口挪到屏幕外：对页面来说是真实有头浏览器，又不打扰你
 *   HEADLESS=true   无头：BOSS/猎聘 能识别，只建议调试用
 *   visible=true    可见窗口：「去处理」登录/验证时用
 */
let ctx: BrowserContext | null = null;

export const PROFILE_DIR = path.resolve(process.cwd(), ".chrome-profile");
const SESSION_STORAGE_FILE = path.resolve(process.cwd(), ".cache", "session-storage.json");

export async function getContext(opts: { visible?: boolean } = {}): Promise<BrowserContext> {
  if (ctx) return ctx;
  const headless = !opts.visible && process.env.HEADLESS === "true";
  const offscreen = !opts.visible && process.env.OFFSCREEN !== "false";

  const args = ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"];
  if (!headless && offscreen) args.push("--window-position=-32000,-32000", "--window-size=1440,900");
  if (opts.visible) args.push("--window-size=1280,860");

  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless,
    viewport: headless ? { width: 1440, height: 900 } : null,
    args,
  });
  await restoreSessionStorage(ctx);
  return ctx;
}

export async function newPage(opts: { visible?: boolean } = {}): Promise<Page> {
  const c = await getContext(opts);
  const pages = c.pages();
  const p = pages.find((x) => x.url() === "about:blank") ?? (await c.newPage());
  p.setDefaultTimeout(20_000);
  return p;
}

export async function closeBrowser() {
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
}

// ---------------- sessionStorage 持久化 ----------------
// 猎聘的登录 token 在 sessionStorage 里，Chrome 重启就没了，只存 cookie 会掉登录。
// 登录成功后把 sessionStorage 导出到 .cache/，之后每次打开页面前写回去。

type SessionDump = Record<string, Record<string, string>>; // origin → items

function readSessionDump(): SessionDump {
  try { return JSON.parse(fs.readFileSync(SESSION_STORAGE_FILE, "utf8")); } catch { return {}; }
}

export async function saveSessionStorage(page: Page) {
  try {
    const origin = new URL(page.url()).origin;
    const items = (await page.evaluate(() => {
      const o: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i)!; o[k] = sessionStorage.getItem(k) ?? ""; }
      return o;
    })) as Record<string, string>;
    if (!Object.keys(items).length) return;
    const dump = readSessionDump();
    dump[origin] = items;
    fs.mkdirSync(path.dirname(SESSION_STORAGE_FILE), { recursive: true });
    fs.writeFileSync(SESSION_STORAGE_FILE, JSON.stringify(dump), { mode: 0o600 });
  } catch { /* 页面已关闭等，忽略 */ }
}

async function restoreSessionStorage(c: BrowserContext) {
  const dump = readSessionDump();
  if (!Object.keys(dump).length) return;
  await c.addInitScript((d: SessionDump) => {
    const items = d[location.origin];
    if (!items) return;
    try {
      for (const [k, v] of Object.entries(items)) if (sessionStorage.getItem(k) == null) sessionStorage.setItem(k, v);
    } catch { /* 无权限 */ }
  }, dump);
}

// ---------------- 节奏控制 ----------------

export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** 随机延迟 */
export function jitter(min = 800, max = 2000) {
  return sleep(min + Math.random() * (max - min));
}

/**
 * 各平台的请求间隔（毫秒）。参考开源项目实测：
 * BOSS 翻页 12–22s、详情 10–25s；猎聘 1 分钟内翻 12 页就会触发验证。
 * 慢是为了不被封：凌晨跑，多花十几分钟无所谓。
 */
const PACE: Record<Platform, { page: [number, number]; detail: [number, number] }> = {
  boss: { page: [12_000, 22_000], detail: [10_000, 25_000] },
  liepin: { page: [10_000, 18_000], detail: [10_000, 20_000] },
  zhaopin: { page: [1_500, 3_000], detail: [4_000, 8_000] },
  tencent: { page: [800, 1_500], detail: [0, 0] },
  official: { page: [1_000, 2_000], detail: [300, 800] }, // 节奏在适配器内部控制，这里是关键词之间的间隔
};
export const pace = (p: Platform, kind: "page" | "detail") => jitter(...PACE[p][kind]);

/** 像人一样分几次滚动（触发懒加载 / 无限滚动），只读 */
export async function humanScroll(page: Page, times = 3) {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 600 + Math.random() * 500).catch(() => {});
    await sleep(900 + Math.random() * 900);
  }
}

/** 兼容旧调用 */
export const autoScroll = humanScroll;
