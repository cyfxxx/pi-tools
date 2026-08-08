#!/usr/bin/env bash
# test-all.sh — pi-tools 一键全量回归
# 5 套扩展测试 + subagent mjs 测试 + 根 typecheck + 扩展冲突检查
# 任一失败以非零码退出并汇总失败清单
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
EXTS="$PI_HOME/agent/extensions"
FAILED=0

red()   { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
cyn()   { printf '\033[0;36m%s\033[0m\n' "$1"; }

report() {
  if [ "$1" -eq 0 ]; then green "✓ $2"; else red "✗ $2"; FAILED=$((FAILED+1)); fi
}

cyn "== vitest 套件 =="
for ext in pi-web-search pi-memory pi-autopilot pi-browser pi-context plan-mode pi-tmux pi-voice; do
  if [ -d "$EXTS/$ext" ]; then
    (cd "$EXTS/$ext" && ./node_modules/.bin/vitest run >/dev/null 2>&1)
    report $? "$ext vitest"
  else
    red "✗ $ext 目录不存在"; FAILED=$((FAILED+1))
  fi
done

cyn "== subagent 独立测试 =="
if [ -d "$EXTS/subagent" ]; then
  (cd "$EXTS/subagent" && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs >/dev/null 2>&1)
  report $? "subagent (34 用例)"
else
  red "✗ subagent 目录不存在"; FAILED=$((FAILED+1))
fi

cyn "== 根 typecheck (tsc) =="
(cd "$EXTS" && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.json --noEmit >/dev/null 2>&1)
report $? "tsc -p tsconfig.json"

cyn "== 扩展冲突检查 =="
(cd "$EXTS" && node tests/conflict-check.mjs >/dev/null 2>&1)
report $? "conflict-check (6 项)"

cyn "== 扩展自动发现完整性（pi 0.83+ 从目录自动加载） =="
python3 -c "
import os
ext_dir = '$EXTS'
required = ['subagent','pi-context','plan-mode','pi-autopilot','pi-memory','pi-web-search','pi-browser','pi-tmux','pi-voice']
missing = [e for e in required if not os.path.isfile(os.path.join(ext_dir, e, 'index.ts'))]
if missing:
    print('missing:', ', '.join(missing))
    raise SystemExit(1)
" >/dev/null 2>&1
report $? "9 个扩展目录 index.ts 齐备"

if [ "$FAILED" -gt 0 ]; then
  printf '\n\033[0;31m✗ 回归失败（%s 项）\033[0m\n' "$FAILED"
  exit 1
else
  printf '\n\033[0;32m✓ 全量回归通过\033[0m\n'
fi
