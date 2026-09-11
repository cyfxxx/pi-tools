#!/bin/bash
# check-cache-impact.sh — 缓存影响声明守门（2026-08-26，源自 dsh 生态 Reasonix 工程纪律）
#
# 两层缓存守门的流程层：tests/cache-guard.mjs 管"注入面指纹漂移"（静态内容），
# 本脚本管"变更须自我声明影响"（流程纪律）。触碰 provider 可见前缀的 diff 必须在
# commit message 里声明 Cache-impact 字段；触碰 prompt 结构路径追加 System-prompt-review。
#
# 用法:
#   check-cache-impact.sh --staged               # 报告 staged 触碰情况（exit 恒 0，供 test-all/手动）
#   check-cache-impact.sh --commit-msg <msgfile> # commit-msg hook 模式：校验 message 字段（违规 exit 1）
#
# commit message 合法格式（敏感 diff 非空时强制）:
#   Cache-impact: <none|low|medium|high> - <理由>
#   System-prompt-review: <复审人或说明>     （仅当触碰 REVIEW_PATHS；拒绝 none/n/a）
# `none` 是合法影响级别（前缀字节不变），但空值/todo/tbd/n.a 一律拒绝。
set -u

PI_HOME="${PI_HOME:-$HOME/.pi}"
cd "$PI_HOME" || { echo "[cache-impact] 无法进入 $PI_HOME"; exit 1; }

# ── 缓存敏感路径：改动可能改变 system prompt / 注入序列字节（与 cache-guard.mjs INJECTION_SURFACE 对齐 + 目录级扩展）──
CACHE_PATHS=(
  'AGENTS.md'
  'docs/AGENTS.md'
  'agent/AGENTS.md'
  'agent/extensions/pi-context/'
  'agent/extensions/pi-memory/inject.ts'
  'agent/lib/prune.ts'
  'agent/lib/context-budget.ts'
  'agent/extensions/subagent/index.ts'
  'agent/extensions/tests/cache-guard.mjs'
)
# ── prompt 结构路径：技能/提示模板/代理模板直接拼入系统提示，变更须署名复审 ──
REVIEW_PATHS=(
  'agent/skills/'
  'agent/prompts/'
  'agent/agents/'
)

mode="${1:-}"
if [ -z "$mode" ]; then
  echo "用法: $0 --staged | --commit-msg <msgfile>"
  exit 2
fi

changed="$(git diff --cached --name-only 2>/dev/null)"
if [ -z "$changed" ]; then
  # 无 staged 变更：hook 场景（--amend 复用旧 message 等）不拦截
  exit 0
fi

hit_cache=""
hit_review=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  for p in "${CACHE_PATHS[@]}"; do
    case "$f" in "$p"*) hit_cache="${hit_cache}  $f"$'\n'; break ;; esac
  done
  for p in "${REVIEW_PATHS[@]}"; do
    case "$f" in "$p"*) hit_review="${hit_review}  $f"$'\n'; break ;; esac
  done
done <<< "$changed"

report() {
  echo "[cache-impact] 缓存敏感 staged 文件:"
  [ -n "$hit_cache" ] && printf '%s' "$hit_cache" || printf '  (无)\n'
  echo "[cache-impact] prompt 结构 staged 文件:"
  [ -n "$hit_review" ] && printf '%s' "$hit_review" || printf '  (无)\n'
}

if [ "$mode" = "--staged" ]; then
  report
  exit 0
fi

# ── commit-msg hook 模式 ──
msgfile="${2:-}"
if [ -z "$msgfile" ] || [ ! -f "$msgfile" ]; then
  echo "[cache-impact] 错误: commit-msg 模式需要有效的 message 文件参数"
  exit 1
fi

# 无敏感触碰 → 直接放行
if [ -z "$hit_cache" ] && [ -z "$hit_review" ]; then
  exit 0
fi

fail() {
  echo "" >&2
  echo "✗ [cache-impact] 提交被拦截: $1" >&2
  echo "  本次提交触碰缓存敏感面:" >&2
  [ -n "$hit_cache" ] && printf '%s' "$hit_cache" >&2
  [ -n "$hit_review" ] && printf '%s' "$hit_review" >&2
  echo "  请在 commit message 中补:" >&2
  echo "    Cache-impact: <none|low|medium|high> - <一句理由>" >&2
  [ -n "$hit_review" ] && echo "    System-prompt-review: <复审人/说明>（拒绝 none）" >&2
  echo "  或使用 git commit --amend 补充字段后重试。" >&2
  exit 1
}

# Cache-impact 字段校验（触碰任一敏感面即要求）
ci_line="$(grep -E '^Cache-impact:' "$msgfile" | head -1)"
[ -z "$ci_line" ] && fail "缺少 Cache-impact 字段"
ci_val="$(printf '%s' "$ci_line" | sed -E 's/^Cache-impact:[[:space:]]*//')"
level="${ci_val%%[[:space:]]*}"
case "$level" in
  none|low|medium|high) ;;
  *) fail "Cache-impact 级别无效（须为 none|low|medium|high）: ${ci_val:0:40}" ;;
esac
level="${ci_val%%[[:space:]]*}"
case "$level" in
  none|low|medium|high) ;;
  *) fail "Cache-impact 级别无效: $level" ;;
esac
reason="$(printf '%s' "$ci_val" | sed -E "s/^$level[[:space:]]*-[[:space:]]*//")"
case "$reason" in
  ''|todo|TODO|tbd|TBD|n/a|N/A|"-"*) fail "Cache-impact 理由缺失或为占位符" ;;
esac

# System-prompt-review 校验（仅 prompt 结构路径）
if [ -n "$hit_review" ]; then
  sp_line="$(grep -E '^System-prompt-review:' "$msgfile" | head -1)"
  [ -z "$sp_line" ] && fail "触碰 prompt 结构路径但缺少 System-prompt-review 字段"
  sp_val="$(printf '%s' "$sp_line" | sed -E 's/^System-prompt-review:[[:space:]]*//')"
  case "$sp_val" in
    ''|none|None|NONE|n/a|N/A|todo|TODO|tbd|TBD) fail "System-prompt-review 不能为空或 none 类占位" ;;
  esac
fi

echo "[cache-impact] ✓ 影响声明校验通过（$level）"
exit 0
