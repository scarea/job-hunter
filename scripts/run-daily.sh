#!/bin/bash
# 每日 4:00 由 launchd 调用
# 浏览器用有界面模式但窗口在屏幕外（不弹窗），登录态从 .chrome-profile 复用

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

LOG="$PROJECT_DIR/logs/daily-$(date +%Y-%m-%d).log"
mkdir -p "$PROJECT_DIR/logs"

# 失败时直接用 osascript 发通知：node 都没起来的话，daily.ts 里的通知发不出去
notify_fail() {
  osascript -e "display notification \"$1\" with title \"Job Hunter：每日任务失败\" sound name \"Basso\"" >/dev/null 2>&1 || true
}

{
  echo "=============================="
  echo "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================="

  # .env 由 Node（dotenv）自己加载；不要用 bash 去 source：值里有空格（如「后端开发 AI」）会被截断还会被当成命令执行

  # 不用 headless：BOSS / 猎聘能识别无头浏览器（开源项目实测「无头必被检测」）。
  # 用真实有界面的 Chrome，窗口放到屏幕外，不打扰你。需要 Mac 处于登录状态（锁屏没关系）。
  export HEADLESS="${DAILY_HEADLESS:-false}"
  export OFFSCREEN=true

  # 找 node/pnpm：launchd 的 PATH 很干净。
  #   1) install-schedule.sh 已把安装时的 node 目录写进 plist 的 PATH
  #   2) ⚠️ 只能「追加」，绝不能前置 homebrew：
  #      /opt/homebrew/bin/node 可能是另一个大版本（实测 v25），
  #      而 better-sqlite3 是按 v22 的 ABI 编译的 → ERR_DLOPEN_FAILED
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm"
  if ! command -v pnpm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
    nvm use default >/dev/null 2>&1 || true
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "❌ 找不到 node/pnpm（PATH=$PATH）。请重新运行 bash scripts/install-schedule.sh"
    notify_fail "找不到 node/pnpm，请重新运行 install-schedule.sh"
    exit 127
  fi
  echo "node: $(command -v node) ($(node -v))  pnpm: $(command -v pnpm)"

  # 能加载原生模块才算环境正常（better-sqlite3 是 ABI 相关的）
  if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    echo "❌ node 无法加载 better-sqlite3（多半是 node 大版本不匹配）"
    notify_fail "node 版本不匹配（$(node -v)），better-sqlite3 加载失败"
    exit 1
  fi

  pnpm run daily
  EXIT=$?

  echo "=============================="
  echo "结束时间: $(date '+%Y-%m-%d %H:%M:%S')  退出码: $EXIT"
  echo "=============================="
  [ "$EXIT" -ne 0 ] && notify_fail "退出码 $EXIT，详见 logs/daily-$(date +%Y-%m-%d).log"
  exit $EXIT
} >> "$LOG" 2>&1
