import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { waitForTaskLock } from "../lock.js";
import { PROFILE_DIR, sleep } from "../collectors/base.js";
import { BROWSER_PLATFORMS } from "../collectors/index.js";
import { PLATFORMS, getStatus, markOk, platformName } from "../platforms.js";
import type { Platform } from "../types.js";

/**
 * 「去处理」：用一个【普通的 Chrome】打开平台页面，你登录 / 过验证，完成后自动检测、自动关闭
 *
 *   看板上点平台卡片的「去处理」/「登录」  ← 推荐
 *   pnpm login                 处理所有需要处理的平台（都正常时依次打开三个平台）
 *   pnpm login boss            只处理 BOSS
 *
 * 为什么不用 Playwright 打开：自动化控制的浏览器会被 BOSS / 猎聘识别，页面直接被清空或隐藏
 * （实测 BOSS 4 秒后变 about:blank，猎聘登录页白屏）。这里启动的是完全正常的 Chrome，
 * 不挂任何调试通道，只是和采集共用同一个配置目录，所以登录态会被采集复用。
 *
 * 判断完成：
 *   - 读配置目录里的 cookie 名（不读值）：BOSS / 智联看登录 cookie；其他平台看「登录后新出现的身份类 cookie」
 *   - 检测不到时：看板点「我已完成」，或在终端按回车
 * 完成后程序会正常关闭这个 Chrome（确保 cookie 写盘）。
 */
const TIMEOUT_MS = parseInt(process.env.LOGIN_TIMEOUT_SEC || "300", 10) * 1000;
const CHROME_APP = process.env.CHROME_APP || "Google Chrome";
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
export const doneFlag = (p: Platform) => path.join(CACHE_DIR, `login-done-${p}`);

/** cookie 所在的主域（读 cookie 库用） */
const COOKIE_DOMAIN: Partial<Record<Platform, string>> = { boss: "zhipin.com", zhaopin: "zhaopin.com", liepin: "liepin.com" };
/** 登录后才会出现的身份类 cookie 名特征（没有明确登录 cookie 的平台用） */
const IDENTITY_COOKIE = { test: (n: string) => /auth|access_?token|login|^uid$|user_?(id|name|info)|passport|^lt_/i.test(n) && !/xsrf|csrf/i.test(n) };

function parseTargets(): Platform[] {
  const args = process.argv.slice(2);
  const named = (args.find((a) => !a.startsWith("--")) || process.env.LOGIN_PLATFORM || "") as Platform | "";
  if (named) {
    if (!BROWSER_PLATFORMS.includes(named)) { console.error(`只能处理 ${BROWSER_PLATFORMS.join("/")}`); process.exit(2); }
    return [named];
  }
  const need = BROWSER_PLATFORMS.filter((p) => ["need_verify", "need_login"].includes(getStatus(p).state));
  return need.length ? need : BROWSER_PLATFORMS;
}

/** 终端里按回车 = 我已完成（只在交互终端里生效） */
let enterPressed = false;
if (process.stdin.isTTY) process.stdin.on("data", () => { enterPressed = true; });

/** 读配置目录里某个域名下的 cookie 名（复制一份再读，不影响正在运行的 Chrome；只读名字，不碰值） */
function cookieNames(domain: string): Set<string> {
  const src = path.join(PROFILE_DIR, "Default", "Cookies");
  if (!fs.existsSync(src)) return new Set();
  const tmp = path.join(os.tmpdir(), `jh-cookies-${process.pid}.db`);
  try {
    fs.copyFileSync(src, tmp);
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT name FROM cookies WHERE host_key LIKE ?").all(`%${domain}`) as { name: string }[];
    db.close();
    return new Set(rows.map((r) => r.name));
  } catch { return new Set(); } finally { fs.rmSync(tmp, { force: true }); }
}

/** 采集留下的自动化 Chrome 如果还占着配置目录，先关掉（同一个配置目录不能同时被两个 Chrome 打开） */
function freeProfile() {
  try {
    const out = execFileSync("pgrep", ["-f", `user-data-dir=${PROFILE_DIR}`], { encoding: "utf8" });
    for (const pid of out.split("\n").map(Number).filter(Boolean)) { try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ } }
  } catch { /* 没有占用 */ }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
}

/** 用这个配置目录运行的 Chrome 主进程 pid（没有就是 null） */
function profileChromePid(): number | null {
  try {
    const out = execFileSync("pgrep", ["-f", `Contents/MacOS/Google Chrome .*user-data-dir=${PROFILE_DIR}`], { encoding: "utf8" });
    return out.split("\n").map(Number).filter(Boolean)[0] ?? null;
  } catch { return null; }
}

/**
 * 用 macOS 的 open 启动：系统会把窗口激活到最前面。
 * （直接执行 Chrome 程序的话，从后台服务启动的窗口会被压在其他窗口后面，你看不到）
 */
async function openChrome(url: string): Promise<number | null> {
  execFileSync("open", ["-na", CHROME_APP, "--args",
    `--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "--new-window", url]);
  for (let i = 0; i < 20; i++) { const pid = profileChromePid(); if (pid) return pid; await sleep(500); }
  return null;
}

const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function closeChrome(pid: number | null) {
  if (!alive(pid)) return;
  process.kill(pid!, "SIGTERM"); // 正常退出，cookie 会写盘
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(500);
  if (alive(pid)) process.kill(pid!, "SIGKILL");
  await sleep(500);
}

async function handle(platform: Platform): Promise<boolean> {
  const meta = PLATFORMS[platform];
  const st = getStatus(platform);
  const domain = COOKIE_DOMAIN[platform]!;
  // BOSS 登录页本身就会过一遍验证；其他平台被拦时直接打开被拦的页面
  const startUrl = st.state === "need_verify" && platform !== "boss" && st.url ? st.url : meta.loginUrl;

  console.log(`\n▶ ${meta.name}：已用普通 Chrome 打开 ${startUrl}`);
  console.log(`  请在窗口里${st.state === "need_verify" ? "完成验证，然后" : ""}登录（扫码最快）。完成后会自动检测；检测不到就在看板点「我已完成」${process.stdin.isTTY ? "或按回车" : ""}。最多等 ${TIMEOUT_MS / 60000} 分钟。`);

  try { fs.rmSync(doneFlag(platform), { force: true }); } catch { /* ignore */ }
  enterPressed = false;
  freeProfile();
  await sleep(800);

  const before = cookieNames(domain);
  const chrome = await openChrome(startUrl);
  if (!chrome) console.log("  ⚠️ 没找到刚启动的 Chrome 进程，仍会按 cookie 检测登录");
  const deadline = Date.now() + TIMEOUT_MS;
  let how = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    if (enterPressed || fs.existsSync(doneFlag(platform))) { how = "你确认已完成"; break; }
    if (chrome && !alive(chrome)) { how = "Chrome 已退出"; break; }
    const now = cookieNames(domain);
    if (meta.loginCookies.some((n) => now.has(n) && !before.has(n))) { how = "检测到登录 cookie"; break; }
    if (!meta.loginCookies.length) {
      const fresh = [...now].filter((n) => !before.has(n) && IDENTITY_COOKIE.test(n));
      if (fresh.length) { how = `检测到新的身份 cookie（${fresh.join(" ")}）`; break; }
    }
  }
  try { fs.rmSync(doneFlag(platform), { force: true }); } catch { /* ignore */ }

  if (!how) {
    await closeChrome(chrome);
    console.log(`  ⏱ 超时，${meta.name} 保持原状态。随时可以再点一次「去处理」。`);
    return false;
  }
  console.log(`  ${how}，正在关闭窗口…`);
  await sleep(2500); // 给页面一点时间把 cookie 写完
  await closeChrome(chrome);

  const after = cookieNames(domain);
  const loggedIn = meta.loginCookies.length
    ? meta.loginCookies.some((n) => after.has(n))
    : [...after].some((n) => !before.has(n) && IDENTITY_COOKIE.test(n)) || null;
  markOk(platform, { loggedIn });
  console.log(`  ✅ ${meta.name} 已恢复${loggedIn ? "（已登录）" : loggedIn === false ? "（未检测到登录 cookie，按匿名可用处理）" : ""}`);
  console.log(`  诊断：登录后新增的 cookie 名 ${[...after].filter((n) => !before.has(n)).join(" ") || "无"}`);
  return true;
}

async function main() {
  await waitForTaskLock("login"); // 每日任务在跑就排队，结束后自动弹窗
  const targets = parseTargets();
  console.log(`🔐 去处理：${targets.map(platformName).join("、")}`);
  let ok = 0;
  for (const p of targets) if (await handle(p)) ok++;
  console.log(`\n🎉 完成 ${ok}/${targets.length}`);
  process.exit(0); // stdin 监听会让进程挂着
}

main().catch((e) => { console.error(e); process.exit(1); });
