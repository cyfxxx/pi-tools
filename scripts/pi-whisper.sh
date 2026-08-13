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

# 从 pi-voice 配置读取模型名（/voice model 切换时落盘；空=服务端默认 base）
read_model() {
  local cfg="$PI_HOME/agent/pi-voice.json"
  if [ -f "$cfg" ]; then
    python3 -c "import json,sys; v=json.load(open('$cfg')).get('whisperModel',''); print(v)" 2>/dev/null
  fi
}

read_device() {
  local cfg="$PI_HOME/agent/pi-voice.json"
  if [ -f "$cfg" ]; then
    python3 -c "import json,sys; v=json.load(open('$cfg')).get('whisperDevice',''); print(v)" 2>/dev/null
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
    echo "错误: 未找到 $VENV/bin/python，请先: python3 -m venv $VENV && $VENV/bin/pip install faster-whisper opencc-python-reimplemented" >&2
    return 1
  fi
  # opencc 缺失时中文转写会输出繁体（服务端设计为缺失时跳过转换），警告但不阻塞启动
  if ! "$VENV/bin/python" -c 'import opencc' >/dev/null 2>&1; then
    echo "警告: opencc 未安装，中文转写将保持繁体。修复: $VENV/bin/pip install opencc-python-reimplemented"
  fi
  local token model device
  token="$(read_token)"
  model="$(read_model)"
  device="$(read_device)"
  # 只在非空时传入：空串会被服务端 os.environ.get 原样接收（不回落默认）
  local -a envs=()
  [ -n "$token" ] && envs+=(PI_WHISPER_TOKEN="$token")
  [ -n "$model" ] && envs+=(PI_WHISPER_MODEL="$model")
  [ -n "$device" ] && envs+=(PI_WHISPER_DEVICE="$device")
  # ctranslate2 CUDA 依赖（nvidia-cublas/cudnn pip 包）不在系统库路径，需显式加入
  local nv_lib="$VENV/lib/python3.12/site-packages/nvidia"
  if [ -d "$nv_lib/cublas/lib" ] || [ -d "$nv_lib/cudnn/lib" ]; then
    envs+=(LD_LIBRARY_PATH="$nv_lib/cublas/lib:$nv_lib/cudnn/lib:${LD_LIBRARY_PATH:-}")
  fi
  env "${envs[@]}" nohup "$VENV/bin/python" "$SERVER" >>"$LOG" 2>&1 &
  echo "whisper 服务启动（${token:+Bearer token 鉴权已启用}${model:+，模型 $model}${device:+，设备 $device}）"
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do
    if [ -n "$token" ]; then
      curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
    else
      curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
    fi
    if [ $? -eq 0 ]; then
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
  local token="$(read_token)"
  local code
  if [ -n "$token" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT/health" 2>/dev/null)
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null)
  fi
  if [ "$code" = "200" ]; then
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

run() {
  # 前台运行（systemd Type=simple 专用）：读取与 start 相同的配置并 exec，不后台化
  local token model device nv_lib
  token="$(read_token)"
  model="$(read_model)"
  device="$(read_device)"
  local -a envs=()
  [ -n "$token" ] && envs+=(PI_WHISPER_TOKEN="$token")
  [ -n "$model" ] && envs+=(PI_WHISPER_MODEL="$model")
  [ -n "$device" ] && envs+=(PI_WHISPER_DEVICE="$device")
  nv_lib="$VENV/lib/python3.12/site-packages/nvidia"
  if [ -d "$nv_lib/cublas/lib" ] || [ -d "$nv_lib/cudnn/lib" ]; then
    envs+=(LD_LIBRARY_PATH="$nv_lib/cublas/lib:$nv_lib/cudnn/lib:${LD_LIBRARY_PATH:-}")
  fi
  exec env "${envs[@]}" "$VENV/bin/python" "$SERVER"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  run) run ;;
  *) echo "用法: $0 {start|stop|restart|status|run}"; exit 1 ;;
esac
