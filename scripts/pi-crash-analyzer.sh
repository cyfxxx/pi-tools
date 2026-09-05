#!/bin/bash
# pi-crash-analyzer.sh - Pi 崩溃原因分析器
# 分析 pi 进程的 stderr 输出，分类崩溃类型，指导恢复策略
#
# 用法: source pi-crash-analyzer.sh  (由 pi-wrapper.sh 加载)
#       或 bash pi-crash-analyzer.sh <crash_log_file>  (独立测试)

# ── 崩溃类型常量 ──
CRASH_MISSING_MODULE="missing_module"
CRASH_SYNTAX_ERROR="syntax_error"
CRASH_EXTENSION_FAIL="extension_fail"
CRASH_CONFIG_CORRUPT="config_corrupt"
CRASH_PROXY_ERROR="proxy_error"
CRASH_LOCK_CONTENTION="lock_contention"
CRASH_PROVIDER_ERROR="provider_error"
CRASH_NODE_COMPAT="node_compat"
CRASH_UNKNOWN="unknown"

# ── 分析函数 ──

# analyze_crash <log_file>
# 读取 stderr 日志，返回崩溃类型字符串
analyze_crash() {
  local log_file="$1"
  if [ ! -f "$log_file" ] || [ ! -s "$log_file" ]; then
    echo "$CRASH_UNKNOWN"
    return
  fi

  local content
  content=$(cat "$log_file")

  # 优先级从高到低匹配

  # 1. 缺少 npm 模块（最常见）
  if echo "$content" | grep -q "ERR_MODULE_NOT_FOUND"; then
    # 区分 node: 内置模块 vs npm 包
    if echo "$content" | grep -qE "Cannot find package 'node:"; then
      echo "$CRASH_NODE_COMPAT"
    else
      echo "$CRASH_MISSING_MODULE"
    fi
    return
  fi

  # 2. 扩展加载失败
  if echo "$content" | grep -qE "Failed to load extension|extension.*load.*fail|ExtensionError"; then
    echo "$CRASH_EXTENSION_FAIL"
    return
  fi

  # 3. 语法错误（dist 文件损坏）
  if echo "$content" | grep -qE "SyntaxError: Invalid or unexpected token|Unexpected token|ParseError"; then
    echo "$CRASH_SYNTAX_ERROR"
    return
  fi

  # 4. 配置文件损坏
  if echo "$content" | grep -qE "JSON\.parse|SyntaxError.*JSON|settings.*corrupt|config.*invalid|Unexpected token.*in JSON"; then
    echo "$CRASH_CONFIG_CORRUPT"
    return
  fi

  # 5. 代理/URL 错误
  if echo "$content" | grep -qE "Invalid URL protocol|socks.*proxy|http_proxy|PROXY_URL"; then
    echo "$CRASH_PROXY_ERROR"
    return
  fi

  # 6. 调度锁竞争
  if echo "$content" | grep -qE "无法获取调度锁|already.*held|lock.*contention|EADDRINUSE"; then
    echo "$CRASH_LOCK_CONTENTION"
    return
  fi

  # 7. Provider/API 错误（503/网络问题）
  if echo "$content" | grep -qE "503|server_error|Upstream request failed|ECONNREFUSED|ETIMEDOUT|fetch failed"; then
    echo "$CRASH_PROVIDER_ERROR"
    return
  fi

  echo "$CRASH_UNKNOWN"
}

# get_crash_snippet <log_file> [max_lines]
# 返回错误摘要（默认前 5 行）
get_crash_snippet() {
  local log_file="$1"
  local max_lines="${2:-5}"
  if [ ! -f "$log_file" ] || [ ! -s "$log_file" ]; then
    echo "(无输出)"
    return
  fi
  head -n "$max_lines" "$log_file" 2>/dev/null | tr '\n' ' ' | sed 's/"/\\"/g'
}

# get_failed_extension <log_file>
# 从日志中提取导致崩溃的扩展名
get_failed_extension() {
  local log_file="$1"
  if [ ! -f "$log_file" ]; then
    echo ""
    return
  fi
  # 匹配 "Failed to load extension "xxx"" 或类似模式
  grep -oP 'Failed to load extension "?\K[^"]+' "$log_file" 2>/dev/null | head -1
}

# ── 独立测试模式 ──
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ -z "$1" ]; then
    echo "用法: $0 <crash_log_file>"
    echo "示例: $0 /tmp/pi-crash-12345.log"
    exit 1
  fi
  LOG_FILE="$1"
  echo "=== 崩溃分析结果 ==="
  echo "类型: $(analyze_crash "$LOG_FILE")"
  echo "摘要: $(get_crash_snippet "$LOG_FILE")"
  EXT=$(get_failed_extension "$LOG_FILE")
  [ -n "$EXT" ] && echo "问题扩展: $EXT"
fi
