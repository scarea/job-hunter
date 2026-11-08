#!/bin/bash
# 每天备份数据库，保留 14 天。
#
# 为什么不用 cp：数据库是 WAL 模式，最近的写入可能还在 jobs.db-wal 里，
# 直接复制 jobs.db 会拿到一份“缺最近改动”的旧数据。
# sqlite3 的 .backup 会把 WAL 合并成一份完整一致的快照。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$DIR/data/jobs.db"
OUT="$DIR/data/backup"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

[ -f "$DB" ] || { echo "数据库不存在: $DB"; exit 1; }
mkdir -p "$OUT"

STAMP=$(date +%Y-%m-%d)
DEST="$OUT/jobs-$STAMP.db"

# 同日重跑就覆盖，避免堆积
[ -f "$DEST" ] && rm -f "$DEST"

if ! sqlite3 "$DB" ".backup '$DEST'" 2>/dev/null; then
  echo "备份失败（sqlite3 .backup）"
  exit 1
fi

# 校验备份可用
if [ "$(sqlite3 "$DEST" 'PRAGMA integrity_check;' 2>/dev/null)" != "ok" ]; then
  echo "备份文件校验失败: ${DEST}"
  rm -f "$DEST"
  exit 1
fi

SIZE=$(du -h "$DEST" | cut -f1)
COUNT=$(sqlite3 "$DEST" "SELECT COUNT(*) FROM jobs" 2>/dev/null)
echo "已备份 ${DEST}（${SIZE}，${COUNT} 个岗位）"

# sqlite3 .backup 会留下空的 -wal/-shm 边车文件，清掉
rm -f "${DEST}-wal" "${DEST}-shm" 2>/dev/null

# 清理过期备份
find "$OUT" -name "jobs-*.db" -mtime +"$KEEP_DAYS" -delete 2>/dev/null
