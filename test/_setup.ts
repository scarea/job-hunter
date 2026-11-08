/**
 * 每个测试文件第一行 import 它：
 *  - 切到一个全新的临时目录（db.ts 按 cwd 建库，所以每个测试文件都有自己的空数据库，绝不碰真实数据）
 *  - 清掉会影响结果的环境变量（API key、个人画像等），用固定的默认画像：深圳、期望 25K / 理想 30K
 *  - 没有 API key → 不会调用 LLM，测试不花钱、可离线跑
 * ⚠️ 必须是第一个 import：ESM 按 import 顺序执行，之后 import 的模块才会在临时目录里建库。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-test-"));
process.chdir(dir);
for (const k of Object.keys(process.env)) {
  if (/^(DEEPSEEK_|TARGET_|CITIES$|ACCEPT_REMOTE$|MUST_HAVE$|AVOID$|MIN_SCORE$|TOP_N$|MAX_PER_COMPANY$|STALE_DAYS$|QUERY_BUDGET$|DAILY_QUERIES$|SCORE_|OFFICIAL_|TENCENT_)/.test(k)) delete process.env[k];
}
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

export const TEST_DIR = dir;
