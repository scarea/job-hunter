#!/bin/bash
# 从用户脚本生成 MV3 内容脚本（同一份逻辑，避免两处维护）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$DIR/src/server/public/job-hunter.user.js"
OUT="$DIR/extension/content.js"
# 去掉 ==UserScript== 头，保留实现
awk 'BEGIN{skip=0} /^\/\/ ==UserScript==/{skip=1;next} /^\/\/ ==\/UserScript==/{skip=0;next} skip==0{print}' "$SRC" > "$OUT"
echo "已生成 $OUT ($(wc -l < "$OUT") 行)"
