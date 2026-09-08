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
  echo "错误: SearXNG 未部署。请先运行 bash ~/.pi/scripts/rebuild.sh 部署 SearXNG（详见 docs/AGENTS-DETAILS.md）。"
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

# 启动后校验：granian 可能因端口占用等立即退出，不能只看 PID 存活
# 端口监听检测：优先 curl（HTTP 可达即监听成功），无 curl 时回落 grep /proc/net/tcp
wait_ready() {
  local i
  for i in 1 2 3 4 5 6 7 8; do
    if ! kill -0 "$PID" 2>/dev/null; then return 1; fi   # 进程已退出 → 启动失败
    if command -v curl >/dev/null 2>&1; then
      if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8889/" 2>/dev/null; then
        return 0
      fi
    elif awk '$2=="0100007F:22B9" && $4=="0A"' /proc/net/tcp 2>/dev/null | grep -q .; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if wait_ready; then
  echo "SearXNG 已启动 (PID $PID)"
  echo "日志: $SEARXNG_DIR/searxng.log"
  exit 0
else
  echo "错误: SearXNG 启动失败（进程已退出或端口 8889 未监听）" >&2
  echo "日志尾部:" >&2
  tail -n 20 "$SEARXNG_DIR/searxng.log" >&2 2>/dev/null || true
  # 审计 LOW：并发启动时后启动实例失败会误删健康实例的 pid 记录——仅当文件内容仍是本实例 PID 才删
  if [ "$(cat "$PID_FILE" 2>/dev/null)" = "$PID" ]; then rm -f "$PID_FILE"; fi
  exit 1
fi
