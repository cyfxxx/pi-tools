#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$DIR/venv" ]; then
  echo "错误: 虚拟环境不存在 ($DIR/venv)"
  echo "请先运行 install.sh"
  exit 1
fi

source "$DIR/venv/bin/activate"

PID_FILE="$DIR/searxng.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "SearXNG 已在运行 (PID $(cat "$PID_FILE"))"
  exit 0
fi

# 确保 settings.yml 存在
if [ ! -f "$DIR/settings.yml" ]; then
  echo "错误: 未找到 $DIR/settings.yml"
  exit 1
fi

export SEARXNG_SETTINGS_PATH="$DIR/settings.yml"
export SEARXNG_DEBUG=0
export PYTHONPATH="$DIR/repo:$PYTHONPATH"

nohup granian searx.webapp:app \
  --interface wsgi \
  --host 127.0.0.1 \
  --port 8889 \
  --workers 2 \
  --blocking-threads 4 \
  > "$DIR/searxng.log" 2>&1 &

PID=$!
echo $PID > "$PID_FILE"
echo "SearXNG 已启动 (PID $PID)"
echo "日志: $DIR/searxng.log"
echo "API: http://127.0.0.1:8889"
