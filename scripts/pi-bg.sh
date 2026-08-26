#!/bin/bash
# pi-bg.sh — 后台 pi 任务（tmux 承载 headless pi + 四件套隔离）
#
# 背景：pi 执行长任务时前台 TUI 被占用，无法同时对话；双交互 TUI 实例存在
# settings/session/voice 等共享状态冲突。本脚本用 tmux detached 会话跑 headless
# pi（-p 一次性 或 --mode rpc 长驻），通过四件套隔离把冲突面收敛到最小：
#   1. --no-session    后台不写会话文件（前台会话零污染，即使同 cwd）
#   2. --no-extensions 不加载任何扩展（无 voice tmp 清理 / memory 写入 /
#                      autopilot 调度锁 / usage-diag / tmux registry 竞争）
#   3. --tools 软只读集合（默认；含 bash，可执行任意命令——写保护仅 RO_HINT 提示词级
#      约束、非沙箱隔离；--rw 放开完整工具集含 edit/write，风险自负）
#   4. 独立工作目录（默认当前目录，可用 --cwd 指定）与独立日志
#
# 用法:
#   pi-bg.sh start <name> <prompt...>    一次性后台任务（pi -p），跑完日志留 EXIT=
#   pi-bg.sh start --rw <name> <prompt>  同上，但放开完整工具集（可写文件）
#   pi-bg.sh rpc [--rw] <name>           长驻 RPC 模式 pi（可随时注入指令）
#   pi-bg.sh prompt <name> <msg>         向 RPC 实例发送 prompt（新任务/问题）
#   pi-bg.sh steer <name> <msg>          向 RPC 实例发送 steer（打断当前动作改向）
#   pi-bg.sh status [name]               状态：运行中/已结束（含退出码）+ 日志尾部
#   pi-bg.sh log <name> [lines]          查看日志尾部（默认 50 行）
#   pi-bg.sh stop <name>                 停止（kill tmux 会话；日志保留）
#   pi-bg.sh list                        列出所有后台任务
#
# 环境变量: PI_BIN（pi 可执行文件路径，缺省自动定位）
set -u

PI_HOME="${PI_HOME:-$HOME/.pi}"
LOG_DIR="$PI_HOME/logs/bg"
SESS_PREFIX="pi-bg-"
RO_TOOLS="read,ls,grep,bash"     # 默认软只读集合：bash 可执行任意命令，写保护靠 RO_HINT 提示词约束（非沙箱）；glob 非 pi 工具已被 allowlist 忽略

mkdir -p "$LOG_DIR"

# ── 定位 pi 可执行文件（复用 pi-cron.sh 策略）──
PI_BIN="${PI_BIN:-}"
if [ -z "$PI_BIN" ]; then
  PI_BIN="$(command -v pi 2>/dev/null || true)"
fi
if [ -z "$PI_BIN" ]; then
  for c in \
    "$HOME/.local/share/pi-node"/*/bin/pi \
    "$HOME/.nvm/versions/node"/*/bin/pi \
    /usr/local/bin/pi /usr/bin/pi; do
    [ -x "$c" ] && PI_BIN="$c" && break
  done
fi
if [ -z "$PI_BIN" ]; then
  echo "[pi-bg] 错误: 找不到 pi 可执行文件，请设置 PI_BIN" >&2
  exit 1
fi

RO_HINT="[后台任务] 只读模式：禁止修改/创建/删除文件，禁止 git push 等写操作。仅执行只读命令（ls/find/grep/cat/head/tail/stat/du/df/ps/git status/git log 等）。若确需写操作，停止任务并到前台执行。"

sess() { echo "${SESS_PREFIX}$1"; }
log() { echo "[pi-bg] $*"; }

# 任务名校验：name 用于 tmux 会话名与日志路径（$LOG_DIR/$name.log），未净化时
# 含 ../ 可路径穿越，含 ' 可在 tmux 命令串中注入（审计实测）。仅允许字母数字._-
check_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { log "非法任务名 \"$1\"（仅字母数字 . _ -，且不以 - 开头）"; exit 1; }
}

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

# ── 子命令: start ───────────────────────────────────────────────
cmd_start() {
  local rw=0 cwd="$PWD"
  [ "${1:-}" = "--rw" ] && { rw=1; shift; }
  [ "${1:-}" = "--cwd" ] && { cwd="$2"; shift 2; }
  [ $# -lt 2 ] && { usage; exit 1; }
  local name="$1"; shift
  check_name "$name"
  local prompt="$*"
  local s=$(sess "$name") lf="$LOG_DIR/$name.log"
  if tmux has-session -t "$s" 2>/dev/null; then
    log "任务 \"$name\" 已在运行（会话 $s）。先 stop 再 start。"
    exit 1
  fi
  local args="--no-session --no-extensions -p"
  [ "$rw" -eq 0 ] && args="$args --tools $RO_TOOLS"
  [ "$rw" -eq 0 ] && prompt="$RO_HINT

$prompt"
  # prompt 经 base64 传输（避免 shell 转义）；解码后经 stdin 合并进 -p（usage.md: print 模式读取 stdin）
  local b64 pi_bin_q lf_q
  b64=$(python3 -c "import base64,sys;print(base64.b64encode(sys.argv[1].encode('utf-8')).decode())" "$prompt")
  # PI_BIN/日志路径经 %q 转义后拼入 tmux 命令串；cwd 用 tmux -c 指定（独立 argv），
  # 不再 cd 拼串（含 ' 的路径可注入，审计实测）
  pi_bin_q=$(printf %q "$PI_BIN")
  lf_q=$(printf %q "$lf")
  tmux new-session -d -s "$s" -c "$cwd" "echo '$b64' | python3 -c \"import base64,sys;sys.stdout.buffer.write(base64.b64decode(sys.stdin.read().strip()))\" | $pi_bin_q $args > $lf_q 2>&1; echo EXIT=\$? >> $lf_q" || { log "tmux new-session 失败"; exit 1; }
  log "已启动后台任务 \"$name\"（$([ "$rw" -eq 0 ] && echo 只读 || echo 完整工具集)）
  日志: $lf
  状态: pi-bg.sh status $name"
}

# ── 子命令: rpc ─────────────────────────────────────────────────
cmd_rpc() {
  local rw=0 cwd="$PWD"
  [ "${1:-}" = "--rw" ] && { rw=1; shift; }
  [ "${1:-}" = "--cwd" ] && { cwd="$2"; shift 2; }
  [ $# -lt 1 ] && { usage; exit 1; }
  local name="$1"
  check_name "$name"
  local s=$(sess "$name") lf="$LOG_DIR/$name.log"
  if tmux has-session -t "$s" 2>/dev/null; then
    log "任务 \"$name\" 已在运行（会话 $s）。"
    exit 1
  fi
  local args="--no-session --no-extensions --mode rpc"
  [ "$rw" -eq 0 ] && args="$args --tools $RO_TOOLS"
  local pi_bin_q lf_q
  pi_bin_q=$(printf %q "$PI_BIN")
  lf_q=$(printf %q "$lf")
  tmux new-session -d -s "$s" -c "$cwd" "$pi_bin_q $args > $lf_q 2>&1" || { log "tmux new-session 失败"; exit 1; }
  log "已启动 RPC 任务 \"$name\"（$([ "$rw" -eq 0 ] && echo 只读 || echo 完整工具集)）
  注入指令: pi-bg.sh prompt|steer $name \"<消息>\"
  日志: $lf"
}

# ── RPC 注入（prompt / steer） ──────────────────────────────────
rpc_send() {
  local type="$1" name="$2" msg="$3"
  check_name "$name"
  local s=$(sess "$name")
  if ! tmux has-session -t "$s" 2>/dev/null; then
    log "任务 \"$name\" 未在运行。"
    exit 1
  fi
  # msg 经 base64 传入 python（避免引号/换行转义），python 生成 JSON-RPC 行后 send-keys 注入
  local b64 line
  b64=$(printf '%s' "$msg" | python3 -c "import base64,sys;print(base64.b64encode(sys.stdin.buffer.read()).decode())")
  line=$(python3 -c "import base64,json,sys;print(json.dumps({'type':sys.argv[1],'message':base64.b64decode(sys.argv[2]).decode('utf-8')},ensure_ascii=False))" "$type" "$b64")
  tmux send-keys -t "$s" -l "$line"
  tmux send-keys -t "$s" Enter
  log "已向 \"$name\" 发送 $type 指令"
}

# ── 状态 / 日志 / 停止 / 列表 ───────────────────────────────────
cmd_status() {
  local name="${1:-}"
  [ -n "$name" ] && check_name "$name"
  if [ -z "$name" ]; then
    for lf in "$LOG_DIR"/*.log; do
      [ -e "$lf" ] || continue
      local n; n=$(basename "$lf" .log)
      if tmux has-session -t "$(sess "$n")" 2>/dev/null; then
        log "● $n 运行中（$(date -r "$lf" '+%F %T' 2>/dev/null)）"
      else
        local exit_code
        exit_code=$(grep -o 'EXIT=[0-9-]*' "$lf" | tail -1 | cut -d= -f2)
        log "○ $n 已结束（exit ${exit_code:-?}，日志 $lf）"
      fi
    done
    return 0
  fi
  local s=$(sess "$name") lf="$LOG_DIR/$name.log"
  if tmux has-session -t "$s" 2>/dev/null; then
    log "● \"$name\" 运行中，日志尾部:"
  else
    local exit_code
    exit_code=$(grep -o 'EXIT=[0-9-]*' "$lf" 2>/dev/null | tail -1 | cut -d= -f2)
    log "○ \"$name\" 已结束（exit ${exit_code:-?}），日志尾部:"
  fi
  tail -n 15 "$lf" 2>/dev/null || log "（无日志）"
}

cmd_log() {
  local name="${1:-}" lines="${2:-50}"
  [ -z "$name" ] && { usage; exit 1; }
  check_name "$name"
  tail -n "$lines" "$LOG_DIR/$name.log" 2>/dev/null || log "（无日志 $LOG_DIR/$name.log）"
}

cmd_stop() {
  local name="${1:-}"
  [ -z "$name" ] && { usage; exit 1; }
  check_name "$name"
  local s=$(sess "$name")
  if tmux has-session -t "$s" 2>/dev/null; then
    tmux kill-session -t "$s"
    log "已停止 \"$name\"（日志保留在 $LOG_DIR/$name.log）"
  else
    log "任务 \"$name\" 未在运行（可能已结束）"
  fi
}

cmd_list() {
  local any=0
  for lf in "$LOG_DIR"/*.log; do
    [ -e "$lf" ] || continue
    any=1
    local n; n=$(basename "$lf" .log)
    if tmux has-session -t "$(sess "$n")" 2>/dev/null; then
      log "● $n 运行中"
    else
      log "○ $n 已结束"
    fi
  done
  [ "$any" -eq 0 ] && log "（无后台任务记录）"
}

# ── 入口 ────────────────────────────────────────────────────────
case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  rpc)    shift; cmd_rpc "$@" ;;
  prompt) [ $# -lt 3 ] && { usage; exit 1; }; rpc_send prompt "$2" "$3" ;;
  steer)  [ $# -lt 3 ] && { usage; exit 1; }; rpc_send steer "$2" "$3" ;;
  status) shift; cmd_status "$@" ;;
  log)    shift; cmd_log "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  list)   cmd_list ;;
  help|-h|--help|"") usage ;;
  *) log "未知子命令: $1"; usage; exit 1 ;;
esac
