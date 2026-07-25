#!/bin/bash
# pi-wrapper.sh - Pi 进程外生命周期管理器
# 替代直接调用 pi 命令，支持自动重启（模型切换/会话切换/显式重启）
#
# 用法: ./pi-wrapper.sh [pi 参数...]
# 安装: ./install-wrapper.sh (会备份原 pi 命令，替换为 wrapper)

set -e

# 找到原始 pi CLI 的 JS 入口（绕过 wrapper 防循环）
# 不能直接执行 pi-original symlink，因为 Node 拒绝非 .js 扩展名
# 改为找到真实的 cli.js 用 node 执行
PI_JS=""
PI_BIN_DIR="$(dirname "$(command -v pi 2>/dev/null || echo '')")"
if [ -d "$PI_BIN_DIR" ]; then
  # 尝试通过 pi-original symlink 找到目标
  if [ -L "$PI_BIN_DIR/pi-original" ]; then
    PI_TARGET="$(readlink -f "$PI_BIN_DIR/pi-original" 2>/dev/null || readlink "$PI_BIN_DIR/pi-original")"
    if [ -f "$PI_TARGET" ]; then
      PI_JS="$PI_TARGET"
    fi
  fi
  # 如果没有 pi-original，从原始 pi symlink 找
  if [ -z "$PI_JS" ] && [ -L "$PI_BIN_DIR/pi" ]; then
    PI_JS="$(readlink -f "$PI_BIN_DIR/pi" 2>/dev/null || echo "")"
    [ ! -f "$PI_JS" ] && PI_JS=""
  fi
  # 找 dist/cli.js
  if [ -z "$PI_JS" ]; then
    PI_JS="$PI_BIN_DIR/../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    [ ! -f "$PI_JS" ] && PI_JS=""
  fi
fi
# 兜底：直接试 pi 命令（可能走 wrapper 循环但概率低）
if [ -z "$PI_JS" ]; then
  PI_JS="$(command -v pi 2>/dev/null || echo '')"
fi

STATE_FILE="$HOME/.pi/agent/.pi-admin-state.json"

init_state_file() {
  mkdir -p "$(dirname "$STATE_FILE")"
  if [ ! -f "$STATE_FILE" ]; then
    echo '{"action":"none","timestamp":0,"restartLog":null}' > "$STATE_FILE"
  fi
}

read_state_action() {
  node -e "
    try {
      const s = require('$STATE_FILE');
      console.log(s.action || 'none');
    } catch(e) { console.log('none'); }
  " 2>/dev/null || echo "none"
}

read_state_field() {
  local field="$1"
  node -e "
    try {
      const s = require('$STATE_FILE');
      console.log(s['$field'] || '');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo ""
}

reset_state_preserve_log() {
  # Read current state, preserve restartLog, set action to "none"
  local restart_log
  restart_log=$(node -e "
    try {
      const s = require('$STATE_FILE');
      console.log(JSON.stringify(s.restartLog || null));
    } catch(e) { console.log('null'); }
  " 2>/dev/null || echo "null")

  # Also read targetSession/targetModel from the log if action was set
  local log_action log_session log_model log_provider log_reason log_ts
  log_action=$(node -e "
    try {
      const s = require('$STATE_FILE');
      const log = s.restartLog || {};
      console.log(log.action || 'none');
    } catch(e) { console.log('none'); }
  " 2>/dev/null || echo "none")

  log_session=$(node -e "
    try {
      const s = require('$STATE_FILE');
      const log = s.restartLog || {};
      console.log(log.targetSession || '');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")

  log_model=$(node -e "
    try {
      const s = require('$STATE_FILE');
      const log = s.restartLog || {};
      console.log(log.targetModel || '');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")

  log_provider=$(node -e "
    try {
      const s = require('$STATE_FILE');
      const log = s.restartLog || {};
      console.log(log.targetProvider || '');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")

  log_reason=$(node -e "
    try {
      const s = require('$STATE_FILE');
      const log = s.restartLog || {};
      console.log(log.reason || '');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")

  log_ts=$(node -e "
    try {
      const s = require('$STATE_FILE');
      const log = s.restartLog || {};
      console.log(log.timestamp || 0);
    } catch(e) { console.log('0'); }
  " 2>/dev/null || echo "0")

  # Write back: action=none, preserve restartLog details
  cat > "$STATE_FILE" <<- STATEEOF
{
  "action": "none",
  "targetSession": "",
  "targetModel": "",
  "targetProvider": "",
  "reason": "",
  "timestamp": 0,
  "restartLog": $restart_log
}
STATEEOF
}

init_state_file

while true; do
  echo "[pi-wrapper] 启动 Pi... (js: $PI_JS)" >&2
  if [ -f "$PI_JS" ] && echo "$PI_JS" | grep -q '\.js$'; then
    node "$PI_JS" "$@"
  else
    # fallback: 尝试直接运行（可能走 wrapper 循环）
    "$PI_JS" "$@"
  fi
  EXIT_CODE=$?
  echo "[pi-wrapper] Pi 已退出 (code: $EXIT_CODE)" >&2

  ACTION=$(read_state_action)
  echo "[pi-wrapper] 状态: action=$ACTION" >&2

  if [ "$ACTION" = "none" ] || [ -z "$ACTION" ]; then
    echo "[pi-wrapper] 正常退出，不重启" >&2
    break
  fi

  # Read target info from state file (from the restartLog that was set before shutdown)
  TARGET_SESSION=$(read_state_field "targetSession")
  TARGET_MODEL=$(read_state_field "targetModel")

  # Reset state (preserve restartLog for extension on next startup)
  reset_state_preserve_log

  # Build extra CLI args for the restart
  EXTRA_ARGS=()

  if [ "$ACTION" = "switch_session" ] && [ -n "$TARGET_SESSION" ]; then
    EXTRA_ARGS+=(--session "$TARGET_SESSION")
    echo "[pi-wrapper] 目标: 会话 $TARGET_SESSION" >&2
  elif [ "$ACTION" = "set_model" ] && [ -n "$TARGET_MODEL" ]; then
    EXTRA_ARGS+=(--model "$TARGET_MODEL")
    # Also add --continue to resume session
    EXTRA_ARGS+=(--continue)
    echo "[pi-wrapper] 目标: 模型 $TARGET_MODEL" >&2
  else
    # Plain restart: continue with most recent session
    EXTRA_ARGS+=(--continue)
    echo "[pi-wrapper] 目标: 恢复最近会话" >&2
  fi

  echo "[pi-wrapper] ${EXIT_CODE} 秒后重启..." >&2
  sleep 1

  # Merge original args with extra args
  set -- "$@" "${EXTRA_ARGS[@]}"
done

exit "$EXIT_CODE"
