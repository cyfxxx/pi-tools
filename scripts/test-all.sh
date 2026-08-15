#!/usr/bin/env bash
# test-all.sh — pi-tools 一键全量回归（Termux/Linux + Windows 便携双环境）
# 9 套 vitest + subagent mjs 测试 + 扩展注册面测试 + 根 typecheck + 扩展冲突检查
# 任一失败以非零码退出并汇总失败清单
#
# 用法（dsh 借鉴：证据面匹配分层，2026-08-14）：
#   test-all.sh            全量（CI/提交前）
#   test-all.sh --only=pi-voice,pi-tmux   只跑指定扩展 vitest 套件 + tsc
#   test-all.sh --fast     跳过 subagent/注册面/conflict-check/发现完整性（日常快检）
#
# 环境约定：
#   PI_HOME    agent 区位置（Termux/Linux 默认 $HOME/.pi；Windows 便携传包根，
#              如 PI_HOME=D:/path/pi-portable，EXTS=$PI_HOME/agent/extensions）
#   PI_SDK_PATH 可选，指向 pi 包（subagent mjs 测试用；便携自动探测 pi-global）
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

# ---- 环境探测：Windows 便携（包内 node + pi-global）vs 常规（PATH 上的 node） ----
IS_WIN_PORTABLE=0
NODE="node"
if uname 2>/dev/null | grep -qi 'mingw\|msys'; then
  if [ -x "$PI_HOME/node/node.exe" ]; then
    IS_WIN_PORTABLE=1
    NODE="$PI_HOME/node/node.exe"
  fi
fi
# 便携 pi 包（自动生成 tsconfig.local.json / subagent SDK 定位）
PI_GLOBAL="$PI_HOME/pi-global/node_modules/@earendil-works/pi-coding-agent"

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
if [ "$IS_WIN_PORTABLE" -eq 1 ]; then
  cyn "== Windows 便携模式：NODE=$NODE =="
fi

report() {
  if [ "$1" -eq 0 ]; then green "✓ $2"; else red "✗ $2"; FAILED=$((FAILED+1)); fi
}

cyn "== vitest 套件 =="
for ext in $ALL_EXTS; do
  if [ -d "$EXTS/$ext" ]; then
    if [ -f "$EXTS/$ext/node_modules/vitest/vitest.mjs" ]; then
      (cd "$EXTS/$ext" && "$NODE" node_modules/vitest/vitest.mjs run >/dev/null 2>&1)
      report $? "$ext vitest"
    else
      # 无 vitest 的扩展（如 subagent 用 node 直跑）不参与本环节
      cyn "– $ext 无 vitest（跳过）"
    fi
  else
    red "✗ $ext 目录不存在"; FAILED=$((FAILED+1))
  fi
done

# ---- 根 typecheck：缺失 tsconfig.local.json 时自动生成（便携布局） ----
cyn "== 根 typecheck (tsc) =="
TSCONFIG="tsconfig.local.json"
gen_local_json() {
  # 便携布局：paths 指向包内 pi-global（含 pi-ai/pi-tui/pi-agent-core/typebox 嵌套包）
  cat > "$EXTS/$TSCONFIG" <<EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "paths": {
      "@earendil-works/pi-coding-agent": ["../../pi-global/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
      "@earendil-works/pi-agent-core": ["../../pi-global/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["../../pi-global/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["../../pi-global/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
      "typebox": ["../../pi-global/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.d.mts"]
    }
  }
}
EOF
}
if [ -f "$EXTS/$TSCONFIG" ]; then
  :
elif [ "$IS_WIN_PORTABLE" -eq 1 ] && [ -f "$PI_GLOBAL/dist/index.d.ts" ]; then
  gen_local_json
  cyn "⚠ 自动生成 $TSCONFIG（便携布局 paths 指向 pi-global）"
else
  # 非便携且未安装 pi：共享 tsconfig.json paths 为空必然全量报 Cannot find module
  # （2026-08-14 容器重建测试发现）——跳过并警告，不算回归失败
  cyn "⚠ 未找到 tsconfig.local.json 且非便携布局，跳过 tsc 类型检查"
fi
if [ -f "$EXTS/$TSCONFIG" ]; then
  (cd "$EXTS" && "$NODE" ./pi-web-search/node_modules/typescript/bin/tsc -p "$TSCONFIG" --noEmit >/dev/null 2>&1)
  report $? "tsc -p $TSCONFIG"
fi

if [ "$FAST" -eq 1 ] || [ -n "$ONLY" ]; then
  cyn "== --fast/--only：跳过 subagent/注册面/conflict-check/发现完整性 =="
  exit $FAILED
fi

cyn "== subagent mjs 测试（45 用例） =="
if [ -f "$EXTS/subagent/tests/test.mjs" ]; then
  SDK_ENV=""
  if [ "$IS_WIN_PORTABLE" -eq 1 ] && [ -f "$PI_GLOBAL/dist/index.d.ts" ]; then
    SDK_ENV="PI_SDK_PATH=$PI_GLOBAL"
  fi
  (cd "$EXTS/subagent" && env $SDK_ENV "$NODE" --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs >/dev/null 2>&1)
  report $? "subagent tests"
else
  red "✗ subagent/tests/test.mjs 缺失"; FAILED=$((FAILED+1))
fi

cyn "== 扩展注册面测试（extensions.test.ts，mock alias） =="
(cd "$EXTS/pi-web-search" && "$NODE" node_modules/vitest/vitest.mjs run tests/extensions.test.ts >/dev/null 2>&1)
report $? "extensions.test.ts (25 用例)"

cyn "== subagent 纯函数测试（mjs，无 vitest 环境） =="
# 注释长期声称包含 subagent 但实际未执行（审计 2026-08-15 发现），补入回归面
(cd "$EXTS/subagent" && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs >/dev/null 2>&1)
report $? "subagent mjs"


cyn "== 扩展冲突检查 =="
(cd "$EXTS" && "$NODE" tests/conflict-check.mjs >/dev/null 2>&1)
report $? "conflict-check (8 项)"

cyn "== 扩展自动发现完整性（pi 0.83+ 从目录自动加载） =="
"$NODE" -e "
const fs = require('fs');
const extDir = process.argv[1];
const required = ['subagent','pi-context','plan-mode','pi-autopilot','pi-memory','pi-web-search','pi-browser','pi-tmux','pi-voice','pi-link'];
const missing = required.filter(e => !fs.existsSync(extDir + '/' + e + '/index.ts'));
if (missing.length) { console.error('missing:', missing.join(', ')); process.exit(1); }
" "$EXTS" >/dev/null 2>&1
report $? "10 个扩展目录 index.ts 齐备"

if [ "$FAILED" -gt 0 ]; then
  printf '\n\033[0;31m✗ 回归失败（%s 项）\033[0m\n' "$FAILED"
  exit 1
else
  printf '\n\033[0;32m✓ 全量回归通过\033[0m\n'
fi
