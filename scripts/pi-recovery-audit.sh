#!/bin/bash
# pi-recovery-audit.sh - Pi 恢复操作审计日志
# 记录每次崩溃恢复的完整上下文，防止越修越坏
#
# 用法: source pi-recovery-audit.sh  (由 pi-wrapper.sh 加载)

AUDIT_LOG="${AUDIT_LOG:-$HOME/.pi/logs/recovery-audit.jsonl}"
AUDIT_DIR="$(dirname "$AUDIT_LOG")"

# 确保日志目录存在
ensure_audit_dir() {
  mkdir -p "$AUDIT_DIR"
}

# 当前恢复会话的临时状态
_AUDIT_CRASH_TYPE=""
_AUDIT_SNIPPET=""
_AUDIT_ACTION=""
_AUDIT_TS_START=0

# audit_begin <crash_type> <snippet> <crash_count> <exit_code>
# 记录恢复操作开始前的状态
audit_begin() {
  local crash_type="$1"
  local snippet="$2"
  local crash_count="$3"
  local exit_code="$4"

  _AUDIT_CRASH_TYPE="$crash_type"
  _AUDIT_SNIPPET="$snippet"
  _AUDIT_TS_START=$(date +%s%3N 2>/dev/null || date +%s)
  _AUDIT_CRASH_COUNT="$crash_count"
  _AUDIT_EXIT_CODE="$exit_code"

  ensure_audit_dir
}

# audit_end <action> <success> [detail]
# 记录恢复操作执行结果
# success: "true" 或 "false"
audit_end() {
  local action="$1"
  local success="$2"
  local detail="${3:-}"
  local ts_end
  ts_end=$(date +%s%3N 2>/dev/null || date +%s)
  local duration_ms=0
  if [ "$_AUDIT_TS_START" -gt 0 ] 2>/dev/null; then
    duration_ms=$((ts_end - _AUDIT_TS_START))
  fi

  # 检查是否同类型连续失败
  local consecutive_fail="false"
  local last_type last_success
  if [ -f "$AUDIT_LOG" ]; then
    last_type=$(tail -1 "$AUDIT_LOG" 2>/dev/null | node -e "
      try { const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.crashType||''); }
      catch(e){ console.log(''); }" 2>/dev/null || echo "")
    last_success=$(tail -1 "$AUDIT_LOG" 2>/dev/null | node -e "
      try { const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.success||false); }
      catch(e){ console.log('false'); }" 2>/dev/null || echo "false")
    if [ "$last_type" = "$_AUDIT_CRASH_TYPE" ] && [ "$last_success" = "false" ]; then
      consecutive_fail="true"
    fi
  fi

  # 写入 JSONL 记录
  local record
  record=$(node -e "
    const rec = {
      ts: ${ts_end},
      crashCount: ${_AUDIT_CRASH_COUNT:-0},
      exitCode: ${_AUDIT_EXIT_CODE:-0},
      crashType: $(node -e "process.stdout.write(JSON.stringify('$_AUDIT_CRASH_TYPE'))" 2>/dev/null || echo '"unknown"'),
      snippet: $(node -e "process.stdout.write(JSON.stringify('$(echo "$_AUDIT_SNIPPET" | head -c 500)'))" 2>/dev/null || echo '"'),
      action: $(node -e "process.stdout.write(JSON.stringify('$(echo "$action" | head -c 200)'))" 2>/dev/null || echo '"'),
      success: $success,
      consecutiveFail: $consecutive_fail,
      durationMs: $duration_ms,
      detail: $(node -e "process.stdout.write(JSON.stringify('$(echo "$detail" | head -c 300)'))" 2>/dev/null || echo '"')
    };
    process.stdout.write(JSON.stringify(rec));
  " 2>/dev/null)

  if [ -n "$record" ]; then
    echo "$record" >> "$AUDIT_LOG"
  fi

  # 重置状态
  _AUDIT_CRASH_TYPE=""
  _AUDIT_SNIPPET=""
  _AUDIT_ACTION=""
  _AUDIT_TS_START=0
}

# was_consecutive_fail <crash_type>
# 检查指定崩溃类型是否上一次也是失败的
# 返回 0=是连续失败 1=不是
was_consecutive_fail() {
  local check_type="$1"
  if [ ! -f "$AUDIT_LOG" ]; then
    return 1
  fi
  local last_type last_success
  last_type=$(tail -1 "$AUDIT_LOG" 2>/dev/null | node -e "
    try { const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.crashType||''); }
    catch(e){ console.log(''); }" 2>/dev/null || echo "")
  last_success=$(tail -1 "$AUDIT_LOG" 2>/dev/null | node -e "
    try { const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.success||false); }
    catch(e){ console.log('false'); }" 2>/dev/null || echo "false")
  if [ "$last_type" = "$check_type" ] && [ "$last_success" = "false" ]; then
    return 0
  fi
  return 1
}

# get_recovery_stats [count]
# 返回最近 N 条审计记录的摘要
get_recovery_stats() {
  local count="${1:-10}"
  if [ ! -f "$AUDIT_LOG" ]; then
    echo "无恢复记录"
    return
  fi
  echo "=== 最近 ${count} 条恢复记录 ==="
  tail -n "$count" "$AUDIT_LOG" | node -e "
    const lines = require('fs').readFileSync(0,'utf8').trim().split('\n');
    lines.forEach((l,i) => {
      try {
        const d = JSON.parse(l);
        const ok = d.success ? '✓' : '✗';
        const date = new Date(d.ts).toISOString().slice(0,19);
        console.log(\`[\${ok}] \${date} crash=\${d.crashCount} type=\${d.crashType} action=\${d.action} \${d.consecutiveFail?'[连续失败]':''}\`);
      } catch(e) {}
    });
  " 2>/dev/null
}

# ── 独立测试模式 ──
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  AUDIT_LOG="${1:-/tmp/test-audit.jsonl}"
  echo "审计日志路径: $AUDIT_LOG"
  echo ""
  echo "=== 模拟恢复记录 ==="
  audit_begin "missing_module" "Cannot find package '@earendil-works/pi-server'" 3 1
  sleep 0.1
  audit_end "npm_install" "true" "installed 101 packages"
  echo ""
  audit_begin "missing_module" "Cannot find package '@earendil-works/pi-server'" 4 1
  sleep 0.1
  audit_end "npm_install" "true" "installed 5 packages"
  echo ""
  get_recovery_stats 5
fi
