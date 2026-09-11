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
CIRCUIT_BREAKER_THRESHOLD=5  # 熔断器阈值：连续失败5次触发熔断
CIRCUIT_BREAKER_COOLDOWN=1800  # 熔断器冷却时间：30分钟（秒）
CIRCUIT_BREAKER_FILE="$HOME/.pi/data/circuit-breaker.json"
DISABLED_EXTENSIONS_FILE="$HOME/.pi/data/disabled-extensions.json"

# 加载崩溃分析器和审计日志模块
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/pi-crash-analyzer.sh"
source "$SCRIPT_DIR/pi-recovery-audit.sh"

# 输出函数（从 pi-source-build.sh 移植，供 L4 恢复使用）
ok()   { echo -e "\033[0;32m✓\033[0m $1" >&2; }
fail() { echo -e "\033[0;31m✗\033[0m $1" >&2; }
warn() { echo -e "\033[0;33m⚠\033[0m $1" >&2; }

# 保留崩溃日志用于调试
preserve_crash_log() {
  local crash_log="${1:-}"
  if [ -n "$crash_log" ] && [ -f "$crash_log" ] && [ -s "$crash_log" ]; then
    local preserve_dir="$HOME/.pi/data/logs/crash-logs"
    mkdir -p "$preserve_dir"
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local preserve_file="$preserve_dir/crash_${timestamp}_$$.log"
    cp "$crash_log" "$preserve_file" 2>/dev/null
    echo "[pi-wrapper] 崩溃日志已保留: $preserve_file" >&2
  fi
  rm -f "$crash_log"
}
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

# 启动救援模式 pi：使用最小化配置启动，但保留核心工具（bash/edit/write）
# 用于自动诊断和修复崩溃问题
start_rescue_pi() {
  local crash_log="${1:-}"
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
  
  # 构建救援指令：传递崩溃日志路径，让 pi 直接分析
  local rescue_instruction="读取崩溃日志并修复 pi。"
  if [ -n "$crash_log" ] && [ -f "$crash_log" ]; then
    rescue_instruction="崩溃日志在 $crash_log，请读取分析并修复 pi。"
  fi
  
  # 启动救援模式 pi（保留核心工具，禁用扩展避免干扰）
  # 输出到终端让用户看到救援过程，同时记录到日志
  local rescue_log="/tmp/pi-rescue-$$.log"
  echo "[pi-wrapper] 救援模式 pi 正在执行，请等待..." >&2
  node "$PI_JS" \
    --no-extensions \
    --no-skills \
    --append-system-prompt "$RESCUE_PROMPT" \
    -p "$rescue_instruction" \
    "$@" 2>&1 | tee "$rescue_log"
  local rescue_exit=${PIPESTATUS[0]}
  
  if [ -f "$rescue_log" ] && [ -s "$rescue_log" ]; then
    echo "[pi-wrapper] 救援模式 pi 执行完成，输出已保存到 $rescue_log" >&2
  fi
  
  return $rescue_exit
}

# ── 健康检查 ──

# health_check
# 恢复后验证 pi 是否能正常启动
# 返回 0=健康 1=不健康
health_check() {
  echo "[pi-wrapper] 执行健康检查..." >&2

  # 1. 快速检查：pi --version（验证 Node 可执行 + 入口文件存在）
  if ! timeout 10 node "$PI_JS" --version >/dev/null 2>&1; then
    echo "[pi-wrapper] 健康检查失败：pi --version 无法执行" >&2
    return 1
  fi

  # 2. 完整模块加载测试（无扩展）：-p 会触发完整 CLI 初始化链（含 dist/ 下所有模块 import），
  #    能捕获 SyntaxError / missing export 等 dist 损坏问题。
  #    --no-extensions 排除扩展干扰，只验证核心代码完整性。
  local hc_log="/tmp/pi-health-check-$$.log"
  if ! timeout 60 node "$PI_JS" --no-extensions --no-skills --no-session -p 'Say exactly: ok' >"$hc_log" 2>&1; then
    local hc_exit=$?
    echo "[pi-wrapper] 健康检查失败：核心模块加载未通过 (exit $hc_exit)" >&2
    [ -f "$hc_log" ] && head -5 "$hc_log" >&2
    rm -f "$hc_log"
    return 1
  fi
  rm -f "$hc_log"

  # 3. 扩展加载测试（有扩展）：验证扩展不会导致崩溃
  #    仅在恢复 extension_fail 后执行，避免常规启动时不必要的延迟
  if [ "${TEST_WITH_EXTENSIONS:-0}" = "1" ]; then
    local ext_log="/tmp/pi-health-check-ext-$$.log"
    if ! timeout 30 node "$PI_JS" --no-skills --no-session -p 'Say exactly: ok' >"$ext_log" 2>&1; then
      local ext_exit=$?
      echo "[pi-wrapper] 健康检查失败：扩展加载未通过 (exit $ext_exit)" >&2
      [ -f "$ext_log" ] && head -10 "$ext_log" >&2
      rm -f "$ext_log"
      return 1
    fi
    rm -f "$ext_log"
  fi

  # 4. 进程存活检查：验证 pi 进程能正常运行
  local pi_pid=""
  pi_pid=$(pgrep -f "pi-coding-agent/dist/cli.js" 2>/dev/null | head -1)
  if [ -n "$pi_pid" ]; then
    # 检查进程是否仍在运行
    if ! kill -0 "$pi_pid" 2>/dev/null; then
      echo "[pi-wrapper] 健康检查警告：pi 进程已退出" >&2
      # 不返回失败，因为可能是正常退出
    fi
  fi

  # 5. 磁盘空间检查：确保有足够空间运行
  local disk_usage
  disk_usage=$(df -h "$HOME/.pi" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  if [ -n "$disk_usage" ] && [ "$disk_usage" -gt 90 ]; then
    echo "[pi-wrapper] 健康检查警告：磁盘使用率 ${disk_usage}%（>90%）" >&2
    # 不返回失败，但记录警告
  fi

  echo "[pi-wrapper] 健康检查通过" >&2
  return 0
}

# ── 智能恢复函数 ──

# ── pi 修复分工：wrapper 做检查/测试/启动，pi 做实际修复 ──

# pi_core_ok [pi_js]
# 检查 pi 核心能否正常启动（不含扩展/技能）。
# 返回 0=核心正常（崩溃原因在外部），1=核心损坏（崩溃原因在 pi 自身）。
# 这是"外部问题"与"pi 自身问题"的分界线。
pi_core_ok() {
  local pi_js="${1:-$PI_JS}"
  if [ ! -f "$pi_js" ]; then
    return 1
  fi
  # 注意：不先跑 --version 预检——它也要加载完整 CLI 初始化链（provider 解析），
  # 在慢网关下会超时误报（实测 10s 不够）。直接用完整 probe 一次性判定。
  local log="/tmp/pi-core-probe-$$.log"
  if timeout 90 node "$pi_js" --no-extensions --no-skills --no-session -p 'Say exactly: ok' >"$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  echo "[pi-wrapper] 核心启动失败，日志片段:" >&2
  head -8 "$log" >&2
  rm -f "$log"
  return 1
}

# is_interactive
# 判断当前是否在 TTY 交互环境中（用户能看到 TUI）。
# 非 TTY（cron/autopilot 子进程）时修复仍跑，但不阻塞等待用户。
is_interactive() {
  [ -t 0 ] && [ -t 1 ]
}

# run_fix_pi <mode> <pi_js> <crash_log>
# 启动一个"修复者 pi"，让它读崩溃日志并自行修复。
# mode=external: 用当前 pi（--no-extensions --no-skills），修外部问题。
# mode=self:     用源码缓存的 pi（--no-extensions --no-skills），修 pi 自身。
# 返回 pi 的退出码。输出同时落盘到日志，方便事后审计。
# 超时保护：修复 pi 自身也可能卡住（LLM 慢/挂死），超时后 kill 并返回失败，
# 避免 wrapper 被一个挂死的修复进程无限期阻塞。
run_fix_pi() {
  local mode="$1"
  local pi_js="$2"
  local crash_log="$3"
  local label
  case "$mode" in
    external) label="外部修复（当前 pi，屏蔽扩展/技能）" ;;
    self)     label="自我修复（源码缓存 pi，修 pi 自身）" ;;
    *)        label="修复" ;;
  esac
  echo "[pi-wrapper] === 启动 pi 自修复：$label ===" >&2
  echo "[pi-wrapper] 修复者: $pi_js" >&2
  echo "[pi-wrapper] 崩溃日志: $crash_log" >&2

  local fix_log="/tmp/pi-fix-$$.log"
  local instruction
  # 修复指令：显式要求用 read 读日志、分步修复、输出标记（避免 LLM 猜测导致超时）
  instruction="
1. 用 read 工具读取 $crash_log
2. 分析错误原因
3. 用 edit/write/bash 修复
4. 用 node --check 或 pi --version 验证
5. 最后输出 '修复完成'
"

  # 修复超时：默认 240s（LLM 首请求常需 60-120s），可通过 PI_FIX_TIMEOUT 覆盖
  local fix_timeout="${PI_FIX_TIMEOUT:-240}"

  # 修复过程输出到终端（TTY 时用户可见）+ 落盘日志
  if is_interactive; then
    timeout "$fix_timeout" node "$pi_js" \
      --no-extensions --no-skills --no-session \
      -p "$instruction" 2>&1 | tee "$fix_log"
  else
    timeout "$fix_timeout" node "$pi_js" \
      --no-extensions --no-skills --no-session \
      -p "$instruction" >"$fix_log" 2>&1
  fi
  local exit_code=${PIPESTATUS[0]}

  if [ "$exit_code" -eq 124 ]; then
    echo "[pi-wrapper] 修复 pi 超时（${fix_timeout}s），已终止" >&2
  fi

  if [ -s "$fix_log" ]; then
    echo "[pi-wrapper] 修复输出已保存: $fix_log" >&2
  fi
  return $exit_code
}

# classify_crash <crash_log>
# 判定崩溃属于"pi 自身损坏"还是"外部问题"还是"临时性"。
# 输出: pi_self | external | transient
#   pi_self    — dist/ 核心文件语法错误/缺失（pi 自己坏了，需源码 pi 修复）
#   external   — 扩展/配置/依赖/权限/磁盘等外部原因（pi 本身没问题）
#   transient — 临时性错误（API/网络/超时），直接重试
# 判据：纯日志关键词分析，秒级完成，不启动 pi（启动一次 90s 太慢）。
# 飞行验证 pi_core_ok 仅在修复后做健康检查时使用。
classify_crash() {
  local crash_log="$1"
  [ -f "$crash_log" ] || { echo "external"; return; }

  # 1. 临时性错误：API/网络/超时，直接重试，不修复
  if grep -qE "50[0-9]|429|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|rate.limit|stream interrupted|timeout.*exceeded|Upstream request failed" "$crash_log" 2>/dev/null; then
    echo "transient"
    return
  fi

  # 2. pi 自身损坏：错误明确指向 dist/ 核心文件（cli.js / 核心模块）
  #    关键：路径必须在 pi-coding-agent 的 dist/ 下，而非扩展目录。
  #    扩展目录下的 SyntaxError/ParseError 属于 external（扩展是外部）。
  #    也包括依赖不匹配：SyntaxError: The requested module 'X' does not provide
  #    an export named 'Y' —— 发生在 dist 文件中，根因是 pi 自身依赖链损坏。
  #    从已解析的 PI_JS 推导 npm 全局目录（classify_crash 在主循环调用，PI_JS 已就绪）。
  local global_dir=""
  if [ -n "${PI_JS:-}" ]; then
    global_dir="$(dirname "$(dirname "$(dirname "$PI_JS")")")"
  fi
  [ -z "$global_dir" ] && global_dir="$HOME/.local/share/pi-node/node-v22.23.1-linux-arm64/lib/node_modules/@earendil-works/pi-coding-agent"
  if grep -qE "SyntaxError|ParseError|Unexpected (reserved )?token|Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export named" "$crash_log" 2>/dev/null; then
    # 去掉 ANSI 转义码后再判路径
    local clean
    clean=$(sed 's/\x1b\[[0-9;]*m//g' "$crash_log")
    if echo "$clean" | grep -qE "${global_dir//\//\/}|pi-coding-agent/dist/|pi-coding-agent/index\.js"; then
      echo "pi_self"
      return
    fi
    # 不在核心 dist → external（扩展/配置/依赖）
    echo "external"
    return
  fi

  # 3. 其他错误默认按外部处理（扩展/配置/权限/磁盘等）
  echo "external"
}

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
    
    # 记录被禁用的扩展
    local disabled_list=""
    if [ -f "$DISABLED_EXTENSIONS_FILE" ]; then
      disabled_list=$(cat "$DISABLED_EXTENSIONS_FILE" 2>/dev/null || echo "")
    fi
    if [ -z "$disabled_list" ]; then
      echo "$ext_name" > "$DISABLED_EXTENSIONS_FILE"
    else
      echo "$disabled_list" | grep -q "^${ext_name}$" || echo "$ext_name" >> "$DISABLED_EXTENSIONS_FILE"
    fi
    
    return 0
  fi
  return 1
}

# reenable_disabled_extensions
# 重新启用所有被禁用的扩展（index.ts.disabled → index.ts）
# 在成功恢复后调用，确保下次启动时扩展可用
reenable_disabled_extensions() {
  local reenabled=0
  for ext_dir in "$HOME/.pi/agent/extensions"/*/; do
    if [ -f "$ext_dir/index.ts.disabled" ] && [ ! -f "$ext_dir/index.ts" ]; then
      mv "$ext_dir/index.ts.disabled" "$ext_dir/index.ts" 2>/dev/null && reenabled=$((reenabled + 1))
    fi
  done
  if [ "$reenabled" -gt 0 ]; then
    echo "[pi-wrapper] 已重新启用 $reenabled 个扩展" >&2
    # 清空禁用列表
    rm -f "$DISABLED_EXTENSIONS_FILE"
  fi
}

# recover_missing_module [crash_log]
# 崩溃类型：missing_module — 重新安装缺失的 npm 包或从源码缓存恢复缺失文件
# 从崩溃日志提取具体包名/文件路径，精准恢复；避免盲目 reinstall 整个包
recover_missing_module() {
  local crash_log="${1:-}"
  echo "[pi-wrapper] [恢复] 重装缺失依赖..." >&2

  local global_dir
  global_dir="$(get_pi_global_dir)"

  # 从崩溃日志提取缺失的包名（格式: Cannot find package '<name>'）
  local missing_pkg=""
  if [ -n "$crash_log" ] && [ -f "$crash_log" ]; then
    missing_pkg=$(grep -oP "Cannot find package '\K[^']+" "$crash_log" 2>/dev/null | head -1)
  fi

  # 从崩溃日志提取缺失的模块路径（格式: Cannot find module '<path>'）
  local missing_module=""
  if [ -z "$missing_pkg" ] && [ -n "$crash_log" ] && [ -f "$crash_log" ]; then
    missing_module=$(grep -oP "Cannot find module '\K[^']+" "$crash_log" 2>/dev/null | head -1)
  fi

  if [ -n "$missing_pkg" ]; then
    echo "[pi-wrapper] 缺失包: $missing_pkg" >&2
    # 1. 安装到 pi-coding-agent 的 node_modules
    if [ -d "$global_dir" ]; then
      cd "$global_dir" && npm install "$missing_pkg" 2>&1 | tail -3 >&2
    else
      npm install -g "$missing_pkg" 2>&1 | tail -3 >&2
    fi
    # 2. 写入 package.json 防止下次 reinstall 被删
    if [ -f "$global_dir/package.json" ]; then
      if ! grep -q "$missing_pkg" "$global_dir/package.json" 2>/dev/null; then
        local pkg_ver
        pkg_ver=$(node -e "try{console.log(require('$missing_pkg/package.json').version)}catch{}" 2>/dev/null || echo "")
        if [ -n "$pkg_ver" ]; then
          node -e "
const fs=require('fs'),p='$global_dir/package.json';
const pkg=JSON.parse(fs.readFileSync(p));
pkg.dependencies=pkg.dependencies||{};
pkg.dependencies['$missing_pkg']='$pkg_ver';
fs.writeFileSync(p,JSON.stringify(pkg,null,2));
" 2>/dev/null && echo "[pi-wrapper] 已将 $missing_pkg@$pkg_ver 写入 package.json" >&2
        fi
      fi
    fi
  elif [ -n "$missing_module" ]; then
    # 缺失内部模块（如 migrations.js）：尝试从源码缓存恢复
    echo "[pi-wrapper] 缺失模块: $missing_module" >&2
    local source_cache="$HOME/.pi/pi-source-cache"
    local module_name
    module_name="$(basename "$missing_module")"
    local dest_dir
    dest_dir="$(dirname "$missing_module")"
    
    # 1. 尝试恢复单个文件
    if [ -f "$source_cache/dist/$module_name" ] && [ -d "$dest_dir" ]; then
      cp "$source_cache/dist/$module_name" "$dest_dir/" 2>/dev/null && \
        echo "[pi-wrapper] 已从源码缓存恢复 $module_name" >&2 && return 0
    fi
    
    # 2. 单个文件不存在，尝试恢复整个 dist 目录
    if [ -d "$source_cache/dist" ]; then
      local dist_dir
      dist_dir="$(dirname "$dest_dir")"
      echo "[pi-wrapper] 恢复整个 dist 目录..." >&2
      rm -rf "$dist_dir" 2>/dev/null
      if cp -r "$source_cache/dist" "$dist_dir" 2>/dev/null; then
        echo "[pi-wrapper] 已从源码缓存恢复整个 dist 目录" >&2
        return 0
      fi
    fi
    
    # 3. 源码缓存恢复失败，降级为重装 pi-coding-agent
    echo "[pi-wrapper] 源码缓存恢复失败，重装 pi-coding-agent..." >&2
    if [ -d "$global_dir" ]; then
      npm install --prefix "$global_dir" 2>&1 | tail -3 >&2
    else
      npm install -g @earendil-works/pi-coding-agent 2>&1 | tail -3 >&2
    fi
  else
    # 无法提取包名/模块路径，降级为重装 pi-coding-agent
    echo "[pi-wrapper] 无法识别缺失包，重装 pi-coding-agent..." >&2
    if [ -d "$global_dir" ]; then
      npm install --prefix "$global_dir" 2>&1 | tail -3 >&2
    else
      npm install -g @earendil-works/pi-coding-agent 2>&1 | tail -3 >&2
    fi
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

# extension_source_ok <ext_name>
# 飞行前校验：在禁用/恢复扩展之前，先用 node --check 验证扩展源码能否被解析。
# 返回 0=源码可解析（问题不在源码，可安全禁用），1=源码解析失败（保留现场，不盲目禁用）。
# 设计意图：禁用扩展是"关掉功能"而非"修好功能"。若源码本身有语法错误，
# 禁用只是绕过崩溃，下次更新后同一错误会原样复发（本次 pi-context 顶层 await 即是）。
# 因此解析失败时打印精确行号，交由用户/下次会话修复，而非静默丢功能。
extension_source_ok() {
  local ext_name="$1"
  local ext_dir="$HOME/.pi/agent/extensions/$ext_name"
  local src=""
  # 优先检查 .ts 源码（jiti 解析入口），其次 .js
  if [ -f "$ext_dir/index.ts" ]; then
    src="$ext_dir/index.ts"
  elif [ -f "$ext_dir/index.js" ]; then
    src="$ext_dir/index.js"
  else
    return 0  # 无源码可校验（如纯 dist 扩展），放行
  fi
  # node --check 对 .ts 需 --experimental-strip-types（Node 22.6+）；失败时回退不 strip
  if node --check "$src" >/dev/null 2>&1; then
    return 0
  fi
  if node --experimental-strip-types --check "$src" >/dev/null 2>&1; then
    return 0
  fi
  # 解析失败：输出精确行号，便于定位
  local err_line
  err_line=$(node --check "$src" 2>&1 | grep -oE "^[^:]+:[0-9]+:[0-9]+" | head -1)
  [ -z "$err_line" ] && err_line=$(node --experimental-strip-types --check "$src" 2>&1 | grep -oE "^[^:]+:[0-9]+:[0-9]+" | head -1)
  echo "[pi-wrapper] [诊断] 扩展 $ext_name 源码解析失败：$err_line" >&2
  echo "[pi-wrapper] [诊断] 保留源码现场，不自动禁用（禁用=丢功能，非修复）" >&2
  return 1
}

# recover_extension_fail <log_file>
# 崩溃类型：extension_fail — 智能处理扩展加载失败
recover_extension_fail() {
  local log_file="$1"
  local ext_name
  ext_name="$(get_failed_extension_name "$log_file")"
  
  if [ -z "$ext_name" ]; then
    echo "[pi-wrapper] [恢复] 无法确定问题扩展，尝试禁用所有扩展" >&2
    for ext_dir in "$HOME/.pi/agent/extensions"/*/; do
      [ -f "$ext_dir/index.ts" ] && mv "$ext_dir/index.ts" "$ext_dir/index.ts.disabled" 2>/dev/null
    done
    return 0
  fi
  
  # 飞行前校验：源码能否解析？
  if ! extension_source_ok "$ext_name"; then
    echo "[pi-wrapper] [恢复] 扩展 $ext_name 源码有语法错误，不自动禁用（保留功能，待修复）" >&2
    echo "[pi-wrapper] [恢复] 临时方案：用 -ne 启动（跳过扩展）" >&2
    return 1
  fi
  
  # 检查是否是语法错误（ParseError, SyntaxError）
  if echo "$log_file" | grep -qE "ParseError|SyntaxError|Unexpected token"; then
    # 语法错误：尝试从源码缓存恢复扩展文件
    local source_cache="$HOME/.pi/pi-source-cache"
    local ext_dir="$HOME/.pi/agent/extensions/$ext_name"
    
    # 检查是否有备份的 index.ts
    if [ -f "$ext_dir/index.ts.bak" ]; then
      cp "$ext_dir/index.ts.bak" "$ext_dir/index.ts" 2>/dev/null
      echo "[pi-wrapper] [恢复] 从备份恢复扩展 $ext_name" >&2
      return 0
    fi
    
    # 没有备份，禁用扩展
    echo "[pi-wrapper] [恢复] 扩展 $ext_name 有语法错误，临时禁用" >&2
    disable_extension "$ext_name"
    return 0
  fi
  
  # 非语法错误：检查是否可恢复
  # 如果是运行时错误（TypeError, ReferenceError），尝试禁用
  if echo "$log_file" | grep -qE "TypeError|ReferenceError"; then
    echo "[pi-wrapper] [恢复] 扩展 $ext_name 运行时错误，临时禁用" >&2
    disable_extension "$ext_name"
    return 0
  fi
  
  # 其他错误：禁用扩展
  echo "[pi-wrapper] [恢复] 扩展 $ext_name 加载失败，临时禁用" >&2
  disable_extension "$ext_name"
  return 0
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
# 崩溃类型：provider_error — 指数退避重试（API 错误是临时性的，不回滚模型）
recover_provider_error() {
  local crash_count="${1:-1}"
  # 指数退避：1s, 2s, 4s, 8s, 最大 30s
  local delay=$((2 ** (crash_count - 1)))
  if [ "$delay" -gt 30 ]; then
    delay=30
  fi
  echo "[pi-wrapper] [恢复] API 错误，等待 ${delay}s 后重试..." >&2
  sleep "$delay"
  return 0
}

# recover_cli_argument_error
# 崩溃类型：cli_argument_error — 自动修复参数错误
recover_cli_argument_error() {
  local crash_log="${1:-}"
  echo "[pi-wrapper] [恢复] 检测到 CLI 参数错误..." >&2
  
  # 检查是否是 -m 参数问题
  if echo "$crash_log" | grep -qE "Unknown option: -m"; then
    echo "[pi-wrapper] [恢复] -m 参数未被 wrapper 正确处理，检查 resolve_mode..." >&2
    # 尝试从原始参数中移除 -m 和后续参数
    local new_args=()
    local skip_next=false
    for arg in "${ORIG_ARGS[@]}"; do
      if [ "$skip_next" = true ]; then
        skip_next=false
        continue
      fi
      if [ "$arg" = "-m" ] || [ "$arg" = "--mode" ]; then
        skip_next=true
        continue
      fi
      new_args+=("$arg")
    done
    ORIG_ARGS=("${new_args[@]}")
    echo "[pi-wrapper] [恢复] 已从参数中移除 -m/--mode" >&2
    return 0
  fi
  
  # 其他参数错误，返回失败
  return 1
}

# recover_network_error
# 崩溃类型：network_error — 指数退避重试
recover_network_error() {
  local crash_count="${1:-1}"
  # 指数退避：2s, 4s, 8s, 16s, 最大 60s
  local delay=$((2 ** crash_count))
  if [ "$delay" -gt 60 ]; then
    delay=60
  fi
  echo "[pi-wrapper] [恢复] 网络错误，等待 ${delay}s 后重试..." >&2
  sleep "$delay"
  return 0
}

# recover_oom_error
# 崩溃类型：oom_error — 清理内存并增加 Node.js 内存限制
recover_oom_error() {
  echo "[pi-wrapper] [恢复] 内存不足，尝试清理..." >&2
  
  # 1. 清理系统缓存
  sync 2>/dev/null
  echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
  
  # 2. 检查 Node.js 内存使用
  local node_mem
  node_mem=$(node -e "console.log(process.memoryUsage().rss)" 2>/dev/null || echo "0")
  echo "[pi-wrapper] 当前 Node.js 内存使用: $((node_mem / 1024 / 1024))MB" >&2
  
  # 3. 增加 Node.js 内存限制（如果未设置）
  if [ -z "$NODE_OPTIONS" ]; then
    export NODE_OPTIONS="--max-old-space-size=2048"
    echo "[pi-wrapper] 设置 Node.js 内存限制: 2048MB" >&2
  fi
  
  return 0
}

# recover_disk_full
# 崩溃类型：disk_full — 清理磁盘空间
recover_disk_full() {
  echo "[pi-wrapper] [恢复] 磁盘空间不足，尝试清理..." >&2
  
  # 1. 清理 pi 日志（保留最近7天）
  find "$HOME/.pi/data/logs" -name "*.log" -mtime +7 -delete 2>/dev/null || true
  
  # 2. 清理崩溃日志（保留最近10个）
  find "$HOME/.pi/data/logs/crash-logs" -name "*.log" -type f | head -n -10 | xargs rm -f 2>/dev/null || true
  
  # 3. 清理临时文件
  rm -f /tmp/pi-crash-*.log 2>/dev/null || true
  rm -f /tmp/pi-health-check-*.log 2>/dev/null || true
  
  # 4. 清理 npm 缓存
  npm cache clean --force 2>/dev/null || true
  
  # 5. 检查磁盘空间
  local disk_usage
  disk_usage=$(df -h "$HOME/.pi" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  echo "[pi-wrapper] 清理后磁盘使用率: ${disk_usage}%" >&2
  
  return 0
}

# recover_timeout_error
# 崩溃类型：timeout_error — 进程挂死，强制终止
recover_timeout_error() {
  echo "[pi-wrapper] [恢复] 进程超时，强制终止..." >&2
  
  # 1. 终止所有 pi 进程
  pkill -f "pi-coding-agent/dist/cli.js" 2>/dev/null || true
  sleep 2
  
  # 2. 检查是否有残留进程
  local remaining_pids
  remaining_pids=$(pgrep -f "pi-coding-agent/dist/cli.js" 2>/dev/null || echo "")
  if [ -n "$remaining_pids" ]; then
    echo "[pi-wrapper] 强制终止残留进程: $remaining_pids" >&2
    echo "$remaining_pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
  
  return 0
}

# escalate_recovery <crash_type> [crash_log]
# 升级恢复策略（同类型连续失败时）
escalate_recovery() {
  local crash_type="$1"
  local crash_log="${2:-}"
  echo "[pi-wrapper] [升级] 崩溃类型 $crash_type 连续失败，升级恢复策略..." >&2
  # 先尝试 L4 源码编译恢复
  if recover_from_source; then
    # L4 成功，验证健康状态
    if health_check; then
      return 0
    fi
    echo "[pi-wrapper] [升级] L4 恢复后健康检查失败，尝试救援模式..." >&2
  fi
  # L4 失败或健康检查失败，启动救援模式 pi（传递崩溃日志供分析）
  start_rescue_pi "$crash_log"
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
      local ver hash build_ts
      ver=$(node -e "console.log(require('$cache_version').version||'?')" 2>/dev/null)
      hash=$(node -e "console.log(require('$cache_version').gitHash||'?')" 2>/dev/null)
      build_ts=$(node -e "console.log(require('$cache_version').buildTs||0)" 2>/dev/null)
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

  # 版本验证：检查缓存版本是否与当前 npm 安装版本匹配
  if [ -f "$cache_version" ]; then
    local npm_pkg_json="$global_dir/package.json"
    if [ -f "$npm_pkg_json" ]; then
      local npm_ver cache_ver
      npm_ver=$(node -e "console.log(require('$npm_pkg_json').version||'?')" 2>/dev/null)
      cache_ver=$(node -e "console.log(require('$cache_version').version||'?')" 2>/dev/null)
      if [ "$npm_ver" != "$cache_ver" ] && [ "$npm_ver" != "?" ] && [ "$cache_ver" != "?" ]; then
        echo "[pi-wrapper] [L4] 警告: 缓存版本 ($cache_ver) 与 npm 版本 ($npm_ver) 不匹配" >&2
        echo "[pi-wrapper] [L4] 继续恢复，但可能存在兼容性问题" >&2
      fi
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

  # 同步源码构建依赖：源码 dist 引用 @earendil-works/* 包的新 API，
  # 但 npm 安装的嵌套 node_modules 可能是旧版本。将源码的 workspace 包
  # 复制到 global_dir/node_modules 确保 API 兼容。
  local src_nm="$HOME/.pi/pi-source/node_modules/@earendil-works"
  local dst_nm="$global_dir/node_modules/@earendil-works"
  if [ -d "$src_nm" ]; then
    mkdir -p "$dst_nm"
    for pkg_dir in "$src_nm"/*/; do
      local pkg_name
      pkg_name=$(basename "$pkg_dir")
      # 只同步 coding-agent 实际依赖的包
      if [ -d "$pkg_dir/dist" ]; then
        rm -rf "$dst_nm/$pkg_name" 2>/dev/null
        cp -r "$pkg_dir" "$dst_nm/$pkg_name" 2>/dev/null
      fi
    done
    echo "[pi-wrapper] [L4] 已同步源码构建依赖" >&2
  fi

  echo "[pi-wrapper] [L4] 已从源码缓存恢复 pi" >&2
  # 等待文件系统同步，避免健康检查时模块加载不完整
  sleep 2

  # 验证恢复后的 dist 是否可用（快速检查模块加载）
  if ! timeout 10 node "$npm_dist/cli.js" --version >/dev/null 2>&1; then
    echo "[pi-wrapper] [L4] 恢复后验证失败，尝试恢复备份..." >&2
    if [ -d "$backup_dir" ]; then
      rm -rf "$npm_dist"
      cp -r "$backup_dir" "$npm_dist"
      echo "[pi-wrapper] [L4] 已恢复备份 dist" >&2
    fi
    return 1
  fi

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

# ── 熔断器 ──

# read_circuit_breaker
# 读取熔断器状态
# 返回: 0=正常 1=熔断中
read_circuit_breaker() {
  if [ ! -f "$CIRCUIT_BREAKER_FILE" ]; then
    return 1
  fi
  node -e "
    const fs = require('fs');
    try {
      const cb = JSON.parse(fs.readFileSync('$CIRCUIT_BREAKER_FILE', 'utf-8'));
      if (cb.tripped && cb.cooldownEnd) {
        const now = Date.now();
        if (now < cb.cooldownEnd) {
          console.log('tripped');
          process.exit(0);
        }
        // 冷却期结束，重置熔断器
        cb.tripped = false;
        cb.consecutiveFails = 0;
        cb.cooldownEnd = 0;
        fs.writeFileSync('$CIRCUIT_BREAKER_FILE', JSON.stringify(cb, null, 2));
      }
      process.exit(1);
    } catch(e) { process.exit(1); }
  " 2>/dev/null
  if [ $? -eq 0 ]; then
    return 0
  fi
  return 1
}

# write_circuit_breaker
# 更新熔断器状态
# 参数: $1=是否跳闸 (true/false) $2=连续失败次数
write_circuit_breaker() {
  local tripped="$1"
  local consecutive_fails="${2:-0}"
  node -e "
    const fs = require('fs');
    let cb = { tripped: false, consecutiveFails: 0, cooldownEnd: 0 };
    try { cb = JSON.parse(fs.readFileSync('$CIRCUIT_BREAKER_FILE', 'utf-8')); } catch(e) {}
    cb.tripped = '$tripped' === 'true';
    cb.consecutiveFails = $consecutive_fails;
    if (cb.tripped && !cb.cooldownEnd) {
      cb.cooldownEnd = Date.now() + ($CIRCUIT_BREAKER_COOLDOWN * 1000);
    } else if (!cb.tripped) {
      cb.cooldownEnd = 0;
    }
    fs.writeFileSync('$CIRCUIT_BREAKER_FILE', JSON.stringify(cb, null, 2));
  " 2>/dev/null
}

# check_circuit_breaker
# 检查熔断器状态，如果熔断则等待冷却时间
# 返回: 0=正常可以继续 1=熔断中应停止
check_circuit_breaker() {
  if read_circuit_breaker; then
    echo "[pi-wrapper] 熔断器触发，恢复操作暂停中..." >&2
    # 计算剩余冷却时间
    local remaining
    remaining=$(node -e "
      const fs = require('fs');
      try {
        const cb = JSON.parse(fs.readFileSync('$CIRCUIT_BREAKER_FILE', 'utf-8'));
        const remaining = Math.max(0, cb.cooldownEnd - Date.now());
        console.log(Math.ceil(remaining / 1000));
      } catch(e) { console.log(0); }
    " 2>/dev/null || echo "0")
    echo "[pi-wrapper] 剩余冷却时间: ${remaining}s" >&2
    return 1
  fi
  return 0
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

# validate_config
# 校验 pi 配置文件是否有效
# 返回 0=有效 1=无效
validate_config() {
  echo "[pi-wrapper] 校验配置文件..." >&2
  local config_valid=true
  
  # 校验 settings.json
  if [ -f "$SETTINGS_FILE" ]; then
    if ! node -e "JSON.parse(require('fs').readFileSync('$SETTINGS_FILE', 'utf-8'))" 2>/dev/null; then
      echo "[pi-wrapper] 配置错误: settings.json 格式无效" >&2
      config_valid=false
    fi
  fi
  
  # 校验 models.json
  local models_file="$HOME/.pi/agent/models.json"
  if [ -f "$models_file" ]; then
    if ! node -e "JSON.parse(require('fs').readFileSync('$models_file', 'utf-8'))" 2>/dev/null; then
      echo "[pi-wrapper] 配置错误: models.json 格式无效" >&2
      config_valid=false
    fi
  fi
  
  # 校验 modes.json
  local modes_file="$HOME/.pi/agent/modes.json"
  if [ -f "$modes_file" ]; then
    if ! node -e "JSON.parse(require('fs').readFileSync('$modes_file', 'utf-8'))" 2>/dev/null; then
      echo "[pi-wrapper] 配置错误: modes.json 格式无效" >&2
      config_valid=false
    fi
  fi
  
  if [ "$config_valid" = false ]; then
    echo "[pi-wrapper] 配置校验失败，尝试从快照恢复..." >&2
    return 1
  fi
  
  echo "[pi-wrapper] 配置校验通过" >&2
  return 0
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
# 输出: RESOLVED_ARGS 数组（全局变量），调用方用 set -- "${RESOLVED_ARGS[@]}" 应用
RESOLVED_ARGS=()
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

  # 没有 -m/--mode 时，fallback 到 modes.json 的 current 字段
  if [ -z "$mode_name" ]; then
    local current_mode
    current_mode=$(node -e "
      const fs = require('fs');
      try {
        const modes = JSON.parse(fs.readFileSync('$HOME/.pi/agent/modes.json', 'utf-8'));
        console.log(modes.current || modes.default || 'full');
      } catch(e) { console.log('full'); }
    " 2>/dev/null)
    if [ -n "$current_mode" ] && [ "$current_mode" != "full" ]; then
      mode_name="$current_mode"
      echo "[pi-wrapper] 无 -m 參數，fallback 到 modes.json current: $mode_name" >&2
    fi
  fi

  # 沒有模式參數，直接返回（使用已过滤的 new_args，避免裸 -m/--mode 泄漏到 CLI）
  if [ -z "$mode_name" ]; then
    RESOLVED_ARGS=("${new_args[@]}")
    return
  fi

  # 更新 modes.json 的 current 字段（pi-mode 扩展会读取此字段）
  local modes_file="$HOME/.pi/agent/modes.json"
  if [ -f "$modes_file" ]; then
    node -e "
      const fs = require('fs');
      try {
        const modes = JSON.parse(fs.readFileSync('$modes_file', 'utf-8'));
        if (modes.current !== '$mode_name') {
          modes.current = '$mode_name';
          fs.writeFileSync('$modes_file', JSON.stringify(modes, null, 2) + '\n');
        }
      } catch(e) {}
    " 2>/dev/null
  fi

  # 讀取模式配置
  local modes_file="$HOME/.pi/agent/modes.json"
  if [ ! -f "$modes_file" ]; then
    echo "[pi-wrapper] 模式配置文件不存在: $modes_file" >&2
    RESOLVED_ARGS=("${new_args[@]}")
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

  # 扩展处理：支持 !ALL（禁用全部）和 !name（排除特定扩展）
  local ext_excludes
  ext_excludes=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    const exts = m.extensions || [];
    if (exts.includes('!ALL')) { console.log('ALL'); process.exit(0); }
    const excludes = exts.filter(e => e.startsWith('!')).map(e => e.slice(1));
    if (excludes.length > 0) console.log(excludes.join(','));
    else console.log('');
  " 2>/dev/null)
  
  if [ "$ext_excludes" = "ALL" ]; then
    extra_args+=("--no-extensions")
  elif [ -n "$ext_excludes" ]; then
    # 有排除列表：先禁用自动发现，再逐个加载允许的扩展
    extra_args+=("--no-extensions")
    local ext_dir="$HOME/.pi/agent/extensions"
    for ext_path in "$ext_dir"/*/; do
      local ext_name
      ext_name="$(basename "$ext_path")"
      # 跳过非扩展目录
      [ ! -f "$ext_path/package.json" ] && continue
      [ ! -f "$ext_path/index.ts" ] && continue
      # 检查是否在排除列表中
      if echo ",$ext_excludes," | grep -q ",$ext_name,"; then
        echo "[pi-wrapper] 模式排除扩展: $ext_name" >&2
        continue
      fi
      extra_args+=("--extension" "$ext_path")
    done
  fi

  # 技能：!ALL
  local no_skills
  no_skills=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log((m.skills||[]).includes('!ALL')?'yes':'no');
  " 2>/dev/null)
  if [ "$no_skills" = "yes" ]; then
    extra_args+=("--no-skills")
  fi

  # 上下文文件：非 full 模式禁用 AGENTS.md/CLAUDE.md
  if [ "$mode_name" != "full" ]; then
    extra_args+=("--no-context-files")
  fi

  # 系统提示词
  local sys_prompt
  sys_prompt=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(m.systemPrompt||'');
  " 2>/dev/null)
  if [ -n "$sys_prompt" ] && [ "$sys_prompt" != "null" ]; then
    sys_prompt="${sys_prompt/#\~\//$HOME/}"
    extra_args+=("--system-prompt" "$sys_prompt")
  fi

  # 追加系统提示词
  local append_prompt
  append_prompt=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(m.appendSystemPrompt||'');
  " 2>/dev/null)
  if [ -n "$append_prompt" ] && [ "$append_prompt" != "null" ]; then
    append_prompt="${append_prompt/#\~\//$HOME/}"
    extra_args+=("--append-system-prompt" "$append_prompt")
  fi

  # 设置环境变量
  export PI_AGENT_MODE="$mode_name"
  echo "[pi-wrapper] 启用模式: $mode_name" >&2

  # 合并参数到全局变量 RESOLVED_ARGS（函数内 set -- 不传播到调用方）
  RESOLVED_ARGS=("${extra_args[@]}" "${new_args[@]}")
}
while true; do
  ensure_tmux
  ensure_cron
  # 解析 --mode/-m 參數並應用模式配置
  resolve_mode "$@"
  set -- "${RESOLVED_ARGS[@]}"
  
  
  
  # 启动前创建快照（仅在首次启动或崩溃恢复后）
  if [ "${SNAPSHOT_CREATED:-}" != "1" ]; then
    create_snapshot >/dev/null 2>&1
    SNAPSHOT_CREATED=1
  fi
  
  # 启动前校验配置文件
  if ! validate_config; then
    echo "[pi-wrapper] 配置校验失败，尝试从快照恢复..." >&2
    if [ -d "$SNAPSHOT_DIR" ]; then
      local latest_snapshot
      latest_snapshot=$(ls -1d "$SNAPSHOT_DIR"/snapshot_* 2>/dev/null | tail -1)
      if [ -n "$latest_snapshot" ] && restore_snapshot "$latest_snapshot"; then
        echo "[pi-wrapper] 从快照恢复配置成功" >&2
      fi
    fi
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
      
      # 检查熔断器状态
      if check_circuit_breaker; then
        echo "[pi-wrapper] 熔断器正常，继续恢复..." >&2
      else
        echo "[pi-wrapper] 熔断器触发，停止恢复" >&2
        audit_begin "$CRASH_TYPE" "$CRASH_SNIPPET" "$crash_count" "$EXIT_CODE"
        audit_end "circuit_breaker" "false" "熔断器触发，暂停恢复"
        preserve_crash_log "$CRASH_LOG"
        break
      fi
      
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
        preserve_crash_log "$CRASH_LOG"
        break
      fi
      
      # 写审计日志（恢复前）
      audit_begin "$CRASH_TYPE" "$CRASH_SNIPPET" "$crash_count" "$EXIT_CODE"
      
      # 检查是否同类型连续失败
      if was_consecutive_fail "$CRASH_TYPE"; then
        echo "[pi-wrapper] 崩溃类型 $CRASH_TYPE 连续失败，升级恢复策略" >&2
        escalate_recovery "$CRASH_TYPE" "$CRASH_LOG"
        audit_end "escalate_recovery" "$?" "同类型连续失败，升级到救援模式"
        if health_check; then
          echo "[pi-wrapper] 升级恢复后健康检查通过，重启..." >&2
          RECOVERY_ROUNDS=0
          preserve_crash_log "$CRASH_LOG"
          sleep 1
          set -- "${ORIG_ARGS[@]}" "--continue"
          continue
        fi
        echo "[pi-wrapper] 升级恢复后健康检查失败，停止" >&2
        preserve_crash_log "$CRASH_LOG"
        break
      fi
      
      # ── 新恢复逻辑：wrapper 做分类/启动，pi 做实际修复 ──
      # 1. 分类崩溃：pi 自身损坏 vs 外部问题 vs 临时性
      local crash_class
      crash_class=$(classify_crash "$CRASH_LOG")
      echo "[pi-wrapper] 崩溃分类: $crash_class (原类型=$CRASH_TYPE)" >&2

      RECOVERY_OK=false
      case "$crash_class" in
        transient)
          # 临时性错误（API/网络/超时）：指数退避重试，不修复
          echo "[pi-wrapper] 检测到临时性错误，指数退避重试..." >&2
          if recover_provider_error "$crash_count"; then
            RECOVERY_OK=true
          elif recover_network_error "$crash_count"; then
            RECOVERY_OK=true
          elif recover_timeout_error; then
            RECOVERY_OK=true
          fi
          ;;

        external)
          # pi 核心正常，外部问题（扩展/配置/依赖/权限/磁盘）→ 用当前 pi（屏蔽扩展）自修复
          echo "[pi-wrapper] === 路径 A：外部问题，用当前 pi 修复（屏蔽扩展/技能） ===" >&2
          if run_fix_pi external "$PI_JS" "$CRASH_LOG"; then
            RECOVERY_OK=true
          else
            echo "[pi-wrapper] 外部修复 pi 失败，尝试传统恢复链..." >&2
            # 回退到原有细粒度恢复（不破坏兼容）
            case "$CRASH_TYPE" in
              extension_fail)
                if recover_extension_fail "$CRASH_LOG"; then
                  RECOVERY_OK=true
                  TEST_WITH_EXTENSIONS=1
                fi
                ;;
              config_corrupt)
                if recover_config_corrupt; then RECOVERY_OK=true; fi
                ;;
              missing_module)
                if recover_missing_module "$CRASH_LOG"; then RECOVERY_OK=true; fi
                ;;
              permission_error)
                if [ -d "$HOME/.pi" ]; then chmod -R u+rw "$HOME/.pi" 2>/dev/null; RECOVERY_OK=true; fi
                ;;
              disk_full)
                if recover_disk_full; then RECOVERY_OK=true; fi
                ;;
              lock_contention)
                if recover_lock_contention; then RECOVERY_OK=true; fi
                ;;
              *)
                # 其他外部问题让 pi 重试
                if run_fix_pi external "$PI_JS" "$CRASH_LOG"; then RECOVERY_OK=true; fi
                ;;
            esac
          fi
          ;;

        pi_self)
          # pi 自身损坏（dist 语法错误/缺失/核心模块损坏）→ 用源码缓存的 pi 修复坏的 pi
          echo "[pi-wrapper] === 路径 B：pi 自身损坏，用源码缓存 pi 修复 pi ===" >&2
          local good_pi="$PI_SOURCE_CACHE/dist/cli.js"
          if [ ! -f "$good_pi" ]; then
            echo "[pi-wrapper] 源码缓存 pi 不存在，尝试实时构建..." >&2
            if [ -x "$HOME/.pi/scripts/pi-source-build.sh" ]; then
              bash "$HOME/.pi/scripts/pi-source-build.sh" 2>&1 | tail -5 >&2
            fi
          fi
          if [ -f "$good_pi" ]; then
            if run_fix_pi self "$good_pi" "$CRASH_LOG"; then
              RECOVERY_OK=true
            else
              echo "[pi-wrapper] 源码 pi 自修复失败，尝试 recover_from_source..." >&2
              if recover_from_source; then
                RECOVERY_OK=true
              fi
            fi
          else
            echo "[pi-wrapper] 无可用的源码 pi，回退 recover_from_source..." >&2
            if recover_from_source; then
              RECOVERY_OK=true
            fi
          fi
          ;;
      esac

      # 健康检查
      if [ "$RECOVERY_OK" = true ] && health_check; then
        audit_end "$CRASH_TYPE" "true" "恢复成功，健康检查通过"
        echo "[pi-wrapper] 恢复成功，重启..." >&2
        reenable_disabled_extensions
        write_circuit_breaker "false" 0  # 重置熔断器
        RECOVERY_ROUNDS=0
        preserve_crash_log "$CRASH_LOG"
        sleep 1
        set -- "${ORIG_ARGS[@]}" "--continue"
        continue
      else
        # 恢复失败：尝试下一个策略而非立即停止
        echo "[pi-wrapper] 当前恢复策略失败，尝试其他策略..." >&2
        audit_end "$CRASH_TYPE" "false" "恢复失败或健康检查不通过，尝试其他策略"
        preserve_crash_log "$CRASH_LOG"
        
        if [ "$crash_count" -ge "$CIRCUIT_BREAKER_THRESHOLD" ]; then
          write_circuit_breaker "true" "$crash_count"
          echo "[pi-wrapper] 连续失败 ${crash_count} 次，触发熔断器" >&2
        fi
        
        if [ "$RECOVERY_ROUNDS" -lt "$MAX_RECOVERY_ROUNDS" ]; then
          sleep 1
          set -- "${ORIG_ARGS[@]}"
          continue
        fi
        echo "[pi-wrapper] 已达最大恢复轮数($MAX_RECOVERY_ROUNDS)，停止恢复" >&2
        break
      fi
    fi
    
    # 正常退出：记录 lastGood 并清零崩溃计数
    save_lastgood
    write_crash_count 0
    reenable_disabled_extensions
    SNAPSHOT_CREATED=0
    RECOVERY_ROUNDS=0
    echo "[pi-wrapper] 正常退出，不重启" >&2
    preserve_crash_log "$CRASH_LOG"
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

preserve_crash_log "$CRASH_LOG"
exit "$EXIT_CODE"
