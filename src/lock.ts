import fs from "node:fs";
import path from "node:path";

/**
 * 任务互斥锁（文件锁 + pid 存活检查）
 *
 * daily / collect / login / score 同一时间只能跑一个：
 *  - 浏览器任务共用 .chrome-profile，Chrome 不允许两个进程同时打开同一个配置目录
 *  - 两个打分任务会对同一批岗位重复调 LLM、重复入库
 *
 * 触发并发的典型场景：凌晨 4 点的 launchd 任务 + 看板上手点的任务 + 终端里手跑的任务。
 * 锁文件里存 pid；持有者进程已经不在了（崩溃 / 被 kill -9）就视为过期锁，直接接管。
 */
const LOCK_PATH = path.resolve(process.cwd(), "data", ".task.lock");

interface LockInfo { pid: number; task: string; startedAt: string }

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e.code === "EPERM"; } // EPERM = 进程存在但不是我们的
}

function readLock(): LockInfo | null {
  try { return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")); } catch { return null; }
}

/** 尝试拿锁：成功返回 null，被占用返回占用者信息 */
function tryAcquire(task: string): LockInfo | null {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  const info: LockInfo = { pid: process.pid, task, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：文件已存在就失败，保证原子性
      fs.writeFileSync(LOCK_PATH, JSON.stringify(info), { flag: "wx" });
      const release = () => {
        const cur = readLock();
        if (cur?.pid === process.pid) { try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ } }
      };
      process.on("exit", release);
      // 默认的 SIGINT/SIGTERM 处理不会触发 'exit'，这里补上。
      // 先释放锁，再留 2 秒给 Playwright 自己的信号处理去关 Chrome，然后退出（退出码沿用 shell 约定）
      const onSignal = (code: number) => () => { release(); setTimeout(() => process.exit(code), 2000); };
      process.once("SIGINT", onSignal(130));
      process.once("SIGTERM", onSignal(143));
      return null;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const holder = readLock();
      if (holder && isAlive(holder.pid)) return holder;
      // 过期锁：持有者已经不在了
      console.warn(`⚠️ 清理过期任务锁（${holder?.task ?? "未知"}，pid ${holder?.pid ?? "?"} 已退出）`);
      try { fs.unlinkSync(LOCK_PATH); } catch { /* 被别人抢先清理了也没关系 */ }
    }
  }
  return { pid: -1, task: "未知", startedAt: "" };
}

/** 拿锁；拿不到直接退出进程（退出码 75 = EX_TEMPFAIL，稍后再试） */
export function acquireTaskLock(task: string): void {
  const holder = tryAcquire(task);
  if (!holder) return;
  console.error(`⛔ 已有任务在运行：${holder.task}（pid ${holder.pid}，开始于 ${holder.startedAt}）。等它结束后再跑。`);
  process.exit(75);
}

/**
 * 排队拿锁：被占用就等它结束（用于「去处理」：你点了就不用再点第二次，
 * 每日任务一结束自动弹窗）。超过 maxMs 还没轮到就退出。
 */
export async function waitForTaskLock(task: string, maxMs = 60 * 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let announced = "";
  for (;;) {
    const holder = tryAcquire(task);
    if (!holder) return;
    if (announced !== holder.task) {
      console.log(`⏳ 排队中：${holder.task} 任务正在运行，它结束后自动开始（不用再点）`);
      announced = holder.task;
    }
    if (Date.now() > deadline) { console.error("⛔ 等太久了，已取消。稍后再点一次。"); process.exit(75); }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
