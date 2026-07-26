#!/usr/bin/env bash
# 启动本地 SearXNG 服务
# 优先委托给 ~/.pi/searxng/start.sh，若不存在则直接启动
SEARXNG_DIR="$HOME/.pi/searxng"
if [ -f "$SEARXNG_DIR/start.sh" ]; then
  bash "$SEARXNG_DIR/start.sh"
  exit $?
fi

# 自托管启动（start.sh 不存在时直接启动 SearXNG）
if [ ! -d "$SEARXNG_DIR/venv" ]; then
  echo "错误: SearXNG 未部署。请先运行 install.sh 部署 SearXNG。"
  exit 1
fi

PID_FILE="$SEARXNG_DIR/searxng.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "SearXNG 已在运行 (PID $(cat "$PID_FILE"))"
  exit 0
fi

source "$SEARXNG_DIR/venv/bin/activate"
export SEARXNG_SETTINGS_PATH="$SEARXNG_DIR/settings.yml"
export SEARXNG_DEBUG=0

nohup granian searx.webapp:app \
  --interface wsgi \
  --host 127.0.0.1 \
  --port 8889 \
  --workers 2 \
  --blocking-threads 4 \
  > "$SEARXNG_DIR/searxng.log" 2>&1 &

PID=$!
echo $PID > "$PID_FILE"
echo "SearXNG 已启动 (PID $PID)"
echo "日志: $SEARXNG_DIR/searxng.log"
