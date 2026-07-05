#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/searxng.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "SearXNG 未在运行（无 PID 文件）"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "正在停止 SearXNG (PID $PID)..."
  kill "$PID" 2>/dev/null
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    echo "等待进程退出..."
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "SearXNG 已停止"
else
  echo "SearXNG 未在运行（PID $PID 不存在）"
fi

rm -f "$PID_FILE"
