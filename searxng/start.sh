#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi}"

if [ ! -d "$DIR/venv" ]; then
  echo "错误: 虚拟环境不存在 ($DIR/venv)"
  echo "请先运行 $PI_HOME/scripts/rebuild.sh"
  exit 1
fi

# mkdir 锁包住「检查 PID → 启动」段：防并发双启均通过 kill -0 的 check-then-act 竞态
PID_FILE="$DIR/searxng.pid"
LOCK_DIR="$DIR/.start.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "另一个 start.sh 正在启动（锁 $LOCK_DIR 被占用），退出"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "SearXNG 已在运行 (PID $(cat "$PID_FILE"))"
  exit 0
fi

# 确保 settings.yml 存在
if [ ! -f "$DIR/settings.yml" ]; then
  echo "错误: 未找到 $DIR/settings.yml"
  exit 1
fi

# ═══════════════════════════════════════════════
# 启动 SearXNG
# ═══════════════════════════════════════════════
source "$DIR/venv/bin/activate"
export SEARXNG_SETTINGS_PATH="$DIR/settings.yml"
export SEARXNG_DEBUG=0
export PYTHONPATH="$DIR/repo:$PYTHONPATH"

if command -v granian >/dev/null 2>&1; then
  nohup granian searx.webapp:app \
    --interface wsgi \
    --host 127.0.0.1 \
    --port 8889 \
    --workers 2 \
    --blocking-threads 4 \
    > "$DIR/searxng.log" 2>&1 &
else
  # Termux/Android: granian (Rust) 无 wheel 无法源码构建，用 uvicorn WSGI 模式替代
  nohup uvicorn searx.webapp:app \
    --interface wsgi \
    --host 127.0.0.1 \
    --port 8889 \
    --workers 2 \
    > "$DIR/searxng.log" 2>&1 &
fi

PID=$!
echo $PID > "$PID_FILE"
echo "SearXNG 已启动 (PID $PID)"
echo "日志: $DIR/searxng.log"
echo "API: http://127.0.0.1:8889"
