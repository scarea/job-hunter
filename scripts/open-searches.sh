#!/bin/bash
# 每天早上用「系统默认浏览器」打开招聘站搜索页。
#
# ⭐ 关键词来自「关键词策略」当天选出的词（UCB 排名），不是你手填的固定词。
#    服务没起来时才退回环境变量里的兜底词。
#
# ⚠️ 只做一件事：调用 macOS 的 `open` 打开 URL。
#    不注入脚本、不读取页面、不模拟操作 —— 平台看到的就是你自己点开了几个网页。
#    真正的取数由你手动点书签完成（见看板「从 BOSS/猎聘 导入」）。
set -uo pipefail

PORT="${PORT:-5173}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 用装了采集脚本的浏览器打开（默认 Google Chrome）；.env 里 SEARCH_BROWSER 可改，比如 SEARCH_BROWSER=ego
if [ -z "${SEARCH_BROWSER:-}" ] && [ -f "$PROJECT_DIR/.env" ]; then
  SEARCH_BROWSER="$(grep -E '^SEARCH_BROWSER=' "$PROJECT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"')"
fi
BROWSER="${SEARCH_BROWSER:-Google Chrome}"
open_url() { open -a "$BROWSER" "$1" 2>/dev/null || open "$1" 2>/dev/null; }
API="http://127.0.0.1:$PORT"

# 优先问服务要「今天该搜哪些词」
PLAN=$(curl -s -m 6 "$API/api/open-searches/plan" 2>/dev/null)
URLS=$(printf '%s' "$PLAN" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for u in d.get('urls',[]): print(u['url'])
" 2>/dev/null)

if [ -n "$URLS" ]; then
  KW=$(printf '%s' "$PLAN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(' / '.join(d.get('keywords',[])))" 2>/dev/null)
  echo "用策略选出的词：$KW"
  while IFS= read -r u; do [ -n "$u" ] && open_url "$u"; sleep 0.4; done <<< "$URLS"
  osascript -e "display notification \"关键词：$KW\" with title \"Job Hunter：搜索页已打开\" sound name \"Glass\"" >/dev/null 2>&1 || true
else
  # 服务没起来：退回兜底词
  KW="${SEARCH_KEYWORDS:-AI网关,模型接入,推理服务}"
  echo "服务未响应，用兜底关键词：$KW"
  IFS=',' read -ra ARR <<< "$KW"
  for k in "${ARR[@]}"; do
    open_url "https://www.zhipin.com/web/geek/jobs?query=$(printf %s "$k" | jq -sRr @uri 2>/dev/null || printf %s "$k")&city=101280600"
    sleep 0.4
  done
fi
