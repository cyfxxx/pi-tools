#!/usr/bin/env bash
# ntfy-relay 守护管理（nohup 运行，RPC 注入模式——tmux 故障时手机远程控制仍可用）
# 用法: bash scripts/ntfy-relay.sh {start|stop|restart|status}
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# node 动态解析：优先 PATH，其次 current 软链，再次 glob 最近版本目录（node 随 pi
# 安装于 ~/.local/share/pi-node/，版本目录随升级变化——硬编码路径已过期）
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE="$(ls -d ~/.local/share/pi-node/current/bin/node 2>/dev/null || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE="$(ls ~/.local/share/pi-node/node-v*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "错误：找不到 node——请先安装 pi（node 随 pi 装入 ~/.local/share/pi-node/），或将 node 加入 PATH" >&2
  exit 1
fi
PID_FILE="$DIR/agent/.ntfy-relay.pid"
LOG="$DIR/logs/ntfy-relay.log"

case "${1:-}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "已在运行 pid=$(cat "$PID_FILE")"; exit 0
    fi
    nohup "$NODE" "$DIR/scripts/ntfy-relay.js" >>"$LOG" 2>&1 &
    echo "$!" > "$PID_FILE"
    sleep 2
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then echo "已启动 pid=$(cat "$PID_FILE")"; else echo "启动失败，查看 $LOG"; fi
    ;;
  stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")" 2>/dev/null; rm -f "$PID_FILE"; echo "已停止"
    else
      echo "未运行"; rm -f "$PID_FILE"
    fi
    ;;
  restart) "$0" stop >/dev/null; sleep 1; "$0" start ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "运行中 pid=$(cat "$PID_FILE")"
      tail -3 "$LOG" 2>/dev/null
    else
      echo "未运行"
    fi
    ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
