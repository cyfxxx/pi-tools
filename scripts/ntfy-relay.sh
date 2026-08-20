#!/usr/bin/env bash
# ntfy-relay 守护管理（nohup 运行，RPC 注入模式——tmux 故障时手机远程控制仍可用）
# 用法: bash scripts/ntfy-relay.sh {start|stop|restart|status}
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/root/.local/share/pi-node/node-v22.23.1-linux-arm64/bin/node
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
