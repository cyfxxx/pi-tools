#!/usr/bin/env bash
# ============================================================
# pi-source-build.sh — 从 GitHub 源码编译 pi-coding-agent
# 用途：L4 恢复时提供本地编译的 pi 二进制
# ============================================================
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
SOURCE_DIR="$PI_HOME/pi-source"
CACHE_DIR="$PI_HOME/pi-source-cache"
REPO_URL="https://github.com/earendil-works/pi.git"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

# ── 参数解析 ──
FORCE_BUILD=0
NO_PROXY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE_BUILD=1 ;;
    --no-proxy) NO_PROXY=1 ;;
  esac
done

# ── git 命令封装（处理代理） ──
git_cmd() {
  if [ "$NO_PROXY" = "1" ]; then
    git "$@"
  else
    git -c "http.https://github.com/.proxy=http://127.0.0.1:10809" "$@"
  fi
}

# ── Step 1: Clone / Pull 源码 ──
echo -e "\n${CYAN}[L4] 源码准备${NC}"

if [ ! -d "$SOURCE_DIR/.git" ]; then
  echo "[L4] 克隆 pi 源码（shallow clone）..."
  git_cmd clone --depth 1 "$REPO_URL" "$SOURCE_DIR" 2>&1
  if [ $? -ne 0 ]; then
    fail "克隆失败"
    return 1 2>/dev/null || exit 1
  fi
  ok "源码克隆完成"
else
  echo "[L4] 更新源码..."
  cd "$SOURCE_DIR"
  git_cmd pull --ff-only 2>&1 || warn "pull 失败，使用现有源码"
  cd "$PI_HOME"
  ok "源码已就绪"
fi

# ── Step 2: 安装构建工具 ──
echo -e "\n${CYAN}[L4] 构建工具${NC}"

NEED_TSGO=0
command -v tsgo >/dev/null 2>&1 || NEED_TSGO=1

if [ "$NEED_TSGO" = "1" ]; then
  echo "[L4] 安装 tsgo..."
  npm install -g tsgo 2>&1 | tail -3
  if command -v tsgo >/dev/null 2>&1; then
    ok "tsgo 已安装"
  else
    fail "tsgo 安装失败，尝试用 tsc 替代"
    npm install -g typescript 2>&1 | tail -3
    # 创建 tsgo wrapper 指向 tsc
    TSGO_BIN="$(npm prefix -g)/bin/tsgo"
    TSC_BIN="$(npm prefix -g)/bin/tsc"
    cat > "$TSGO_BIN" << WRAPPER
#!/bin/bash
exec "$TSC_BIN" "\$@"
WRAPPER
    chmod +x "$TSGO_BIN"
    ok "tsc fallback 已配置"
  fi
fi

if ! command -v esbuild >/dev/null 2>&1; then
  echo "[L4] 安装 esbuild..."
  npm install -g esbuild 2>&1 | tail -3
  ok "esbuild 已安装"
fi

# ── Step 3: 安装 monorepo 依赖 ──
echo -e "\n${CYAN}[L4] 安装依赖${NC}"

cd "$SOURCE_DIR"
if [ ! -d "node_modules" ] || [ "$FORCE_BUILD" = "1" ]; then
  echo "[L4] npm install（monorepo）..."
  npm install 2>&1 | tail -5
  ok "依赖安装完成"
else
  ok "依赖已存在，跳过"
fi

# ── Step 4: 按依赖序构建所有包 ──
echo -e "\n${CYAN}[L4] 编译 TypeScript${NC}"

# 构建顺序：protocol → agent → ai → chord → client → server → tui → telemetry → coding-agent
BUILD_ORDER=(protocol agent ai chord client server tui telemetry)
ALL_OK=1

for pkg in "${BUILD_ORDER[@]}"; do
  pkg_dir="$SOURCE_DIR/packages/$pkg"
  if [ -f "$pkg_dir/package.json" ]; then
    echo -n "  编译 $pkg... "
    cd "$pkg_dir"
    # 检查是否有 build 脚本
    has_build=$(node -e "const p=require('./package.json'); console.log(p.scripts?.build ? 'yes' : 'no')" 2>/dev/null)
    if [ "$has_build" = "yes" ]; then
      npm run build 2>&1 | tail -2
      if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
      else
        echo -e "${RED}✗${NC}"
        ALL_OK=0
      fi
    else
      echo -e "${YELLOW}跳过（无 build 脚本）${NC}"
    fi
  fi
done

if [ "$ALL_OK" = "0" ]; then
  fail "部分包编译失败"
  return 1 2>/dev/null || exit 1
fi

# 最后编译 coding-agent（unbundled 模式）
echo -n "  编译 coding-agent... "
cd "$SOURCE_DIR/packages/coding-agent"
npm run build:unbundled 2>&1 | tail -3
if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓${NC}"
else
  fail "coding-agent 编译失败"
  return 1 2>/dev/null || exit 1
fi

# ── Step 5: esbuild 打包 ──
echo -e "\n${CYAN}[L4] esbuild 打包${NC}"

cd "$SOURCE_DIR"
node scripts/build-coding-agent-bundle.mjs 2>&1 | tail -3
if [ $? -eq 0 ]; then
  ok "打包完成"
else
  fail "esbuild 打包失败"
  return 1 2>/dev/null || exit 1
fi

# ── Step 6: 输出到缓存目录 ──
echo -e "\n${CYAN}[L4] 缓存构建产物${NC}"

mkdir -p "$CACHE_DIR"

# 复制 dist 目录
rm -rf "$CACHE_DIR/dist"
cp -r "$SOURCE_DIR/packages/coding-agent/dist" "$CACHE_DIR/dist"

# 复制 npm-shrinkwrap.json（依赖锁定）
cp "$SOURCE_DIR/packages/coding-agent/npm-shrinkwrap.json" "$CACHE_DIR/npm-shrinkwrap.json" 2>/dev/null

# 复制 package.json
cp "$SOURCE_DIR/packages/coding-agent/package.json" "$CACHE_DIR/package.json" 2>/dev/null

# 记录版本信息
VERSION=$(node -e "console.log(require('$SOURCE_DIR/packages/coding-agent/package.json').version)" 2>/dev/null)
GIT_HASH=$(cd "$SOURCE_DIR" && git rev-parse --short HEAD 2>/dev/null)
BUILD_TS=$(date +%s)

cat > "$CACHE_DIR/version.json" << EOF
{
  "version": "$VERSION",
  "gitHash": "$GIT_HASH",
  "buildTs": $BUILD_TS,
  "buildDate": "$(date -Iseconds)",
  "nodeVersion": "$(node --version)",
  "sourceHash": "$(find "$SOURCE_DIR/packages/coding-agent/src" -name '*.ts' -exec md5sum {} + 2>/dev/null | md5sum | cut -d' ' -f1)"
}
EOF

ok "缓存已更新: $CACHE_DIR"
echo "  版本: $VERSION"
echo "  提交: $GIT_HASH"
echo "  构建时间: $(date -Iseconds)"

# 验证产物
if [ -f "$CACHE_DIR/dist/bundle/cli.js" ]; then
  ok "产物验证: dist/bundle/cli.js 存在"
else
  fail "产物验证失败: dist/bundle/cli.js 不存在"
  return 1 2>/dev/null || exit 1
fi

cd "$PI_HOME"
echo -e "\n${GREEN}[L4] 源码构建完成${NC}"
