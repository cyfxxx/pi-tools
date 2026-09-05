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
RESCUE_THRESHOLD=5  # 连续崩溃达 5 次触发配置恢复
RESCUE_PI_THRESHOLD=7  # 连续崩溃达 7 次启动救援模式 pi
MAX_RECOVERY_ROUNDS=5  # 单次启动最大恢复循环轮数
PI_SOURCE_CACHE="$HOME/.pi/pi-source-cache"  # L4 源码编译缓存
LAST_ROLLBACK_TS=0

# 加载崩溃分析器和审计日志模块
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/pi-crash-analyzer.sh"
source "$SCRIPT_DIR/pi-recovery-audit.sh"
# 审计 MEDIUM 修复：崩溃计数时间窗（24h）——窗口外的旧计数清零，
# 避免长期积累的正常使用（零散非零退出）被误判为连续崩溃触发回滚
CRASH_WINDOW_MS=$((24 * 3600 * 1000))

# 救援模式相关路径
RESCUE_DIR="$HOME/.pi/agent/rescue"
SNAPSHOT_DIR="$HOME/.pi/.snapshots"
RESCUE_CONFIG="$RESCUE_DIR/rescue-config.json"
RESCUE_PROMPT="$RESCUE_DIR/rescue-prompt.md"

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
# Phase 3 的 8 个补丁（footer 实时token/CH/格式/重启提示⚠、回车拦截、工具schema、
# tab 补全、playwright-core）全部失效。此处拦截 update：执行成功后自动 rebuild，避免用户遗忘重跑。
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

# ── 快照与恢复函数 ──
# 在 pi 启动前自动创建快照，崩溃时可以恢复

# 创建快照：保存关键配置文件和 git 状态
create_snapshot() {
  local timestamp=$(date +%Y%m%d_%H%M%S)
  local snapshot_path="$SNAPSHOT_DIR/snapshot_${timestamp}"
  
  mkdir -p "$SNAPSHOT_DIR" "$snapshot_path"
  
  # 保存关键配置文件
  cp "$SETTINGS_FILE" "$snapshot_path/" 2>/dev/null || true
  cp "$HOME/.pi/agent/modes.json" "$snapshot_path/" 2>/dev/null || true
  
  # 保存扩展列表
  ls "$HOME/.pi/agent/extensions/" > "$snapshot_path/extensions.list" 2>/dev/null || true
  
  # 保存 git 状态
  cd "$HOME/.pi"
  git rev-parse HEAD > "$snapshot_path/git-commit" 2>/dev/null || true
  git status --porcelain > "$snapshot_path/git-status" 2>/dev/null || true
  
  # 清理旧快照（保留最近 10 个）
  local count=$(ls -1d "$SNAPSHOT_DIR"/snapshot_* 2>/dev/null | wc -l)
  if [ "$count" -gt 10 ]; then
    ls -1d "$SNAPSHOT_DIR"/snapshot_* | head -n $((count - 10)) | xargs rm -rf
  fi
  
  echo "$snapshot_path"
}

# 恢复快照：从指定快照恢复配置文件
restore_snapshot() {
  local snapshot_path="$1"
  
  if [ ! -d "$snapshot_path" ]; then
    echo "[pi-wrapper] 快照不存在: $snapshot_path" >&2
    return 1
  fi
  
  # 恢复配置文件
  cp "$snapshot_path/settings.json" "$SETTINGS_FILE" 2>/dev/null || true
  cp "$snapshot_path/modes.json" "$HOME/.pi/agent/modes.json" 2>/dev/null || true
  
  echo "[pi-wrapper] 已恢复快照: $snapshot_path" >&2
  return 0
}

# 恢复配置：从 git 恢复配置文件
restore_config_from_git() {
  cd "$HOME/.pi"
  
  # 检查是否有未提交的更改
  if git diff --quiet agent/settings.json 2>/dev/null; then
    echo "[pi-wrapper] settings.json 无更改，跳过 git 恢复" >&2
    return 1
  fi
  
  # 恢复 settings.json
  git checkout HEAD -- agent/settings.json 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "[pi-wrapper] 已从 git 恢复 settings.json" >&2
    return 0
  else
    echo "[pi-wrapper] git 恢复失败" >&2
    return 1
  fi
}

# 启动救援模式 pi：使用最小化配置启动
start_rescue_pi() {
  echo "[pi-wrapper] 启动救援模式 pi..." >&2
  
  # 确保救援配置存在
  if [ ! -f "$RESCUE_CONFIG" ]; then
    mkdir -p "$RESCUE_DIR"
    cat > "$RESCUE_CONFIG" << 'EOF'
{
  "description": "救援模式配置 - 用于修复主程序崩溃问题",
  "extensions": [],
  "skills": [],
  "systemPrompt": null,
  "appendSystemPrompt": "~/.pi/agent/rescue/rescue-prompt.md",
  "thinking": "low"
}
EOF
  fi
  
  # 使用救援配置启动 pi
  node "$PI_JS" \
    --no-extensions \
    --no-skills \
    --append-system-prompt "$RESCUE_PROMPT" \
    "$@"
  
  return $?
}

# ── 健康检查 ──

# health_check
# 恢复后验证 pi 是否能正常启动
# 返回 0=健康 1=不健康
health_check() {
  echo "[pi-wrapper] 执行健康检查..." >&2

  # 1. 快速检查：pi --version
  if ! timeout 10 node "$PI_JS" --version >/dev/null 2>&1; then
    echo "[pi-wrapper] 健康检查失败：pi --version 无法执行" >&2
    return 1
  fi

  # 2. 最小化启动测试（无扩展/无技能/无会话）
  local hc_log="/tmp/pi-health-check-$$.log"
  if timeout 20 node "$PI_JS" --no-extensions --no-skills --no-session -p '{"ok":true}' >"$hc_log" 2>&1; then
    echo "[pi-wrapper] 健康检查通过" >&2
    rm -f "$hc_log"
    return 0
  else
    echo "[pi-wrapper] 健康检查失败：最小化启动测试未通过" >&2
    [ -f "$hc_log" ] && head -3 "$hc_log" >&2
    rm -f "$hc_log"
    return 1
  fi
}

# ── 智能恢复函数 ──

# get_pi_global_dir
# 返回 npm 全局安装目录（pi-coding-agent 所在）
get_pi_global_dir() {
  local pi_bin_dir
  pi_bin_dir="$(dirname "$(command -v pi 2>/dev/null || echo '')")"
  if [ -d "$pi_bin_dir" ]; then
    echo "$pi_bin_dir/../lib/node_modules/@earendil-works/pi-coding-agent"
  else
    echo "$HOME/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent"
  fi
}

# get_failed_extension_name <log_file>
# 从崩溃日志中提取失败扩展名
get_failed_extension_name() {
  local log_file="$1"
  grep -oP 'Failed to load extension "?\K[^"]+' "$log_file" 2>/dev/null | head -1
}

# disable_extension <ext_name>
# 临时禁用指定扩展（重命名 index.ts → index.ts.disabled）
disable_extension() {
  local ext_name="$1"
  local ext_dir="$HOME/.pi/agent/extensions/$ext_name"
  if [ -f "$ext_dir/index.ts" ]; then
    mv "$ext_dir/index.ts" "$ext_dir/index.ts.disabled" 2>/dev/null
    echo "[pi-wrapper] 已临时禁用扩展: $ext_name" >&2
    return 0
  fi
  return 1
}

# recover_missing_module
# 崩溃类型：missing_module — 重新安装 npm 依赖
recover_missing_module() {
  echo "[pi-wrapper] [恢复] 重装 npm 依赖..." >&2
  local global_dir
  global_dir="$(get_pi_global_dir)"
  if [ -d "$global_dir" ]; then
    npm install --prefix "$(dirname "$global_dir")" 2>&1 | tail -3 >&2
  else
    npm install -g @earendil-works/pi-coding-agent 2>&1 | tail -3 >&2
  fi
}

# recover_syntax_error
# 崩溃类型：syntax_error — 重跑 rebuild 恢复补丁
recover_syntax_error() {
  echo "[pi-wrapper] [恢复] 重跑 rebuild 恢复补丁..." >&2
  if [ -x "$HOME/.pi/scripts/rebuild.sh" ]; then
    bash "$HOME/.pi/scripts/rebuild.sh" 2>&1 | tail -5 >&2
  else
    echo "[pi-wrapper] rebuild.sh 不存在" >&2
    return 1
  fi
}

# recover_extension_fail <log_file>
# 崩溃类型：extension_fail — 临时禁用问题扩展
recover_extension_fail() {
  local log_file="$1"
  local ext_name
  ext_name="$(get_failed_extension_name "$log_file")"
  if [ -n "$ext_name" ]; then
    echo "[pi-wrapper] [恢复] 临时禁用扩展: $ext_name" >&2
    disable_extension "$ext_name"
  else
    echo "[pi-wrapper] [恢复] 无法确定问题扩展，尝试禁用所有扩展" >&2
    for ext_dir in "$HOME/.pi/agent/extensions"/*/; do
      [ -f "$ext_dir/index.ts" ] && mv "$ext_dir/index.ts" "$ext_dir/index.ts.disabled" 2>/dev/null
    done
  fi
}

# recover_config_corrupt
# 崩溃类型：config_corrupt — 从快照恢复配置
recover_config_corrupt() {
  echo "[pi-wrapper] [恢复] 从快照恢复配置..." >&2
  local latest_snapshot
  latest_snapshot=$(ls -1d "$SNAPSHOT_DIR"/snapshot_* 2>/dev/null | tail -1)
  if [ -n "$latest_snapshot" ] && restore_snapshot "$latest_snapshot"; then
    return 0
  fi
  echo "[pi-wrapper] [恢复] 快照恢复失败，尝试 git 恢复..." >&2
  restore_config_from_git
}

# recover_proxy_error
# 崩溃类型：proxy_error — 清除代理环境变量
recover_proxy_error() {
  echo "[pi-wrapper] [恢复] 清除代理环境变量..." >&2
  unset https_proxy http_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY 2>/dev/null
  export https_proxy="" http_proxy="" HTTP_PROXY="" HTTPS_PROXY="" ALL_PROXY=""
}

# recover_lock_contention
# 崩溃类型：lock_contention — kill 竞争实例
recover_lock_contention() {
  echo "[pi-wrapper] [恢复] 检测竞争实例..." >&2
  local my_pid=$$
  local killed=0
  for pid in $(pgrep -f "pi-coding-agent/dist/cli.js" 2>/dev/null); do
    if [ "$pid" != "$my_pid" ] && [ "$pid" != "$PPID" ]; then
      echo "[pi-wrapper] [恢复] 终止竞争实例 PID=$pid" >&2
      kill "$pid" 2>/dev/null && killed=$((killed + 1))
    fi
  done
  if [ "$killed" -gt 0 ]; then
    sleep 2
    return 0
  fi
  return 1
}

# recover_provider_error
# 崩溃类型：provider_error — 回滚 lastGood 模型
recover_provider_error() {
  echo "[pi-wrapper] [恢复] 回滚 lastGood 模型..." >&2
  rollback_to_lastgood
}

# escalate_recovery <crash_type>
# 升级恢复策略（同类型连续失败时）
escalate_recovery() {
  local crash_type="$1"
  echo "[pi-wrapper] [升级] 崩溃类型 $crash_type 连续失败，升级恢复策略..." >&2
  # 先尝试 L4 源码编译恢复
  if recover_from_source; then
    return 0
  fi
  # L4 失败则启动救援模式 pi
  start_rescue_pi
}

# ── L4: 源码编译恢复 ──

# recover_from_source
# 从本地源码缓存恢复 pi（L4 最终手段）
# 返回 0=成功 1=失败
recover_from_source() {
  echo "[pi-wrapper] [L4] 尝试源码编译恢复..." >&2

  local cache_dist="$PI_SOURCE_CACHE/dist"
  local cache_bundle="$cache_dist/bundle/cli.js"
  local cache_version="$PI_SOURCE_CACHE/version.json"
  local global_dir
  global_dir="$(get_pi_global_dir)"
  local npm_dist="$global_dir/dist"

  # 检查缓存是否存在
  if [ -f "$cache_bundle" ]; then
    echo "[pi-wrapper] [L4] 找到预编译缓存" >&2
    if [ -f "$cache_version" ]; then
      local ver hash
      ver=$(node -e "console.log(require('$cache_version').version||'?')" 2>/dev/null)
      hash=$(node -e "console.log(require('$cache_version').gitHash||'?')" 2>/dev/null)
      echo "[pi-wrapper] [L4] 缓存版本: $ver ($hash)" >&2
    fi
  else
    # 无缓存：尝试实时构建
    echo "[pi-wrapper] [L4] 无预编译缓存，尝试实时构建..." >&2
    if [ -x "$HOME/.pi/scripts/pi-source-build.sh" ]; then
      bash "$HOME/.pi/scripts/pi-source-build.sh" 2>&1 | tail -5 >&2
      if [ ! -f "$cache_bundle" ]; then
        echo "[pi-wrapper] [L4] 实时构建失败" >&2
        return 1
      fi
      ok "[L4] 实时构建成功"
    else
      echo "[pi-wrapper] [L4] pi-source-build.sh 不存在" >&2
      return 1
    fi
  fi

  # 备份当前 dist
  if [ -d "$npm_dist" ]; then
    local backup_dir="${npm_dist}.bak.$(date +%s)"
    cp -r "$npm_dist" "$backup_dir" 2>/dev/null
    echo "[pi-wrapper] [L4] 已备份当前 dist: $backup_dir" >&2
  fi

  # 覆盖 dist
  rm -rf "$npm_dist"
  cp -r "$cache_dist" "$npm_dist"
  if [ $? -ne 0 ]; then
    echo "[pi-wrapper] [L4] dist 覆盖失败" >&2
    # 尝试恢复备份
    [ -d "$backup_dir" ] && cp -r "$backup_dir" "$npm_dist" 2>/dev/null
    return 1
  fi

  # 复制 npm-shrinkwrap.json（如有）
  [ -f "$PI_SOURCE_CACHE/npm-shrinkwrap.json" ] && cp "$PI_SOURCE_CACHE/npm-shrinkwrap.json" "$global_dir/"

  echo "[pi-wrapper] [L4] 已从源码缓存恢复 pi" >&2
  return 0
}

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

read_crash_ts() {
  node -e "
    try {
      const s = require('$CRASH_FILE');
      console.log(s.ts || 0);
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
  # provider/model 作为 argv 传入（而非直插源码），模型名含单引号/空白也不破坏 JS
  node -e '
    const fs = require("fs");
    const [stateFile, provider, model, threshold] = process.argv.slice(1);
    const s = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    s.action = "set_model";
    s.targetProvider = provider || "";
    s.targetModel = model || "";
    s.reason = "连续崩溃" + threshold + " 次，自动回滚至稳定模型";
    s.timestamp = Date.now();
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  ' "$STATE_FILE" "$provider" "$model" "$CRASH_THRESHOLD" 2>/dev/null
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

# pi-mode: 解析 --mode/-m 参数并翻译为 CLI 标志
# 用法: pi --mode light 或 pi -m light
resolve_mode() {
  local mode_name=""
  local new_args=()
  local skip_next=false

  for ((i=1; i<=$#; i++)); do
    local arg="${!i}"
    if [ "$skip_next" = true ]; then
      skip_next=false
      continue
    fi
    if [ "$arg" = "--mode" ] || [ "$arg" = "-m" ]; then
      local next_i=$((i+1))
      mode_name="${!next_i}"
      skip_next=true
      continue
    fi
    new_args+=("$arg")
  done

  if [ -z "$mode_name" ]; then
    eval "set -- \"\$@\""
    return
  fi

  # 读取 modes.json 并翻译为 CLI 标志
  local modes_file="$HOME/.pi/agent/modes.json"
  if [ ! -f "$modes_file" ]; then
    echo "[pi-wrapper] 模式配置文件不存在: $modes_file" >&2
    eval "set -- \"\$@\""
    return
  fi

  local mode_config
  mode_config=$(node -e "
    const fs = require('fs');
    try {
      const modes = JSON.parse(fs.readFileSync('$modes_file', 'utf-8'));
      const mode = modes.modes['$mode_name'];
      if (!mode) { console.log('{}'); process.exit(0); }
      console.log(JSON.stringify(mode));
    } catch(e) { console.log('{}'); }
  " 2>/dev/null)

  local extra_args=()

  # 扩展处理：!ALL 禁用所有扩展
  local no_ext
  no_ext=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log((m.extensions||[]).includes('!ALL')?'yes':'no');
  " 2>/dev/null)
  if [ "$no_ext" = "yes" ]; then
    extra_args+=("--no-extensions")
  fi

  # 技能处理：!ALL 禁用所有技能
  local no_skills
  no_skills=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log((m.skills||[]).includes('!ALL')?'yes':'no');
  " 2>/dev/null)
  if [ "$no_skills" = "yes" ]; then
    extra_args+=("--no-skills")
  fi

  # 系统提示词处理
  local sys_prompt
  sys_prompt=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(m.systemPrompt||'');
  " 2>/dev/null)
  if [ -n "$sys_prompt" ] && [ "$sys_prompt" != "null" ]; then
    # 展开 ~ 为 $HOME
    sys_prompt="${sys_prompt/#\~\//$HOME/}"
    extra_args+=("--system-prompt" "$sys_prompt")
  fi

  # 追加系统提示词处理
  local append_prompt
  append_prompt=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(m.appendSystemPrompt||'');
  " 2>/dev/null)
  if [ -n "$append_prompt" ] && [ "$append_prompt" != "null" ]; then
    # 展开 ~ 为 $HOME
    append_prompt="${append_prompt/#\~\//$HOME/}"
    extra_args+=("--append-system-prompt" "$append_prompt")
  fi

  # 设置环境变量供扩展使用
  export PI_AGENT_MODE="$mode_name"
  echo "[pi-wrapper] 启用模式: $mode_name" >&2

  # 合并参数：先插入模式参数，再跟原始参数
  set -- "${extra_args[@]}" "${new_args[@]}"
}

while true; do
  ensure_tmux
  ensure_cron
  # 解析 --mode 参数并应用模式配置
  resolve_mode "$@"
  
  # 启动前创建快照（仅在首次启动或崩溃恢复后）
  if [ "${SNAPSHOT_CREATED:-}" != "1" ]; then
    create_snapshot >/dev/null 2>&1
    SNAPSHOT_CREATED=1
  fi
  
  echo "[pi-wrapper] 启动 Pi... (js: $PI_JS)" >&2
  
  # 捕获 stderr 到临时文件用于崩溃分析
  CRASH_LOG="/tmp/pi-crash-$$.log"
  if [ -f "$PI_JS" ] && echo "$PI_JS" | grep -q '\.js$'; then
    node "$PI_JS" "$@" 2>"$CRASH_LOG"
  else
    "$PI_JS" "$@" 2>"$CRASH_LOG"
  fi
  EXIT_CODE=$?
  echo "[pi-wrapper] Pi 已退出 (code: $EXIT_CODE)" >&2

  ACTION=$(read_state_action)
  echo "[pi-wrapper] 状态: action=$ACTION" >&2

  if [ "$ACTION" = "none" ] || [ -z "$ACTION" ]; then
    # 排除用户主动退出（130=Ctrl+C、143=SIGTERM）
    if [ "$EXIT_CODE" -ne 0 ] && [ "$EXIT_CODE" -ne 130 ] && [ "$EXIT_CODE" -ne 143 ]; then
      # ── 崩溃处理：基于原因分析的智能恢复 ──
      
      # 累计崩溃计数
      crash_count=$(read_crash_count)
      crash_ts=$(read_crash_ts)
      now_ms=$(date +%s%3N)
      if [ "$crash_ts" -gt 0 ] 2>/dev/null && [ $((now_ms - crash_ts)) -gt "$CRASH_WINDOW_MS" ] 2>/dev/null; then
        crash_count=0
      fi
      crash_count=$((crash_count + 1))
      write_crash_count "$crash_count"
      
      # 分析崩溃原因
      CRASH_TYPE=$(analyze_crash "$CRASH_LOG")
      CRASH_SNIPPET=$(get_crash_snippet "$CRASH_LOG")
      echo "[pi-wrapper] 崩溃分析: 类型=$CRASH_TYPE (第 ${crash_count} 次)" >&2
      
      # 检查恢复轮数
      RECOVERY_ROUNDS=$((${RECOVERY_ROUNDS:-0} + 1))
      if [ "$RECOVERY_ROUNDS" -gt "$MAX_RECOVERY_ROUNDS" ]; then
        echo "[pi-wrapper] 已达最大恢复轮数($MAX_RECOVERY_ROUNDS)，停止恢复" >&2
        audit_begin "$CRASH_TYPE" "$CRASH_SNIPPET" "$crash_count" "$EXIT_CODE"
        audit_end "max_rounds_reached" "false" "超过最大恢复轮数"
        rm -f "$CRASH_LOG"
        break
      fi
      
      # 写审计日志（恢复前）
      audit_begin "$CRASH_TYPE" "$CRASH_SNIPPET" "$crash_count" "$EXIT_CODE"
      
      # 检查是否同类型连续失败
      if was_consecutive_fail "$CRASH_TYPE"; then
        echo "[pi-wrapper] 崩溃类型 $crash_type 连续失败，升级恢复策略" >&2
        escalate_recovery "$CRASH_TYPE"
        audit_end "escalate_recovery" "$?" "同类型连续失败，升级到救援模式"
        if health_check; then
          echo "[pi-wrapper] 升级恢复后健康检查通过，重启..." >&2
          rm -f "$CRASH_LOG"
          sleep 1
          set -- "${ORIG_ARGS[@]}" "--continue"
          continue
        fi
        echo "[pi-wrapper] 升级恢复后健康检查失败，停止" >&2
        rm -f "$CRASH_LOG"
        break
      fi
      
      # 根据崩溃类型选择恢复策略
      RECOVERY_OK=false
      case "$CRASH_TYPE" in
        missing_module)
          if recover_missing_module; then
            RECOVERY_OK=true
          else
            # npm install 失败，尝试 L4 源码恢复
            echo "[pi-wrapper] npm install 失败，尝试 L4 源码恢复..." >&2
            recover_from_source && RECOVERY_OK=true
          fi
          ;;
        syntax_error)
          recover_syntax_error && RECOVERY_OK=true
          ;;
        extension_fail)
          recover_extension_fail "$CRASH_LOG" && RECOVERY_OK=true
          ;;
        config_corrupt)
          recover_config_corrupt && RECOVERY_OK=true
          ;;
        proxy_error)
          recover_proxy_error && RECOVERY_OK=true
          ;;
        lock_contention)
          recover_lock_contention && RECOVERY_OK=true
          ;;
        provider_error)
          recover_provider_error && RECOVERY_OK=true
          ;;
        *)
          # unknown 类型：未达阈值时重试，达阈值时升级
          if [ "$crash_count" -ge "$RESCUE_PI_THRESHOLD" ]; then
            echo "[pi-wrapper] 未知崩溃类型，启动 L4 源码恢复 + 救援模式 pi..." >&2
            recover_from_source || start_rescue_pi
            RECOVERY_OK=$?
          elif [ "$crash_count" -ge "$CRASH_THRESHOLD" ]; then
            # 尝试 L4 源码恢复作为中间手段
            if recover_from_source; then
              RECOVERY_OK=true
            else
              recover_provider_error && RECOVERY_OK=true
            fi
          else
            echo "[pi-wrapper] 未知崩溃类型(${crash_count}/${CRASH_THRESHOLD})，1 秒后重试..." >&2
            audit_end "retry" "true" "未知类型，重试累积"
            rm -f "$CRASH_LOG"
            sleep 1
            set -- "${ORIG_ARGS[@]}"
            continue
          fi
          ;;
      esac
      
      # 健康检查
      if [ "$RECOVERY_OK" = true ] && health_check; then
        audit_end "$CRASH_TYPE" "true" "恢复成功，健康检查通过"
        echo "[pi-wrapper] 恢复成功，重启..." >&2
        rm -f "$CRASH_LOG"
        sleep 1
        set -- "${ORIG_ARGS[@]}" "--continue"
        continue
      else
        audit_end "$CRASH_TYPE" "false" "恢复失败或健康检查不通过"
        echo "[pi-wrapper] 恢复失败，停止" >&2
        rm -f "$CRASH_LOG"
        break
      fi
    fi
    
    # 正常退出：记录 lastGood 并清零崩溃计数
    save_lastgood
    write_crash_count 0
    SNAPSHOT_CREATED=0
    RECOVERY_ROUNDS=0
    echo "[pi-wrapper] 正常退出，不重启" >&2
    rm -f "$CRASH_LOG"
    break
  fi

  # 有意的重启（模型切换/会话切换/挂死恢复）：清零崩溃计数
  write_crash_count 0
  RECOVERY_ROUNDS=0

  # Read target info from state file
  TARGET_SESSION=$(read_state_field "targetSession")
  TARGET_MODEL=$(read_state_field "targetModel")

  # Reset state (preserve restartLog for extension on next startup)
  reset_state_preserve_log

  # Reset extra args each iteration to avoid accumulation
  EXTRA_ARGS=()

  if [ "$ACTION" = "switch_session" ] && [ -n "$TARGET_SESSION" ]; then
    EXTRA_ARGS+=(--session "$TARGET_SESSION")
    echo "[pi-wrapper] 目标: 会话 $TARGET_SESSION" >&2
  elif [ "$ACTION" = "set_model" ] && [ -n "$TARGET_MODEL" ]; then
    EXTRA_ARGS+=(--model "$TARGET_MODEL")
    EXTRA_ARGS+=(--continue)
    echo "[pi-wrapper] 目标: 模型 $TARGET_MODEL" >&2
  else
    EXTRA_ARGS+=(--continue)
    echo "[pi-wrapper] 目标: 恢复最近会话" >&2
  fi
  unset TARGET_SESSION TARGET_MODEL

  echo "[pi-wrapper] 1 秒后重启..." >&2
  sleep 1

  # Merge original args with extra args (fresh per iteration)
  set -- "${ORIG_ARGS[@]}" "${EXTRA_ARGS[@]}"
done

rm -f "$CRASH_LOG"
exit "$EXIT_CODE"
