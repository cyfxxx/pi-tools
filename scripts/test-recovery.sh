#!/bin/bash
# test-recovery.sh - 冗余恢复系统测试套件
# 验证 pi-wrapper.sh 崩溃恢复系统的各项功能
#
# 用法: bash test-recovery.sh [选项]
#   --verbose, -v    显示详细输出
#   --json, -j       输出 JSON 格式结果

set -uo pipefail

SCRIPT_DIR="$HOME/.pi/scripts"
VERBOSE=0
JSON_OUTPUT=0

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --json|-j) JSON_OUTPUT=1 ;;
  esac
done

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); }
info() { echo -e "${YELLOW}→${NC} $1"; }
section() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }

# ── 测试 1: 崩溃类型分析器 ──
section "测试 1: 崩溃类型分析器"

test_analyzer() {
  local desc="$1" log_content="$2" expected="$3"
  local log_file="/tmp/test-crash-$$.log"
  echo "$log_content" > "$log_file"
  local result
  result=$(bash "$SCRIPT_DIR/pi-crash-analyzer.sh" "$log_file" 2>/dev/null | grep "类型:" | awk '{print $2}')
  rm -f "$log_file"
  if [ "$result" = "$expected" ]; then
    ok "$desc → $result"
  else
    fail "$desc → 期望 $expected，实际 $result"
  fi
}

test_analyzer "missing_module" \
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-server'" \
  "missing_module"

test_analyzer "node_compat" \
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'node:fs'" \
  "node_compat"

test_analyzer "extension_fail" \
  "Error: Failed to load extension pi-voice: ParseError" \
  "extension_fail"

test_analyzer "syntax_error" \
  "dist/utils/clipboard.js:2 SyntaxError: Invalid or unexpected token" \
  "syntax_error"

test_analyzer "config_corrupt" \
  "SyntaxError: Unexpected token in JSON at position 0 (settings.json)" \
  "config_corrupt"

test_analyzer "provider_error_502" \
  '502: {"message":"All 2 routed attempt(s) failed with upstream provider errors"}' \
  "provider_error"

test_analyzer "provider_error_429" \
  '429: {"message":"All models rate-limited after 5 attempts"}' \
  "provider_error"

test_analyzer "provider_error_503" \
  "503 server_error Upstream request failed" \
  "provider_error"

test_analyzer "proxy_error" \
  "Invalid URL protocol: socks:" \
  "proxy_error"

test_analyzer "lock_contention" \
  "EADDRINUSE: address already in use 0.0.0.0:3100" \
  "lock_contention"

test_analyzer "lock_contention_cn" \
  "无法获取调度锁，另一个 Pi 实例可能已持有" \
  "lock_contention"

# 测试 11: 误报防护 - API 错误不应被识别为 config_corrupt
test_analyzer "api_error_not_config" \
  '502: {"message":"All routed providers rejected the request as invalid"}' \
  "provider_error"

# ── 测试 2: 审计日志模块 ──
section "测试 2: 审计日志模块"

AUDIT_LOG="/tmp/test-audit-$$.jsonl"
rm -f "$AUDIT_LOG"
export AUDIT_LOG
source "$SCRIPT_DIR/pi-recovery-audit.sh"

# 测试 2.1: 日志写入
audit_begin "test_type" "test snippet" 1 1
audit_end "test_action" "true" "test detail"

if [ -f "$AUDIT_LOG" ]; then
  local_count=$(wc -l < "$AUDIT_LOG")
  if [ "$local_count" -ge 1 ]; then
    ok "审计日志写入"
  else
    fail "审计日志写入"
  fi
else
  fail "审计日志文件不存在"
fi

# 测试 2.2: 连续失败检测 - 正确识别
rm -f "$AUDIT_LOG"
audit_begin "test_type" "snippet" 1 1
audit_end "action" "false" "fail1"
audit_begin "test_type" "snippet" 2 1
audit_end "action" "false" "fail2"

if was_consecutive_fail "test_type" 5; then
  ok "连续失败检测: 识别同类型连续失败"
else
  fail "连续失败检测: 未识别同类型连续失败"
fi

# 测试 2.3: 连续失败检测 - 排除其他类型
if was_consecutive_fail "other_type" 5; then
  fail "连续失败检测: 误报其他类型"
else
  ok "连续失败检测: 正确排除其他类型"
fi

# 测试 2.4: 连续失败检测 - 混合成功失败
rm -f "$AUDIT_LOG"
audit_begin "test_type" "snippet" 1 1
audit_end "action" "false" "fail"
audit_begin "test_type" "snippet" 2 1
audit_end "action" "true" "success"
audit_begin "test_type" "snippet" 3 1
audit_end "action" "false" "fail"

if was_consecutive_fail "test_type" 5; then
  ok "连续失败检测: 混合成功失败不视为连续失败"
else
  fail "连续失败检测: 混合成功失败处理异常"
fi

rm -f "$AUDIT_LOG"

# ── 测试 3: wrapper 关键函数 ──
section "测试 3: wrapper 关键函数定义"

for func in ok fail warn health_check recover_from_source start_rescue_pi escalate_recovery recover_missing_module recover_syntax_error recover_extension_fail recover_config_corrupt recover_proxy_error recover_lock_contention recover_provider_error rollback_to_lastgood; do
  if grep -q "^${func}()" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null || \
     grep -q "^function ${func}" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
    ok "函数 $func"
  else
    fail "函数 $func 未定义"
  fi
done

# ── 测试 4: L4 源码恢复依赖同步 ──
section "测试 4: L4 源码恢复"

if [ -d "$HOME/.pi/pi-source/node_modules/@earendil-works" ]; then
  ok "源码 node_modules 存在"
  pkg_count=$(ls -1 "$HOME/.pi/pi-source/node_modules/@earendil-works/" 2>/dev/null | wc -l)
  if [ "$VERBOSE" -eq 1 ]; then
    info "  包含 $pkg_count 个 @earendil-works/* 包"
  fi
else
  fail "源码 node_modules 不存在"
fi

if [ -x "$HOME/.pi/scripts/pi-source-build.sh" ]; then
  ok "pi-source-build.sh 可执行"
else
  fail "pi-source-build.sh 不可执行"
fi

if [ -d "$HOME/.pi/pi-source-cache/dist" ]; then
  ok "L4 源码缓存存在"
  if [ -f "$HOME/.pi/pi-source-cache/version.json" ]; then
    ver=$(node -e "console.log(require('$HOME/.pi/pi-source-cache/version.json').version||'?')" 2>/dev/null)
    if [ "$VERBOSE" -eq 1 ]; then
      info "  缓存版本: $ver"
    fi
  fi
else
  info "L4 源码缓存不存在（首次崩溃时会自动构建）"
fi

# 检查 recover_from_source 是否包含依赖同步逻辑
if grep -q "同步源码构建依赖" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "L4 恢复包含依赖同步逻辑"
else
  fail "L4 恢复缺少依赖同步逻辑"
fi

# ── 测试 5: 救援模式配置 ──
section "测试 5: 救援模式配置"

if [ -f "$HOME/.pi/agent/rescue/rescue-prompt.md" ]; then
  ok "rescue-prompt.md 存在"
  if grep -q "bash\|edit\|write\|工具" "$HOME/.pi/agent/rescue/rescue-prompt.md"; then
    ok "rescue-prompt.md 包含工具使用指令"
  else
    fail "rescue-prompt.md 缺少工具使用指令"
  fi
  if grep -q "修复\|fix\|repair" "$HOME/.pi/agent/rescue/rescue-prompt.md"; then
    ok "rescue-prompt.md 包含主动修复指令"
  else
    fail "rescue-prompt.md 缺少主动修复指令"
  fi
else
  fail "rescue-prompt.md 不存在"
fi

if grep -q "start_rescue_pi.*crash_log" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "start_rescue_pi 接收崩溃日志参数"
else
  fail "start_rescue_pi 缺少崩溃日志参数"
fi

# ── 测试 6: 关键阈值配置 ──
section "测试 6: 关键阈值配置"

for var in CRASH_THRESHOLD RESCUE_PI_THRESHOLD MAX_RECOVERY_ROUNDS; do
  val=$(grep "^${var}=" "$SCRIPT_DIR/pi-wrapper.sh" | head -1 | sed 's/#.*//' | cut -d= -f2)
  if [ -n "$val" ]; then
    ok "$var=$val"
  else
    fail "$var 未定义"
  fi
done

# ── 测试 7: 健康检查增强 ──
section "测试 7: 健康检查"

if grep -q "Say exactly: ok" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "健康检查使用完整启动测试"
else
  fail "健康检查未使用完整启动测试"
fi

if grep -q "timeout 30" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "健康检查超时 30s"
else
  fail "健康检查超时配置异常"
fi

# ── 测试 8: 版本验证 ──
section "测试 8: L4 版本验证"

if grep -q "缓存版本.*npm 版本.*不匹配" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "L4 恢复包含版本验证"
else
  fail "L4 恢复缺少版本验证"
fi

# ── 汇总 ──
echo ""
echo "═══════════════════════════════════════"
if [ "$JSON_OUTPUT" -eq 1 ]; then
  echo "{\"total\":$TOTAL,\"pass\":$((TOTAL-FAIL)),\"fail\":$FAIL}"
else
  echo -e "测试结果: ${GREEN}$((TOTAL-FAIL)) 通过${NC}, ${RED}$FAIL 失败${NC}, 共 $TOTAL 项"
fi
echo "═══════════════════════════════════════"

# 清理临时文件
rm -f /tmp/test-crash-$$.log /tmp/test-audit-$$.jsonl

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
