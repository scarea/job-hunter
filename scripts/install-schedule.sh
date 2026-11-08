#!/bin/bash
# 安装两个后台服务：
#   1. com.jobhunter.daily  —— 每天 04:00 采集+打分+出推荐
#   2. com.jobhunter.web    —— 看板常驻（崩溃自动重启）
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"

# ⭐ launchd 的 PATH 极干净，必须写死 node/pnpm 所在目录
NODE_BIN="$(dirname "$(which node)")"
PNPM_BIN="$(which pnpm)"
echo "检测到 node: $NODE_BIN"
echo "检测到 pnpm: $PNPM_BIN"
mkdir -p "$AGENTS" "$PROJECT_DIR/logs"

# ---------- 1. 每日 4:00 ----------
cat > "$AGENTS/com.jobhunter.daily.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobhunter.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PROJECT_DIR/scripts/run-daily.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/launchd-daily.out</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/launchd-daily.err</string>
  <key>RunAtLoad</key><false/>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- 安装时检测到的 node 目录（nvm/fnm 装的 node 不在 launchd 默认 PATH 里） -->
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

# ---------- 2. 看板常驻 ----------
cat > "$AGENTS/com.jobhunter.web.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobhunter.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd "$PROJECT_DIR" &amp;&amp; export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:\$PATH" &amp;&amp; exec "$PNPM_BIN" web</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/web.out</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/web.err</string>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENTS/com.jobhunter.daily.plist" 2>/dev/null || true
launchctl unload "$AGENTS/com.jobhunter.web.plist" 2>/dev/null || true
launchctl load "$AGENTS/com.jobhunter.daily.plist"
launchctl load "$AGENTS/com.jobhunter.web.plist"


# ---------- 3. 每天早上打开搜索页（可选，OPEN_SCHEDULE=1 时安装）----------
if [ "${OPEN_SCHEDULE:-0}" = "1" ]; then
cat > "$AGENTS/com.jobhunter.opensearch.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobhunter.opensearch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PROJECT_DIR/scripts/open-searches.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${OPEN_HOUR:-8}</integer>
    <key>Minute</key><integer>${OPEN_MINUTE:-30}</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST
  launchctl unload "$AGENTS/com.jobhunter.opensearch.plist" 2>/dev/null || true
  launchctl load "$AGENTS/com.jobhunter.opensearch.plist"
  echo "   · 每天 ${OPEN_HOUR:-8}:${OPEN_MINUTE:-30} 打开三个搜索页（只开网页，不抓取）"
fi

echo "✅ 已安装："
echo "   · 每天 04:00 自动采集打分   → logs/daily-YYYY-MM-DD.log"
echo "   · 看板常驻 http://localhost:5173"
echo
echo "查看状态： launchctl list | grep jobhunter"
echo "立即试跑： launchctl start com.jobhunter.daily"
echo "卸载：     bash scripts/uninstall-schedule.sh"
