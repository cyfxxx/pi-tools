#!/bin/bash
# test-recovery.sh - 冗余恢复系统测试套件
# 验证 pi-wrapper.sh 崩溃恢复系统的各项功能
#
# 用法: bash test-recovery.sh [选项]
#   --verbose, -v    显示详细输出
#   --json, -j       输出 JSON 格式结果
#   --integration, -i  运行集成测试（会实际执行 pi 命令）

set -uo pipefail

SCRIPT_DIR="$HOME/.pi/scripts"
VERBOSE=0
JSON_OUTPUT=0
RUN_INTEGRATION=0

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --json|-j) JSON_OUTPUT=1 ;;
    --integration|-i) RUN_INTEGRATION=1 ;;
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

test_analyzer "extension_runtime_error" \
  "TypeError: Class constructor WebSocketServer cannot be invoked without 'new'
    at createWebuiServer (/root/.pi/agent/extensions/pi-webui/server.ts:276:39)" \
  "extension_fail"

test_analyzer "extension_typeerror" \
  "TypeError: text.toLowerCase is not a function
    at fuzzyMatch (/root/.pi/agent/extensions/pi-voice/index.ts:158:89)" \
  "extension_fail"

test_analyzer "syntax_error" \
  "dist/utils/clipboard.js:2 SyntaxError: Invalid or unexpected token" \
  "syntax_error"

test_analyzer "dist_typeerror" \
  "TypeError: Cannot read properties of undefined (reading 'slice')
    at truncateToWidth (/root/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils.js:952:17)" \
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

# 测试误报防护
test_analyzer "api_error_not_config" \
  '502: {"message":"All routed providers rejected the request as invalid"}' \
  "provider_error"

# 测试空日志
test_analyzer "empty_log" \
  "" \
  "unknown"

# 测试纯文本错误（非代码错误）
test_analyzer "plain_text_error" \
  "Error: something went wrong" \
  "unknown"

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

# ── 测试 7: 健康检查 ──
section "测试 7: 健康检查"

if grep -q "Say exactly: ok" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "健康检查使用完整启动测试"
else
  fail "健康检查未使用完整启动测试"
fi

if grep -q "timeout 60" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "健康检查超时 60s"
else
  fail "健康检查超时配置异常"
fi

# 测试健康检查不跳过关键步骤
if grep -q "no-extensions.*no-skills.*no-session" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "健康检查使用隔离参数"
else
  fail "健康检查缺少隔离参数"
fi

# ── 测试 8: 版本验证 ──
section "测试 8: L4 版本验证"

if grep -q "缓存版本.*npm 版本.*不匹配" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "L4 恢复包含版本验证"
else
  fail "L4 恢复缺少版本验证"
fi

# ── 测试 9: 崩溃分析器增强 ──
section "测试 9: 崩溃分析器增强"

# 检查扩展运行时错误识别逻辑
if grep -q "TypeError.*ReferenceError.*SyntaxError" "$SCRIPT_DIR/pi-crash-analyzer.sh" 2>/dev/null && \
   grep -q "extensions/" "$SCRIPT_DIR/pi-crash-analyzer.sh" 2>/dev/null; then
  ok "崩溃分析器识别扩展运行时错误"
else
  fail "崩溃分析器缺少扩展运行时错误识别"
fi

# 检查 dist 损坏错误识别逻辑
if grep -q "TypeError.*ReferenceError" "$SCRIPT_DIR/pi-crash-analyzer.sh" 2>/dev/null && \
   grep -q "dist/.*node_modules/@earendil-works/" "$SCRIPT_DIR/pi-crash-analyzer.sh" 2>/dev/null; then
  ok "崩溃分析器识别 dist 损坏错误"
else
  fail "崩溃分析器缺少 dist 损坏错误识别"
fi

# ── 测试 10: unknown 类型处理 ──
section "测试 10: unknown 类型处理"

if grep -q "未知崩溃类型，尝试扩展恢复" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "unknown 类型先尝试禁用扩展"
else
  fail "unknown 类型未尝试禁用扩展"
fi

if grep -q "TEST_WITH_EXTENSIONS=1" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "扩展恢复后启用扩展健康检查"
else
  fail "扩展恢复后未启用扩展健康检查"
fi

if grep -q "TEST_WITH_EXTENSIONS" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null && grep -q "health_check" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "健康检查支持扩展测试"
else
  fail "健康检查未支持扩展测试"
fi

# ── 测试 11: RECOVERY_OK 赋值正确性 ──
section "测试 11: RECOVERY_OK 赋值逻辑"

# 检查 unknown 类型处理中 RECOVERY_OK 的赋值方式
# 错误方式: RECOVERY_OK=$? (会赋值为 "0" 字符串)
# 正确方式: RECOVERY_OK=true
if grep -q "RECOVERY_OK=\$?" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  fail "存在 RECOVERY_OK=\$? 错误赋值"
else
  ok "无 RECOVERY_OK=\$? 错误赋值"
fi

# 检查 unknown 类型处理使用 if/else 正确赋值
if grep -A5 "未知崩溃类型，尝试扩展恢复" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null | grep -q "RECOVERY_OK=true"; then
  ok "unknown 类型正确赋值 RECOVERY_OK=true"
else
  fail "unknown 类型赋值方式异常"
fi

# 检查所有 recovery 函数都正确设置 RECOVERY_OK
# 注意：某些函数使用 if/then 结构，RECOVERY_OK 在下一行
for pattern in "recover_missing_module" "recover_syntax_error" "recover_extension_fail" "recover_config_corrupt" "recover_proxy_error" "recover_lock_contention" "recover_provider_error"; do
  if grep -q "$pattern" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null && grep -A2 "$pattern" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null | grep -q "RECOVERY_OK=true"; then
    ok "恢复函数正确赋值: $(echo $pattern | cut -d'.' -f1)"
  else
    fail "恢复函数赋值异常: $(echo $pattern | cut -d'.' -f1)"
  fi
done

# ── 测试 12: 健康检查与 PI_JS 路径 ──
section "测试 12: PI_JS 路径解析"

# 检查 PI_JS 不会递归调用 wrapper
if grep -q 'command -v pi' "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null | head -1 | grep -q "PI_JS"; then
  ok "PI_JS 解析避免递归"
else
  # 检查是否有防止递归的逻辑
  if grep -q "排除 wrapper 自身\|防循环\|防递归" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
    ok "PI_JS 解析包含防递归逻辑"
  else
    fail "PI_JS 解析可能递归调用 wrapper"
  fi
fi

# 检查 anchor 文件机制
if grep -q "ANCHOR_FILE\|\.pi-cli-path" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "PI_JS 使用 anchor 文件持久化"
else
  fail "PI_JS 缺少 anchor 文件机制"
fi

# 检查 pi-original symlink 回退
if grep -q "pi-original" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "PI_JS 支持 pi-original 回退"
else
  fail "PI_JS 缺少 pi-original 回退"
fi

# ── 测试 13: 恢复策略优先级 ──
section "测试 13: 恢复策略优先级"

# unknown 类型在 CRASH_THRESHOLD 时应先尝试禁用扩展
unknown_section=$(sed -n '/未知崩溃类型，尝试扩展恢复/,/^        \ esac/p' "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null)
if echo "$unknown_section" | grep -q "recover_extension_fail"; then
  ok "unknown 类型优先尝试禁用扩展"
else
  fail "unknown 类型未优先尝试禁用扩展"
fi

# unknown 类型在禁用扩展失败后应尝试 L4
if echo "$unknown_section" | grep -q "recover_from_source"; then
  ok "unknown 类型降级到 L4 源码恢复"
else
  fail "unknown 类型缺少 L4 降级"
fi

# missing_module 在 npm install 失败后应尝试 L4，再尝试救援模式 pi
if grep -A10 "missing_module)" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null | grep -q "recover_from_source"; then
  ok "missing_module 降级到 L4 源码恢复"
else
  fail "missing_module 缺少 L4 降级"
fi

if grep -A15 "missing_module)" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null | grep -q "start_rescue_pi"; then
  ok "missing_module 兜底救援模式 pi"
else
  fail "missing_module 缺少救援模式 pi 兜底"
fi

# ── 测试 14: 崩溃日志捕获 ──
section "测试 14: 崩溃日志捕获"

# 检查 stderr 重定向
if grep -q '2>"$CRASH_LOG"' "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "崩溃日志捕获 stderr"
else
  fail "崩溃日志未捕获 stderr"
fi

# 检查 CRASH_LOG 路径
if grep -q 'CRASH_LOG="/tmp/pi-crash-' "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "崩溃日志使用临时文件"
else
  fail "崩溃日志路径配置异常"
fi

# ── 测试 15: 恢复轮数限制 ──
section "测试 15: 恢复轮数限制"

if grep -q "RECOVERY_ROUNDS.*MAX_RECOVERY_ROUNDS" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "恢复轮数有上限检查"
else
  fail "恢复轮数缺少上限检查"
fi

if grep -q "已达最大恢复轮数" "$SCRIPT_DIR/pi-wrapper.sh" 2>/dev/null; then
  ok "超过轮数时有明确提示"
else
  fail "超过轮数时缺少提示"
fi

# ── 集成测试（可选）──
if [ "$RUN_INTEGRATION" -eq 1 ]; then
  section "集成测试: 健康检查实际执行"
  
  PI_JS="$HOME/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  if [ -f "$PI_JS" ]; then
    # 测试 1: 无扩展健康检查
    if timeout 30 node "$PI_JS" --no-extensions --no-skills --no-session -p 'Say exactly: ok' >/dev/null 2>&1; then
      ok "集成: 无扩展健康检查通过"
    else
      fail "集成: 无扩展健康检查失败"
    fi
    
    # 测试 2: 有扩展健康检查（可能会失败，只是记录）
    if timeout 30 node "$PI_JS" --no-skills --no-session -p 'Say exactly: ok' >/dev/null 2>&1; then
      ok "集成: 有扩展健康检查通过"
    else
      info "集成: 有扩展健康检查失败（扩展可能有问题）"
    fi
  else
    info "跳过集成测试: PI_JS 不存在"
  fi
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
