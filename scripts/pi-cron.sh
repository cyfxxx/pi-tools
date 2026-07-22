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

mkdir -p "$LOG_DIR"

# ── 锁检测 ──────────────────────────────────────────
check_lock() {
  if [ ! -f "$LOCK_FILE" ]; then
    # 没有锁文件 — Pi 不在运行
    return 1
  fi
  read -r LOCKED_PID < "$LOCK_FILE" 2>/dev/null || return 1
  # 检查 PID 是否存活
  if kill -0 "$LOCKED_PID" 2>/dev/null; then
    return 0  # Pi 正在运行
  fi
  # 僵死锁 — 清理
  rm -f "$LOCK_FILE" 2>/dev/null
  return 1
}

# ── 原子获取锁 ──────────────────────────────────────
acquire_lock() {
  local my_pid=$$
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

def _match_field(field, value):
    if field == '*': return True
    for part in field.split(','):
        if '/' in part:
            base, step = part.split('/')
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

def compute_next(task_type, schedule, last_run):
    now = datetime.now(timezone.utc)
    if task_type == 'once':
        if last_run: return None
        m = re.match(r'^\+(\d+)\s*(s|m|h|d)?$', schedule)
        if m:
            n = int(m.group(1))
            u = (m.group(2) or 'm').lower()[0]
            mult = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[u]
            return (now + timedelta(seconds=n * mult)).isoformat().replace('+00:00', 'Z')
        try:
            d = datetime.fromisoformat(schedule)
            if d.tzinfo is None: d = d.replace(tzinfo=timezone.utc)
            return d.isoformat().replace('+00:00', 'Z')
        except: return None
    elif task_type == 'interval':
        m = re.match(r'^(\d+)\s*(s|m|h|d|min|hr|sec)?s?$', schedule)
        if not m: return None
        n = int(m.group(1))
        u = (m.group(2) or 'm').lower()[0]
        mult = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[u]
        from_time = datetime.fromisoformat(last_run) if last_run else now
        if from_time.tzinfo is None: from_time = from_time.replace(tzinfo=timezone.utc)
        return (from_time + timedelta(seconds=n * mult)).isoformat().replace('+00:00', 'Z')
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
                cur += timedelta(hours=1)
                continue
            if dow != '*':
                cron_dow = (cur.weekday() + 1) % 7
                if not _match_field(dow, cron_dow):
                    cur += timedelta(days=1)
                    continue
            if dom != '*':
                if not _match_field(dom, cur.day):
                    cur += timedelta(days=1)
                continue
            if not _match_field(minute, cur.minute):
                cur += timedelta(minutes=1)
                continue
            return cur.isoformat().replace('+00:00', 'Z')
        return None
    return None

try:
    with open('$TASKS_FILE') as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    sys.exit(0)

now = datetime.now(timezone.utc)
due = []
for t in data.get('tasks', []):
    if not t.get('enabled'): continue
    nr = t.get('nextRun')
    if not nr: continue
    try:
        next_dt = datetime.fromisoformat(nr)
        if next_dt.tzinfo is None: next_dt = next_dt.replace(tzinfo=timezone.utc)
    except: continue
    if next_dt <= now:
        due.append(t)

if not due: sys.exit(0)

due.sort(key=lambda x: x.get('nextRun', ''))
for t in due:
    t['_next_run'] = compute_next(t.get('type',''), t.get('schedule',''), t.get('lastRun','') or '')
    print(json.dumps(t))
"
}

# ── 更新任务状态 ────────────────────────────────────
update_task() {
  local task_id="$1"
  local result="$2"
  local output_file="$3"
  local next_run="$4"

  python3 -c "
import json, sys
from datetime import datetime, timezone

with open('$TASKS_FILE') as f:
    data = json.load(f)

output_text = ''
try:
    with open('$output_file') as f:
        output_text = f.read()[:1000]
except:
    pass

for t in data.get('tasks', []):
    if t['id'] != '$task_id':
        continue
    t['lastRun'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    t['lastResult'] = '$result'
    t['lastOutput'] = output_text
    t['runCount'] = t.get('runCount', 0) + 1
    if '$next_run':
        t['nextRun'] = '$next_run'
    else:
        t['nextRun'] = None
    t['updatedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

tmp = '$TASKS_FILE.tmp.$$'
with open(tmp, 'w') as f:
    json.dump(data, f, indent=2)
import os
os.rename(tmp, '$TASKS_FILE')
"
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

# ── 发送邮件通知 ────────────────────────────────────
send_notification() {
  local task_name="$1"
  local result="$2"
  local output="$3"
  local mail_to="${PI_SCHEDULER_MAIL_TO:-}"
  local webhook="${PI_SCHEDULER_WEBHOOK:-}"

  if [ -n "$mail_to" ] && command -v mail >/dev/null 2>&1; then
    echo "Pi 调度器: $task_name — $result\n\n$output" | \
      mail -s "[Pi Scheduler] $task_name: $result" "$mail_to" 2>/dev/null || true
  fi

  if [ -n "$webhook" ] && command -v curl >/dev/null 2>&1; then
    curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"task\":\"$task_name\",\"result\":\"$result\",\"time\":\"$(date -u -Iseconds)\"}" \
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

  # 查找到期任务
  DUE_JSON=$(find_due_tasks)
  if [ -z "$DUE_JSON" ]; then
    release_lock
    exit 0
  fi

  # 逐条执行到期任务
  while IFS= read -r task_json; do
    [ -z "$task_json" ] && continue

    # 提取字段 + 计算下次运行（单次 Python 调用，写入临时文件）
    local task_meta_file="/tmp/pi-cron-meta.$$.$RANDOM.json"
    echo "$task_json" | python3 -c "
import json, sys
t = json.load(sys.stdin)
with open('$task_meta_file', 'w') as f:
    json.dump({
        'id': t['id'],
        'name': t['name'],
        'type': t['type'],
        'schedule': t['schedule'],
        'prompt': t['prompt'],
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
print(d['id'])
print(d['name'])
print(d['type'])
print(d['schedule'])
print(d['timeout'])
print(d['notify'])
print(d['last_run'])
print(d['next_run'], end='')
# prompt may contain newlines, print raw after a newline separator
print()
print(d['prompt'], end='')
")
    rm -f "$task_meta_file"

    # 使用 Pi print 模式执行
    echo "[pi-cron] 执行: $task_name ($task_type)"
    local out_file="/tmp/pi-cron-out.$$.$RANDOM"
    timeout "$task_timeout" pi -p "$task_prompt" > "$out_file" 2>&1
    EXIT_CODE=$?
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
    update_task "$task_id" "$RESULT" "$update_input" "$NEXT_RUN"
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
