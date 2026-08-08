#!/usr/bin/env bash
# pi-whisper.sh — whisper 常驻服务管理（pi-voice 扩展的后端）
# 用法: pi-whisper.sh {start|stop|status|restart}
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
VENV="${PI_WHISPER_VENV:-/opt/pi-whisper/venv}"
SERVER="$PI_HOME/scripts/whisper-server.py"
PORT="${PI_WHISPER_PORT:-18766}"
LOG="$PI_HOME/logs/whisper/server.log"
PIDFILE="$PI_HOME/logs/whisper/server.pid"

mkdir -p "$(dirname "$LOG")"

# 从 pi-voice 配置读取共享令牌（相同文件，扩展与服务端同源）
read_token() {
  local cfg="$PI_HOME/agent/pi-voice.json"
  if [ -f "$cfg" ]; then
    python3 -c "import json,sys; v=json.load(open('$cfg')).get('whisperToken',''); print(v)" 2>/dev/null
  fi
}

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "whisper 服务已在运行 (pid $(cat "$PIDFILE"))"
    return 0
  fi
  if [ ! -x "$VENV/bin/python" ]; then
    echo "错误: 未找到 $VENV/bin/python，请先: python3 -m venv $VENV && $VENV/bin/pip install faster-whisper" >&2
    return 1
  fi
  local token
  token="$(read_token)"
  if [ -n "$token" ]; then
    PI_WHISPER_TOKEN="$token" nohup "$VENV/bin/python" "$SERVER" >>"$LOG" 2>&1 &
    echo "whisper 服务启动（Bearer token 鉴权已启用）"
  else
    nohup "$VENV/bin/python" "$SERVER" >>"$LOG" 2>&1 &
  fi
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "whisper 服务已启动 (pid $(cat "$PIDFILE"), 模型加载完成)"
      return 0
    fi
    sleep 1
  done
  echo "whisper 服务启动超时（模型加载中？），日志: $LOG" >&2
  return 1
}

stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
    echo "whisper 服务已停止"
  else
    rm -f "$PIDFILE"
    echo "whisper 服务未在运行"
  fi
}

status() {
  if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
    echo "whisper 服务: 运行中 (模型已加载)"
    return 0
  fi
  if is_running; then
    echo "whisper 服务: 进程在但模型未就绪 (pid $(cat "$PIDFILE"))"
    return 1
  fi
  echo "whisper 服务: 未运行"
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
