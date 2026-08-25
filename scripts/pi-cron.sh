#!/bin/bash
# pi-cron.sh — 离线调度执行器
# 由系统 cron / systemd timer 每分钟调用。
# 检测到 Pi 在线时退出（由扩展处理）；离线时执行到期任务。
set -u

PI_HOME="${PI_HOME:-$HOME/.pi}"
AGENT_DIR="$PI_HOME/agent"
TASKS_FILE="$AGENT_DIR/scheduled-tasks.json"
LOCK_FILE="$AGENT_DIR/scheduler.lock"
LOG_DIR="$PI_HOME/logs/scheduler"
MAX_RUN_TIME="${PI_SCHEDULER_TIMEOUT:-300}"
# 数值校验：PI_SCHEDULER_TIMEOUT 可控，非纯数字回退默认（防直插 Python 字面量位注入）
case "$MAX_RUN_TIME" in ''|*[!0-9]*) MAX_RUN_TIME=300;; esac

mkdir -p "$LOG_DIR"

# ── 定位 pi 可执行文件（cron 环境 PATH 通常不含 node 安装目录）──
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
  echo "[pi-cron] 错误: 找不到 pi 可执行文件，请设置 PI_BIN 环境变量" >&2
  exit 1
fi

# ── wrapper 自愈 ────────────────────────────────────
# pi update 会把 bin/pi 覆盖为官方 symlink（绕过 pi-wrapper.sh）。
# 每次 cron 周期幂等检查:已正确安装则 0 开销退出;被覆盖则自动重装。
if [ -x "$PI_HOME/scripts/install-wrapper.sh" ]; then
  "$PI_HOME/scripts/install-wrapper.sh" --ensure --quiet >> "$LOG_DIR/wrapper-ensure.log" 2>&1 || \
    echo "[pi-cron] wrapper ensure 失败 ($(date '+%F %T'))" >> "$LOG_DIR/scheduler.log"
  # ensure 可能重建 bin/pi，重新定位以保持后续逻辑使用 wrapper
  PI_BIN="$(command -v pi 2>/dev/null || true)"
  [ -z "$PI_BIN" ] && PI_BIN="$(ls "$HOME/.local/share/pi-node"/*/bin/pi 2>/dev/null | head -1 || true)"
fi

# ── 锁检测 ──────────────────────────────────────────
check_lock() {
  if [ ! -f "$LOCK_FILE" ]; then
    # 没有锁文件 — Pi 不在运行
    return 1
  fi
  read -r LOCKED_PID < "$LOCK_FILE" 2>/dev/null || return 1
  LOCKED_PID="${LOCKED_PID%%:*}"  # 锁内容 PID:时间戳（租约格式，审计 LOW 同步）
  # 检查 PID 是否存活（用 /proc 而非 kill -0：proot 下 PID 1 等进程存在但
  # 不可 signal，kill -0 会误判为已死）
  if [ -d "/proc/$LOCKED_PID" ]; then
    return 0  # Pi 正在运行
  fi
  # 僵死锁 — 清理
  rm -f "$LOCK_FILE" 2>/dev/null
  return 1
}

# ── 原子获取锁 ──────────────────────────────────────
# 注意：锁文件与 pi-autopilot 扩展的 acquireSessionLock 共用（scheduler.lock）。
# 锁可能被 pi 进程持有（在线时 cron 应在 check_lock 退出）；这里不得覆盖活跃锁，
# 否则会把 pi 刚写入的锁顶掉（pi 的 150ms 验证失败 → 在线调度+看门狗静默失效）。
acquire_lock() {
  local my_pid=$$
  # 锁已存在且被其他存活进程持有 → 放弃（尊重 pi-autopilot / 并发 cron）。
  # 存活判定用 /proc（kill -0 在 proot 下对不可 signal 进程会误判）
  if [ -f "$LOCK_FILE" ]; then
    local held_pid
    held_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    held_pid="${held_pid%%:*}"  # 锁内容 PID:时间戳（租约格式，审计 LOW 同步）
    if [ -n "$held_pid" ] && [ "$held_pid" != "$my_pid" ] && [ -d "/proc/$held_pid" ]; then
      return 1
    fi
  fi
  # 竞争写入 PID
  echo "$my_pid" > "$LOCK_FILE.tmp.$$" 2>/dev/null || return 1
  mv "$LOCK_FILE.tmp.$$" "$LOCK_FILE" 2>/dev/null || {
    rm -f "$LOCK_FILE.tmp.$$" 2>/dev/null
    return 1
  }
  sleep 0.2
  read -r current_pid < "$LOCK_FILE" 2>/dev/null || return 1
  [ "$current_pid" = "$my_pid" ]
}

# ── 释放锁 ──────────────────────────────────────────
release_lock() {
  read -r current_pid < "$LOCK_FILE" 2>/dev/null || return 0
  [ "$current_pid" = "$$" ] && rm -f "$LOCK_FILE" 2>/dev/null
}

# ── 读取到期任务 + 计算下次运行时间（合并，减少 Python 进程）─
find_due_tasks() {
  python3 -c "
import json, sys, re
from datetime import datetime, timezone, timedelta

def now_local():
    return datetime.now().astimezone()

def _match_field(field, value):
    if field == '*': return True
    for part in field.split(','):
        if '/' in part:
            base, step = part.split('/')
            if '-' in base:
                # 审计 MEDIUM 修复：范围+步长组合（如 1-15/2）此前 int('1-15')
                # 抛 ValueError 被外层 catch 静默跳过任务
                lo, hi, step = int(base.split('-')[0]), int(base.split('-')[1]), int(step)
                if lo <= value <= hi and (value - lo) % step == 0:
                    return True
            else:
                base = 0 if base == '*' else int(base)
                if (value - base) % int(step) == 0 and value >= base:
                    return True
        elif '-' in part:
            lo, hi = part.split('-')
            if int(lo) <= value <= int(hi):
                return True
        else:
            if int(part) == value:
                return True
    return False

def _norm_dow_field(field):
    """POSIX dow 允许 0 与 7 均为周日；cron 侧 value 为 0-6（周日=0），
    将字段中的 7 归一为 0（单值/列表/范围；*/7 步长等价 0,7 即每周日）。"""
    out = []
    for part in field.split(','):
        if '/' in part:
            base, step = part.split('/')
            if int(step) == 7 and (base == '*' or int(base) == 0):
                out.append('0')
            else:
                out.append(part)
        elif '-' in part:
            lo, hi = part.split('-')
            lo_i, hi_i = int(lo), int(hi)
            vals = sorted({v % 7 for v in range(lo_i, hi_i + 1)})
            out.append(','.join(str(v) for v in vals))
        else:
            v = int(part)
            out.append('0' if v == 7 else str(v))
    return ','.join(out)

def compute_next(task_type, schedule, last_run, last_result=''):
    now = now_local()
    if task_type == 'once':
        # 成功执行后不再触发；失败（重试中）允许重算——审计 MEDIUM：此前 last_run
        # 非空即返回 None，失败重试的 nextRun（60s 后）被重算成 None 永不触发
        if last_run and last_result == 'success':
            return None
        m = re.match(r'^\+(\d+)\s*(s|m|h|d)?$', schedule)
        if m:
            n = int(m.group(1))
            u = (m.group(2) or 'm').lower()[0]
            mult = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[u]
            return (now + timedelta(seconds=n * mult)).isoformat()
        try:
            d = datetime.fromisoformat(schedule)
            if d.tzinfo is None: d = d.replace(tzinfo=now.tzinfo)
            return d.isoformat()
        except: return None
    elif task_type == 'interval':
        m = re.match(r'^(\d+)\s*(s|m|h|d|min|hr|sec|day)?s?$', schedule)
        if not m: return None
        n = int(m.group(1))
        u = (m.group(2) or 'm').lower()[0]
        mult = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[u]
        from_time = datetime.fromisoformat(last_run) if last_run else now
        if from_time.tzinfo is None: from_time = from_time.replace(tzinfo=now.tzinfo)
        return (from_time + timedelta(seconds=n * mult)).isoformat()
    elif task_type == 'cron':
        parts = schedule.split()
        if len(parts) < 5: return None
        minute, hour, dom, month, dow = parts
        cur = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
        for _ in range(525600):
            if not _match_field(month, cur.month):
                if cur.month == 12:
                    cur = cur.replace(year=cur.year + 1, month=1, day=1, hour=0, minute=0)
                else:
                    cur = cur.replace(month=cur.month + 1, day=1, hour=0, minute=0)
                continue
            if not _match_field(hour, cur.hour):
                # 审计修复：逐小时推进必须归零分钟（09:59 +1h = 10:59 永远扫不到 09:00 整点，
                # 分钟=0 的调度整点被系统性错过一天）
                cur = cur.replace(minute=0, second=0) + timedelta(hours=1)
                continue
            if dow != '*' and dom != '*':
                # POSIX cron：dom 与 dow 同时受限时任一匹配即触发（OR）——
                # 审计 MEDIUM 修复：此前实现为两者都须匹配（AND）且 dom 匹配时
                # 无条件 continue 跳过 minute 检查，dom 受限的调度永不触发
                cron_dow = (cur.weekday() + 1) % 7
                dow_field = _norm_dow_field(dow)
                if not (_match_field(dow_field, cron_dow) or _match_field(dom, cur.day)):
                    cur = (cur + timedelta(days=1)).replace(hour=0, minute=0)
                    continue
            elif dow != '*':
                cron_dow = (cur.weekday() + 1) % 7
                dow_field = _norm_dow_field(dow)
                if not _match_field(dow_field, cron_dow):
                    cur = (cur + timedelta(days=1)).replace(hour=0, minute=0)
                    continue
            elif dom != '*':
                if not _match_field(dom, cur.day):
                    cur = (cur + timedelta(days=1)).replace(hour=0, minute=0)
                    continue
            if not _match_field(minute, cur.minute):
                cur += timedelta(minutes=1)
                continue
            return cur.isoformat()
        return None
    return None

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    sys.exit(0)

if data.get('settings', {}).get('paused'):
    sys.exit(0)

now = now_local()
due = []
for t in data.get('tasks', []):
    if not t.get('enabled'): continue
    nr = t.get('nextRun')
    if not nr: continue
    try:
        next_dt = datetime.fromisoformat(nr)
        if next_dt.tzinfo is None: next_dt = next_dt.replace(tzinfo=now.tzinfo)
    except: continue
    if next_dt <= now:
        due.append(t)

if not due: sys.exit(0)

due.sort(key=lambda x: x.get('nextRun', ''))
for t in due:
    try:
        t['_next_run'] = compute_next(t.get('type',''), t.get('schedule',''), t.get('lastRun','') or '', t.get('lastResult','') or '')
    except Exception as e:
        # 单任务 schedule 非法（如 'abc * * * *'）不能中断整个批次，只跳过该任务
        print('[pi-cron] 任务 schedule 计算异常，跳过: ' + str(t.get('name', '?')) + ' (' + str(e) + ')', file=sys.stderr)
        continue
    if not t['_next_run']:
        print('[pi-cron] 跳过无法计算下次运行的任务: ' + str(t.get('name', '?')), file=sys.stderr)
        continue
    print(json.dumps(t))
" "$1"
}

# ── 更新任务状态 ────────────────────────────────────
update_task() {
  local task_id="$1"
  local result="$2"
  local output_file="$3"
  local next_run="$4"
  local duration_ms="$5"

  # 数据一律经 sys.argv 传入（直插 python 源码时，含引号/命令替换的任务数据
  # 会语法错误或注入任意命令；审计实测：task_id 含 `'; os.system(...)'` 可执行）
  python3 -c "
import json, sys, os
from datetime import datetime, timezone, timedelta

task_id, result, output_file, next_run, duration_ms = sys.argv[1:6]
tasks_file = sys.argv[6]
with open(tasks_file) as f:
    data = json.load(f)

output_text = ''
try:
    with open(output_file) as f:
        output_text = f.read()[:1000]
except:
    pass

now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
for i, t in enumerate(data.get('tasks', [])):
    if t['id'] != task_id:
        continue
    history = t.get('history') or []
    entry = {
        'time': now,
        'result': result,
        'output': output_text,
    }
    if duration_ms:
        entry['durationMs'] = int(duration_ms)
    history.append(entry)
    if len(history) > 10:
        history = history[-10:]
    t['history'] = history
    t['lastRun'] = now
    t['lastResult'] = result
    t['lastOutput'] = output_text
    t['updatedAt'] = now

    if result == 'success':
        t['failCount'] = 0
        # once 任务成功后自动移除
        if t.get('type') == 'once':
            data['tasks'].pop(i)
            break
        t['runCount'] = t.get('runCount', 0) + 1
        t['nextRun'] = next_run if next_run else None
    else:
        t['failCount'] = t.get('failCount', 0) + 1
        retries = t.get('retries', 0)
        if retries and t['failCount'] <= retries:
            # 失败重试：60s 后再次触发
            t['nextRun'] = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat().replace('+00:00', 'Z')
        else:
            t['runCount'] = t.get('runCount', 0) + 1
            # once 重试耗尽：显式停止（lastResult=failed 时 compute_next 不返回 None，
            # 若沿用 next_run 会把 nextRun 设为未来时间导致任务继续触发）
            if t.get('type') == 'once':
                t['nextRun'] = None
            else:
                t['nextRun'] = next_run if next_run else None
    break

# 写前重读合并（2026-08-25 实测根因修复）：本进程从读到写回期间，主会话 autopilot
# 或 summarizer 后台会话可能已写入新任务；全量覆盖会把它们抹掉（08-24 每日任务
# 丢失根因）。磁盘有而本次快照无的活跃任务补回；同 id 以本次快照优先。
try:
    with open(tasks_file) as f:
        disk = json.load(f)
    have = {t.get('id') for t in data['tasks']}
    for t in disk.get('tasks', []):
        if t.get('id') and t['id'] not in have and not t.get('deleted'):
            data['tasks'].append(t)
except Exception:
    pass

tmp = tasks_file + '.tmp.' + str(os.getpid())
with open(tmp, 'w') as f:
    json.dump(data, f, indent=2)
os.rename(tmp, tasks_file)
" "$task_id" "$result" "$output_file" "$next_run" "$duration_ms" "$TASKS_FILE"
}

# ── 记录执行日志 ────────────────────────────────────
write_log() {
  local task_name="$1"
  local result="$2"
  local output="$3"
  local ts
  ts=$(date -u +"%Y%m%dT%H%M%S")
  local safe_name
  safe_name=$(echo "$task_name" | tr -c 'a-zA-Z0-9_-' '_')
  local log_file="$LOG_DIR/${safe_name}-${ts}.log"
  {
    echo "$task_name | $result | $ts"
    echo "---"
    echo "$output"
  } > "$log_file"
}

# ── 发送邮件/webhook 通知 ───────────────────────────
# 配置来源优先级: 环境变量 > settings.json
send_notification() {
  local task_name="$1"
  local result="$2"
  local output="$3"
  local mail_to="${PI_SCHEDULER_MAIL_TO:-$SETTINGS_MAIL_TO}"
  local webhook="${PI_SCHEDULER_WEBHOOK:-$SETTINGS_WEBHOOK}"

  if [ -n "$mail_to" ] && command -v mail >/dev/null 2>&1; then
    echo "Pi 调度器: $task_name — $result\n\n$output" | \
      mail -s "[Pi Scheduler] $task_name: $result" "$mail_to" 2>/dev/null || true
  fi

  if [ -n "$webhook" ] && command -v curl >/dev/null 2>&1; then
    # 审计 LOW：task_name/result 此前未转义（引号/反斜杠破坏 JSON，curl 静默失败）——
    # 与 output 一致走 json.dumps
    local task_json result_json output_json
    task_json=$(printf '%s' "$task_name" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    result_json=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    output_json=$(printf '%s' "$output" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:1000]))')
    curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"task\":$task_json,\"result\":$result_json,\"time\":\"$(date -u -Iseconds)\",\"output\":$output_json}" \
      "$webhook" >/dev/null 2>&1 || true
  fi
}

# ── 主流程 ──────────────────────────────────────────
main() {
  # 如果 Pi 在线，让扩展处理
  if check_lock; then
    exit 0
  fi

  # 获取锁（防止 cron 自身并发）
  if ! acquire_lock; then
    exit 0  # 锁被其他进程持有
  fi

  # 读取 settings（通知配置），环境变量可覆盖。$() 捕获原文，无 eval 二次求值
  # （旧实现 eval "$(python3 repr())"：值含单引号+命令替换时 repr 切双引号会被执行）
  SETTINGS_MAIL_TO=""
  SETTINGS_WEBHOOK=""
  if [ -f "$TASKS_FILE" ]; then
    SETTINGS_MAIL_TO=$(python3 -c "
import json, sys
try:
    s = json.load(open(sys.argv[1])).get('settings', {})
except Exception:
    s = {}
print(s.get('mailTo', '') or '')
" "$TASKS_FILE")
    SETTINGS_WEBHOOK=$(python3 -c "
import json, sys
try:
    s = json.load(open(sys.argv[1])).get('settings', {})
except Exception:
    s = {}
print(s.get('webhookUrl', '') or '')
" "$TASKS_FILE")
  fi

  # 查找到期任务
  DUE_JSON=$(find_due_tasks "$TASKS_FILE")
  if [ -z "$DUE_JSON" ]; then
    release_lock
    exit 0
  fi

  # 逐条执行到期任务
  while IFS= read -r task_json; do
    [ -z "$task_json" ] && continue

    # 提取字段 + 计算下次运行 + 渲染 prompt 模板（单次 Python 调用，写入临时文件）
    local task_meta_file="/tmp/pi-cron-meta.$$.$RANDOM.json"
    echo "$task_json" | python3 -c "
import json, sys
from datetime import datetime
t = json.load(sys.stdin)
now = datetime.now()
pad = lambda n: str(n).zfill(2)
prompt = t.get('prompt', '')
prompt = prompt.replace('{{date}}', '%d-%02d-%02d' % (now.year, now.month, now.day))
prompt = prompt.replace('{{time}}', '%02d:%02d:%02d' % (now.hour, now.minute, now.second))
prompt = prompt.replace('{{datetime}}', now.isoformat())
prompt = prompt.replace('{{cwd}}', __import__('os').getcwd())
with open('$task_meta_file', 'w') as f:
    json.dump({
        'id': t['id'],
        'name': t['name'],
        'type': t['type'],
        'schedule': t['schedule'],
        'prompt': prompt,
        'timeout': t.get('maxRunTime', $MAX_RUN_TIME),
        'notify': str(t.get('notifyOnCompletion', False)),
        'last_run': t.get('lastRun', '') or '',
        'next_run': t.get('_next_run', '') or '',
    }, f)
"

    # 从临时文件读取字段（单次 Python 进程，行号对应读取）
    {
      read -r task_id
      read -r task_name
      read -r task_type
      read -r task_schedule
      read -r task_timeout
      read -r task_notify
      read -r task_last_run
      read -r NEXT_RUN
      task_prompt=$(cat)
    } < <(python3 -c "
import json
d = json.load(open('$task_meta_file'))
# 字段值中的换行会破坏逐行 read 解析 → 替换为字面量 \\n 保证单行语义
esc = lambda s: str(s).replace(chr(13), '').replace(chr(10), chr(92)+'n')
print(esc(d['id']))
print(esc(d['name']))
print(esc(d['type']))
print(esc(d['schedule']))
print(d['timeout'])
print(d['notify'])
print(esc(d['last_run']))
print(esc(d['next_run']), end='')
# prompt may contain newlines, print raw after a newline separator
print()
print(d['prompt'], end='')
")
    rm -f "$task_meta_file"
    # 任务级 maxRunTime 从 JSON 直取，非纯数字会使 timeout 用法错误(exit 125)被标 failed；
    # 同顶层 PI_SCHEDULER_TIMEOUT 校验，非法回退默认值
    case "$task_timeout" in ''|*[!0-9]*) task_timeout="$MAX_RUN_TIME";; esac

    # 使用 Pi print 模式执行
    echo "[pi-cron] 执行: $task_name ($task_type)"
    local out_file="/tmp/pi-cron-out.$$.$RANDOM"
    local EXEC_START
    EXEC_START=$(date +%s%N)
    PI_UNATTENDED=1 timeout "$task_timeout" "$PI_BIN" -p "$task_prompt" > "$out_file" 2>&1
    EXIT_CODE=$?
    local EXEC_MS
    EXEC_MS=$(( ($(date +%s%N) - EXEC_START) / 1000000 ))
    OUTPUT=$(cat "$out_file" 2>/dev/null || echo "<output lost>")
    rm -f "$out_file"

    # 判断结果
    if [ "$EXIT_CODE" -eq 124 ]; then
      RESULT="failed"
      OUTPUT="[超时] 任务执行超过 ${task_timeout}s"
    elif [ "$EXIT_CODE" -ne 0 ]; then
      RESULT="failed"
    else
      RESULT="success"
    fi

    # 用文件传递 output 避免 shell 转义问题
    local update_input="/tmp/pi-cron-update.$$.$RANDOM"
    echo "$OUTPUT" > "$update_input" 2>/dev/null
    update_task "$task_id" "$RESULT" "$update_input" "$NEXT_RUN" "$EXEC_MS"
    rm -f "$update_input"
    write_log "$task_name" "$RESULT" "$OUTPUT"

    # 通知
    if [ "$task_notify" = "True" ] || [ "$task_notify" = "true" ]; then
      send_notification "$task_name" "$RESULT" "$OUTPUT"
    fi

    echo "[pi-cron] 完成: $task_name → $RESULT"
  done <<< "$DUE_JSON"

  release_lock
}

main "$@"
