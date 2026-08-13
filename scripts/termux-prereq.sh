#!/usr/bin/env bash
# ============================================================
# termux-prereq.sh — Termux/Android 平台重建前置依赖
# 仅 Termux 环境需要；其他平台（proot/WSL/原生 Linux）运行会直接退出，无副作用。
# 用法: bash scripts/termux-prereq.sh
# ============================================================
set -uo pipefail

# 非 Termux 直接退出（保护其他环境）
if [ ! -d /data/data/com.termux ]; then
  echo "非 Termux 环境，无需执行（退出）"
  exit 0
fi

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

echo "[1/5] Termux 系统包（x11-repo 提供 chromium）"
pkg install -y x11-repo 2>&1 | tail -1
pkg install -y openssl-tool cronie tmux termux-services fd ripgrep 2>&1 | tail -1
ok "系统包就绪（openssl-tool/cronie/tmux/termux-services/fd/ripgrep）"

echo "[2/5] fd 别名（rebuild.sh Phase 2-C 按 fdfind 探测）"
if [ ! -x "$PREFIX/bin/fdfind" ]; then
  ln -s "$PREFIX/bin/fd" "$PREFIX/bin/fdfind"
fi
ok "fdfind → fd"

echo "[3/5] Termux Chromium（cloakbrowser 官方无 android 预编译包）"
if ! command -v chromium-browser >/dev/null 2>&1; then
  pkg install -y chromium 2>&1 | tail -1
fi
ok "chromium-browser $(chromium-browser --version 2>/dev/null | head -1)"

echo "[4/5] crond 常驻（pi-autopilot 离线调度）"
rm -f "$PREFIX/var/service/crond/down" 2>/dev/null
if [ ! -f "$PREFIX/var/run/crond.pid" ] || ! kill -0 "$(cat "$PREFIX/var/run/crond.pid" 2>/dev/null)" 2>/dev/null; then
  crond 2>/dev/null && ok "crond 已启动" || warn "crond 启动失败（手动: crond）"
else
  ok "crond 运行中 (PID $(cat "$PREFIX/var/run/crond.pid"))"
fi

echo "[5/5] 运行时环境变量（~/.bashrc）"
if ! grep -q CLOAKBROWSER_BINARY_PATH "$HOME/.bashrc" 2>/dev/null; then
  {
    echo "# pi-tools: Termux Chromium for cloakbrowser/pi-browser"
    echo "export CLOAKBROWSER_BINARY_PATH=$PREFIX/bin/chromium-browser"
  } >> "$HOME/.bashrc"
fi
ok "CLOAKBROWSER_BINARY_PATH 已写入 ~/.bashrc"

echo ""
echo "下一步: bash $HOME/.pi/scripts/rebuild.sh --yes"
