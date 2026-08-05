#!/bin/bash
# pi-wrapper.sh - Pi 进程外生命周期管理器
# 替代直接调用 pi 命令，支持自动重启（模型切换/会话切换/显式重启）
#
# 用法: ./pi-wrapper.sh [pi 参数...]
# 安装: ./install-wrapper.sh (会备份原 pi 命令，替换为 wrapper)

# 手动处理关键路径的错误，不使用 set -e

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
CRASH_FILE="$HOME/.pi/agent/.pi-autopilot-crash.json"
LASTGOOD_FILE="$HOME/.pi/agent/.pi-autopilot-lastgood.json"
SETTINGS_FILE="$HOME/.pi/agent/settings.json"
PI_AUTOPILOT=1
export PI_AUTOPILOT
CRASH_THRESHOLD=3
LAST_ROLLBACK_TS=0

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

# pi-autopilot：崩溃计数 / lastGood 快照 / 回滚

init_crash_file() {
  if [ ! -f "$CRASH_FILE" ]; then
    echo '{"count":0,"ts":0}' > "$CRASH_FILE"
  fi
}

read_crash_count() {
  node -e "
    try {
      const s = require('$CRASH_FILE');
      console.log(s.count || 0);
    } catch(e) { console.log('0'); }
  " 2>/dev/null || echo "0"
}

write_crash_count() {
  local count="$1"
  node -e "
    const fs = require('fs');
    fs.writeFileSync('$CRASH_FILE', JSON.stringify({count: $count, ts: Date.now()}, null, 2));
  " 2>/dev/null
}

save_lastgood() {
  # 正常退出时记录当前默认模型为“最近一次良好配置”
  node -e "
    const fs = require('fs');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8')); } catch(e) {}
    const snap = {
      provider: settings.defaultProvider || '',
      model: settings.defaultModel || '',
      ts: Date.now(),
    };
    fs.writeFileSync('$LASTGOOD_FILE', JSON.stringify(snap, null, 2));
  " 2>/dev/null
}

read_lastgood_model() {
  node -e "
    try {
      const s = require('$LASTGOOD_FILE');
      console.log(JSON.stringify({provider: s.provider || '', model: s.model || ''}));
    } catch(e) { console.log('{}'); }
  " 2>/dev/null || echo "{}"
}

rollback_to_lastgood() {
  # 连续崩溃达到阈值：回滚到最近一次良好模型并重启
  local now rollback_window snap provider model
  now=$(date +%s)
  rollback_window=$((LAST_ROLLBACK_TS + 300))
  if [ "$now" -lt "$rollback_window" ]; then
    echo "[pi-wrapper] 5 分钟内已回滚过一次，停止自动重试" >&2
    return 1
  fi
  snap=$(read_lastgood_model)
  provider=$(echo "$snap" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).provider||''))" 2>/dev/null)
  model=$(echo "$snap" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).model||''))" 2>/dev/null)
  if [ -z "$model" ]; then
    echo "[pi-wrapper] 无 lastGood 快照，无法回滚" >&2
    return 1
  fi
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$STATE_FILE', 'utf-8'));
    s.action = 'set_model';
    s.targetProvider = '$provider';
    s.targetModel = '$model';
    s.reason = '连续崩溃' + '$CRASH_THRESHOLD' + ' 次，自动回滚至稳定模型';
    s.timestamp = Date.now();
    fs.writeFileSync('$STATE_FILE', JSON.stringify(s, null, 2));
  " 2>/dev/null
  LAST_ROLLBACK_TS=$now
  write_crash_count 0
  echo "[pi-wrapper] 已触发回滚至 $provider/$model" >&2
  return 0
}

init_crash_file
if [ ! -f "$LASTGOOD_FILE" ]; then
  save_lastgood
fi

# Save original args for restart reuse
ORIG_ARGS="$@"

# L1: tmux 自启（可选）。设置 PI_TMUX_SESSION 时，把 pi 放进指定 tmux 会话运行
# （创建或附加），脱离/重连方便。仅交互式（stdout 是 TTY）才生效，
# 避免 pi-autopilot 子进程 / pi-cron 离线调用被卷入 tmux。
if [ -n "${PI_TMUX_SESSION:-}" ] && [ -t 1 ] && command -v tmux >/dev/null 2>&1; then
  _cur_session=""
  if [ -n "${TMUX:-}" ]; then
    _cur_session=$(tmux display-message -p '#S' 2>/dev/null || echo "")
  fi
  if [ "$_cur_session" != "$PI_TMUX_SESSION" ]; then
    echo "[pi-wrapper] 进入 tmux 会话 '$PI_TMUX_SESSION'（脱离: C-a d / 重连: tmux attach -t $PI_TMUX_SESSION）" >&2
    tmux new-session -d -s "$PI_TMUX_SESSION" -c "$PWD" "$0" "$@" 2>/dev/null
    exec tmux attach -t "$PI_TMUX_SESSION"
  fi
fi

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
    if [ "$EXIT_CODE" -ne 0 ]; then
      # 非正常退出（崩溃）：累计计数，达到阈值回滚 lastGood
      crash_count=$(read_crash_count)
      crash_count=$((crash_count + 1))
      write_crash_count "$crash_count"
      echo "[pi-wrapper] 检测到崩溃 (第 ${crash_count} 次)" >&2
      if [ "$crash_count" -ge "$CRASH_THRESHOLD" ]; then
        if rollback_to_lastgood; then
          echo "[pi-wrapper] 回滚后 1 秒重启..." >&2
          sleep 1
          set -- "$ORIG_ARGS" "--continue"
          continue
        fi
      fi
      echo "[pi-wrapper] 崩溃次数未达阈值或回滚失败，停止" >&2
      break
    fi
    # 正常退出：记录 lastGood 并清零崩溃计数
    save_lastgood
    write_crash_count 0
    echo "[pi-wrapper] 正常退出，不重启" >&2
    break
  fi

  # 有意的重启（模型切换/会话切换/挂死恢复）：清零崩溃计数
  write_crash_count 0

  # Read target info from state file (from the restartLog that was set before shutdown)
  TARGET_SESSION=$(read_state_field "targetSession")
  TARGET_MODEL=$(read_state_field "targetModel")

  # Reset state (preserve restartLog for extension on next startup)
  reset_state_preserve_log

  # Reset extra args each iteration to avoid accumulation
  EXTRA_ARGS=()
  # Unset old target vars
  unset TARGET_SESSION TARGET_MODEL

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

  echo "[pi-wrapper] 1 秒后重启..." >&2
  sleep 1

  # Merge original args with extra args (fresh per iteration)
  set -- "$ORIG_ARGS" "${EXTRA_ARGS[@]}"
done

exit "$EXIT_CODE"
