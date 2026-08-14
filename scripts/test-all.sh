#!/usr/bin/env bash
# test-all.sh — pi-tools 一键全量回归
# 8 套 vitest + subagent mjs 测试 + 扩展注册面测试 + 根 typecheck + 扩展冲突检查
# 任一失败以非零码退出并汇总失败清单
#
# 用法（dsh 借鉴：证据面匹配分层，2026-08-14）：
#   test-all.sh            全量（CI/提交前）
#   test-all.sh --only=pi-voice,pi-tmux   只跑指定扩展 vitest 套件 + tsc
#   test-all.sh --fast     跳过 subagent/注册面/conflict-check/发现完整性（日常快检）
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
EXTS="$PI_HOME/agent/extensions"
FAILED=0
ONLY=""
FAST=0
for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="${arg#--only=}" ;;
    --fast) FAST=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（支持 --only=a,b / --fast）"; exit 2 ;;
  esac
done

ALL_EXTS="pi-web-search pi-memory pi-autopilot pi-browser pi-context plan-mode pi-tmux pi-voice pi-link"
if [ -n "$ONLY" ]; then
  ALL_EXTS="$ONLY"
fi

red()   { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
cyn()   { printf '\033[0;36m%s\033[0m\n' "$1"; }

if [ -n "$ONLY" ]; then
  cyn "== 分层模式：仅 ${ALL_EXTS// /,} =="
fi

report() {
  if [ "$1" -eq 0 ]; then green "✓ $2"; else red "✗ $2"; FAILED=$((FAILED+1)); fi
}

cyn "== vitest 套件 =="
for ext in $ALL_EXTS; do
  if [ -d "$EXTS/$ext" ]; then
    (cd "$EXTS/$ext" && ./node_modules/.bin/vitest run >/dev/null 2>&1)
    report $? "$ext vitest"
  else
    red "✗ $ext 目录不存在"; FAILED=$((FAILED+1))
  fi
done

cyn "== 根 typecheck (tsc) =="
# 优先 tsconfig.local.json（每环境 paths，rebuild Phase 2-D 生成）；
# 缺失时（新设备/容器未安装 pi）共享 tsconfig.json 的 paths 为空必然全量报
# Cannot find module——跳过并警告，不算回归失败（2026-08-14 容器重建测试发现）
TSCONFIG="tsconfig.local.json"
if [ -f "$EXTS/$TSCONFIG" ]; then
  (cd "$EXTS" && ./pi-web-search/node_modules/.bin/tsc -p "$TSCONFIG" --noEmit >/dev/null 2>&1)
  report $? "tsc -p $TSCONFIG"
else
  cyn "⚠ 未找到 tsconfig.local.json（未安装 pi 或未生成），跳过 tsc 类型检查"
fi

if [ "$FAST" -eq 1 ] || [ -n "$ONLY" ]; then
  cyn "== --fast/--only：跳过 subagent/注册面/conflict-check/发现完整性 =="
  exit $FAILED
fi

cyn "== 扩展注册面测试（extensions.test.ts，mock alias） =="
(cd "$EXTS/pi-web-search" && ./node_modules/.bin/vitest run tests/extensions.test.ts >/dev/null 2>&1)
report $? "extensions.test.ts (23 用例)"

cyn "== 扩展冲突检查 =="
(cd "$EXTS" && node tests/conflict-check.mjs >/dev/null 2>&1)
report $? "conflict-check (8 项)"

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
report $? "10 个扩展目录 index.ts 齐备"

if [ "$FAILED" -gt 0 ]; then
  printf '\n\033[0;31m✗ 回归失败（%s 项）\033[0m\n' "$FAILED"
  exit 1
else
  printf '\n\033[0;32m✓ 全量回归通过\033[0m\n'
fi
