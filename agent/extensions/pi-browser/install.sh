#!/usr/bin/env bash
#
# pi-browser 一键安装脚本
# 安装 Pi 浏览器扩展依赖（CloakBrowser + playwright-core）
#
set -e

# ─── 颜色 ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

info()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }
step()  { echo -e "\n${BOLD}[$1/${TOTAL}]${NC} $2"; }

TOTAL=3

# ─── 路径 ───────────────────────────────────────────────────────
EXTENSION_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Step 1: 检查环境 ──────────────────────────────────────────
step 1 "检查环境"

# Node.js
if command -v node &>/dev/null; then
  ok "Node.js $(node -v)"
else
  fail "未安装 Node.js (>=18)。请先安装: https://nodejs.org"
  exit 1
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "未安装 npm"
  exit 1
fi

# ─── Step 2: 安装扩展依赖 ──────────────────────────────────────
step 2 "安装扩展依赖"

cd "$EXTENSION_DIR"

if [ ! -d "node_modules" ]; then
  info "正在安装 npm 依赖 (cloakbrowser, playwright-core)..."
  npm install 2>&1 | tail -1
  ok "npm 依赖安装完成"
else
  ok "npm 依赖已安装 (如需更新: npm update)"
fi

# ─── Step 3: 验证 ──────────────────────────────────────────────
step 3 "验证安装"

echo ""
echo -e "${BOLD}──── 安装摘要 ────${NC}"
echo -e "  扩展路径: ${CYAN}$EXTENSION_DIR${NC}"

if [ -f "$EXTENSION_DIR/index.ts" ] && [ -d "$EXTENSION_DIR/node_modules" ]; then
  ok "扩展文件完整"
else
  warn "扩展文件不完整，请检查 $EXTENSION_DIR"
fi

echo ""
echo -e "${GREEN}${BOLD}安装完成！${NC}"
echo ""
echo "使用方法:"
echo "  1. 确认 ~/.pi/agent/settings.json 的 extensions 数组包含:"
echo "     extensions/pi-browser/index.ts"
echo "  2. 启动 Pi:  pi"
echo "  3. LLM 会自动使用 browser_navigate、browser_screenshot 等工具"
echo "  4. CloakBrowser 首次启动时自动下载隐身 Chromium（约 200MB，存放于 ~/.cloakbrowser/）"
echo ""
