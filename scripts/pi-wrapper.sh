#!/bin/bash
# pi-wrapper.sh - Pi 进程外生命周期管理器
# 替代直接调用 pi 命令，支持自动重启（模型切换/会话切换/显式重启）
#
# 用法: ./pi-wrapper.sh [pi 参数...]
# 安装: ./install-wrapper.sh (会备份原 pi 命令，替换为 wrapper)

# 手动处理关键路径的错误，不使用 set -e

# 持久化锚点：记录最近一次解析出的真实 cli.js 路径。
# pi update 重装 npm 包后路径不变（更新目录内的同一 cli.js），
# 而 bin/pi 可能被 update 覆盖成官方 symlink，导致 wrapper 被绕过，
# 此锚点 + 自动重建 pi-original 保证 wrapper 在 update 后仍接管。
ANCHOR_FILE="$HOME/.pi/scripts/.pi-cli-path"

# 找到原始 pi CLI 的 JS 入口（绕过 wrapper 防循环）
# 不能直接执行 pi-original symlink，因为 Node 拒绝非 .js 扩展名
# 改为找到真实的 cli.js 用 node 执行
PI_JS=""
# 1. 持久化锚点优先
if [ -z "$PI_JS" ] && [ -f "$ANCHOR_FILE" ]; then
  ANCHOR="$(cat "$ANCHOR_FILE" 2>/dev/null || echo '')"
  [ -f "$ANCHOR" ] && PI_JS="$ANCHOR"
fi
PI_BIN_DIR="$(dirname "$(command -v pi 2>/dev/null || echo '')")"
if [ -d "$PI_BIN_DIR" ]; then
  # 2. 尝试通过 pi-original symlink 找到目标
  if [ -z "$PI_JS" ] && [ -L "$PI_BIN_DIR/pi-original" ]; then
    PI_TARGET="$(readlink -f "$PI_BIN_DIR/pi-original" 2>/dev/null || readlink "$PI_BIN_DIR/pi-original")"
    if [ -f "$PI_TARGET" ]; then
      PI_JS="$PI_TARGET"
    fi
  fi
  # 3. 如果没有 pi-original，从官方 pi symlink 找（并自动重建 pi-original 备份，
  #    防止 pi update 删除该 symlink 后下次启动丢失入口）
  if [ -z "$PI_JS" ] && [ -L "$PI_BIN_DIR/pi" ]; then
    PI_JS="$(readlink -f "$PI_BIN_DIR/pi" 2>/dev/null || echo "")"
    [ -f "$PI_JS" ] && [ ! -L "$PI_BIN_DIR/pi-original" ] && ln -s "$PI_JS" "$PI_BIN_DIR/pi-original" 2>/dev/null
    [ ! -f "$PI_JS" ] && PI_JS=""
  fi
  # 4. 找 dist/cli.js
  if [ -z "$PI_JS" ]; then
    PI_JS="$PI_BIN_DIR/../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    [ ! -f "$PI_JS" ] && PI_JS=""
  fi
fi
# 5. 兜底：直接试 pi 命令——但必须排除 wrapper 自身：pi 命令被本脚本接管后
#    command -v pi 即 $0（wrapper 脚本），直接采用会自我递归直到资源耗尽
#    （审计 MEDIUM）。仅当解析到非本脚本路径才采用。
if [ -z "$PI_JS" ]; then
  cand="$(command -v pi 2>/dev/null || echo '')"
  if [ -n "$cand" ] && [ "$(readlink -f "$cand" 2>/dev/null)" != "$(readlink -f "$0" 2>/dev/null)" ]; then
    PI_JS="$cand"
  fi
fi

# 解析成功则刷新锚点（仅 .js 真实入口可写锚点——wrapper 自身会污染锚点致后续递归）
if [ -n "$PI_JS" ] && [ -f "$PI_JS" ] && echo "$PI_JS" | grep -q '\.js$'; then
  echo "$PI_JS" > "$ANCHOR_FILE" 2>/dev/null
fi

# 导出 PI_DIST（dist 目录）：wrapper 接管 pi 命令后，扩展/补丁脚本的
# `which pi` + readlink 探测会解析到 wrapper 自身而失败（如 pi-voice 的
# enterPatchApplied、patch-*.mjs 的 detectDist）。cli.js 位于 dist/ 下，
# dirname 即得 dist 目录，供扩展与补丁脚本直接使用。
if [ -n "$PI_JS" ] && [ -f "$PI_JS" ]; then
  export PI_DIST="$(dirname "$PI_JS")"
fi

# Termux 重建：cloakbrowser 官方只发布 linux/darwin/win 预编译包，
# Termux (platform=android) 用本地 Chromium（pkg install x11-repo chromium），
# playwright-core 已打 android→linux 补丁（见 rebuild 记录）。
# 注意：仅 Termux 设默认值——其他平台无条件导出会注入不存在的路径
# 使 cloakbrowser 误走 override 分支启动失败（2026-08-15 WSL 实测）。
if [ -d /data/data/com.termux ]; then
  export CLOAKBROWSER_BINARY_PATH="${CLOAKBROWSER_BINARY_PATH:-/data/data/com.termux/files/usr/bin/chromium-browser}"
fi

# Termux 无 X server：浏览器默认 headless（有头需要 termux-x11；
# 桌面环境（WSLg/原生 X）不受影响，可显式 export PI_WEB_TOOLKIT_HEADLESS=false 覆盖）
[ -d /data/data/com.termux ] && export PI_WEB_TOOLKIT_HEADLESS="${PI_WEB_TOOLKIT_HEADLESS:-true}"

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

# L3: pi update 后自动重跑 rebuild.sh 恢复补丁。
# pi update 是 CLI 一次性命令（经 wrapper 执行 node cli.js update），升级会覆盖 dist，
# Phase 3 的 7 个补丁（footer 实时token/CH/格式、回车拦截、工具schema、tab 补全、playwright）
# 全部失效。此处拦截 update：执行成功后自动 rebuild，避免用户遗忘重跑。
# 失败不 rebuild（避免在坏状态下改 dist）；rebuild 自身幂等。
if [ "$1" = "update" ]; then
  echo "[pi-wrapper] 执行 pi update..." >&2
  node "$PI_JS" update
  UPD_EXIT=$?
  if [ "$UPD_EXIT" -eq 0 ]; then
    echo "[pi-wrapper] update 完成，自动重跑 rebuild.sh 恢复补丁..." >&2
    if [ -x "$HOME/.pi/scripts/rebuild.sh" ]; then
      bash "$HOME/.pi/scripts/rebuild.sh"
      echo "[pi-wrapper] rebuild 完成（exit $?），补丁已恢复" >&2
    else
      echo "[pi-wrapper] 警告：rebuild.sh 不存在，补丁未恢复，请手动重跑或重新安装" >&2
    fi
  else
    echo "[pi-wrapper] pi update 失败（exit $UPD_EXIT），跳过 rebuild" >&2
  fi
  exit "$UPD_EXIT"
fi

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

# Save original args for restart reuse（数组保存：ORIG_ARGS="$@" 会把参数整体折叠为
# 单个 argv——审计实测 --model x --session y 重启后变成 ["--model x --session y",
# "--continue"]，模型/会话切换重启链路失真；无参时还会注入空串参数）
ORIG_ARGS=("$@")

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

# L1.5: tmux 孤儿 socket 自愈。proot 环境下 tmux server 被 kill 后 socket 残留，
# 后续所有 tmux 命令报 "access not allowed" 且 exit 0（会话创建无效）——
# AGENTS.md 已记录此故障。每次 pi 启动检测该症状并清理重建。
# 仅在 pi 不在 tmux 内时执行（$TMUX 为空），避免误杀承载 pi 的会话。
ensure_tmux() {
  command -v tmux >/dev/null 2>&1 || return 0
  [ -n "${TMUX:-}" ] && return 0
  local out
  out=$(tmux list-sessions 2>&1)
  if echo "$out" | grep -q "access not allowed"; then
    local tpid
    tpid=$(ps -e -o pid,comm 2>/dev/null | awk '$2 == "tmux: server" {print $1; exit}')
    [ -n "$tpid" ] && kill -9 "$tpid" 2>/dev/null
    # 审计 MEDIUM：rm -rf /tmp/tmux-* 在 root 下会连其他用户的 socket 一起删——
    # 收窄为本用户 socket 目录（tmux 默认 /tmp/tmux-UID/）
    rm -rf "/tmp/tmux-$(id -u)" 2>/dev/null
    echo "[pi-wrapper] 清理陈旧 tmux server/socket 并重建" >&2
    tmux new-session -d -s bootstrap -c "$HOME" >/dev/null 2>&1 || true
  fi
}

# L2: cron 守护自愈（离线调度保障）。pi-cron.sh 由 crontab 每分钟触发，
# 但 proot 环境 cron 守护可能未运行（重启后丢失、无人拉起），在此确保拉起。
# 幂等：已在运行则跳过。
ensure_cron() {
  command -v cron >/dev/null 2>&1 || return 0
  if ! ps -e -o comm 2>/dev/null | grep -qx cron; then
    /usr/sbin/cron 2>/dev/null || cron 2>/dev/null || true
    echo "[pi-wrapper] cron 守护已拉起（离线调度恢复）" >&2
  fi
}

while true; do
  ensure_tmux
  ensure_cron
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
          set -- "${ORIG_ARGS[@]}" "--continue"
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
  # 注意：不要在这里 unset TARGET_SESSION/TARGET_MODEL——下方分支判断依赖它们
  # （2026-08-15 审计发现：unset 先于判断致 switch_session/set_model 分支恒假，
  # 模型切换/会话切换/崩溃回滚静默降级为 --continue）

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
  unset TARGET_SESSION TARGET_MODEL

  echo "[pi-wrapper] 1 秒后重启..." >&2
  sleep 1

  # Merge original args with extra args (fresh per iteration)
  set -- "${ORIG_ARGS[@]}" "${EXTRA_ARGS[@]}"
done

exit "$EXIT_CODE"
