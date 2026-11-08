import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/**
 * 任务运行器：把 CLI 变成 web 后台任务，实时把 stdout 推给前端
 */

export type TaskKind = "daily" | "login" | "collect" | "score" | "report" | "companies";
export type TaskStatus = "idle" | "running" | "done" | "error";

export interface TaskState {
  id: string;
  kind: TaskKind;
  /** login 任务处理的是哪个平台（看板上对应卡片显示「处理中」） */
  platform?: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  lines: string[];
  error?: string;
}

let current: TaskState = {
  id: "",
  kind: "daily",
  status: "idle",
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  lines: [],
};

let child: ChildProcess | null = null;
let stopping = false;

const MAX_LINES = 800;

export function getState(): TaskState {
  return { ...current, lines: current.lines.slice(-MAX_LINES) };
}

export function isRunning() {
  return current.status === "running";
}

const CMDS: Record<TaskKind, { script: string; args: string[] }> = {
  daily: { script: "src/cli/daily.ts", args: [] },
  login: { script: "src/cli/login.ts", args: [] },
  collect: { script: "src/cli/collect.ts", args: [] },
  score: { script: "src/cli/score.ts", args: [] },
  report: { script: "src/cli/report.ts", args: [] },
  companies: { script: "src/cli/companies.ts", args: [] },
};

export function startTask(kind: TaskKind, extraEnv: Record<string, string> = {}, meta: { platform?: string } = {}): { ok: boolean; message: string } {
  if (isRunning()) return { ok: false, message: "已有任务在跑，请等它结束" };

  const cmd = CMDS[kind];
  if (!cmd) return { ok: false, message: `未知任务 ${kind}` };

  const env = { ...process.env, ...loadEnv(), ...extraEnv };
  // 登录必须可见
  if (kind === "login") { env.HEADLESS = "false"; env.OFFSCREEN = "false"; }

  current = {
    id: `${kind}-${Date.now()}`,
    kind,
    platform: meta.platform,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    lines: [`▶ 启动 ${kind} ...`],
  };

  const cwd = process.cwd();
  stopping = false;
  // 直接跑本地 tsx（不经 npx 中转）；detached 让子进程自成进程组，停止时能连同 Chrome 一起杀掉
  child = spawn(path.resolve(cwd, "node_modules/.bin/tsx"), [cmd.script, ...cmd.args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const push = (buf: Buffer) => {
    const text = buf.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) current.lines.push(line);
    }
    if (current.lines.length > MAX_LINES * 2) current.lines = current.lines.slice(-MAX_LINES);
  };

  child.stdout?.on("data", push);
  child.stderr?.on("data", push);

  child.on("close", (code) => {
    current.status = stopping ? "idle" : code === 0 ? "done" : "error";
    current.exitCode = code;
    current.finishedAt = new Date().toISOString();
    current.lines.push(stopping ? "⏹ 已停止" : code === 0 ? "✅ 任务完成" : `❌ 任务失败（exit ${code}）`);
    child = null;
    stopping = false;
  });

  child.on("error", (e) => {
    current.status = "error";
    current.error = e.message;
    current.finishedAt = new Date().toISOString();
    current.lines.push(`❌ ${e.message}`);
    child = null;
  });

  return { ok: true, message: `${kind} 已启动` };
}

/** 给整个进程组发信号（tsx → node → Chrome 一起），避免留下占着 .chrome-profile 的孤儿进程 */
function killGroup(pid: number, sig: NodeJS.Signals) {
  try { process.kill(-pid, sig); } catch { /* 进程组已经没了 */ }
}

/**
 * 停止：先 SIGTERM（任务会释放锁、让 Playwright 关浏览器），5 秒后还没退就 SIGKILL。
 * 状态保持 running 直到进程真正退出（close 事件），防止旧任务还没退干净就开新任务。
 */
export function stopTask(): boolean {
  if (!child?.pid || stopping) return false;
  stopping = true;
  const pid = child.pid;
  current.lines.push("⏹ 正在停止...");
  killGroup(pid, "SIGTERM");
  setTimeout(() => { if (child?.pid === pid) killGroup(pid, "SIGKILL"); }, 5000);
  return true;
}

function loadEnv(): Record<string, string> {
  try {
    const p = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(p)) return {};
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch { return {}; }
}

export { loadEnv };
