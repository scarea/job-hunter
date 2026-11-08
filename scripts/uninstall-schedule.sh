#!/bin/bash
set -uo pipefail
AGENTS="$HOME/Library/LaunchAgents"
for L in com.jobhunter.daily com.jobhunter.web; do
  launchctl unload "$AGENTS/$L.plist" 2>/dev/null || true
  rm -f "$AGENTS/$L.plist"
  echo "已卸载 $L"
done
