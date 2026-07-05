#!/usr/bin/env bash
#
# pi-web-toolkit 一键安装脚本
# 安装 Pi 网络扩展 + 可选部署本地 SearXNG 服务
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

TOTAL=5

# ─── 路径 ───────────────────────────────────────────────────────
EXTENSION_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"
PI_SETTINGS="$PI_AGENT_DIR/settings.json"
SEARXNG_DIR="$HOME/.pi/searxng"
SEARXNG_REPO="$SEARXNG_DIR/repo"
SEARXNG_VENV="$SEARXNG_DIR/venv"

# ─── Step 1: 检查环境 ──────────────────────────────────────────
step 1 "检查环境"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  ok "Node.js $NODE_VER"
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

# Python 3
if command -v python3 &>/dev/null; then
  PY_VER=$(python3 --version)
  ok "$PY_VER"
else
  fail "未安装 Python 3"
  exit 1
fi

# ─── Step 2: 安装 Pi 扩展依赖 ──────────────────────────────────
step 2 "安装扩展依赖"

cd "$EXTENSION_DIR"

if [ ! -d "node_modules" ]; then
  info "正在安装 npm 依赖..."
  npm install 2>&1 | tail -1
  ok "npm 依赖安装完成"
else
  ok "npm 依赖已安装 (如需更新: npm update)"
fi

# ─── Step 3: 配置 Pi settings ───────────────────────────────────
step 3 "配置 Pi"

mkdir -p "$PI_AGENT_DIR"

# 判断是否需要写入 SearXNG 配置
USE_LOCAL_SEARXNG=false
SEARXNG_PORT="8889"

if [ -f "$SEARXNG_VENV/bin/python3" ]; then
  USE_LOCAL_SEARXNG=true
fi

if [ "$USE_LOCAL_SEARXNG" = false ] && [ -d "$SEARXNG_REPO" ]; then
  if [ -f "$SEARXNG_VENV/bin/python3" ]; then
    USE_LOCAL_SEARXNG=true
  fi
fi

# 读取现有配置
EXISTING_CONFIG="{}"
if [ -f "$PI_SETTINGS" ]; then
  EXISTING_CONFIG=$(python3 -c "
import json
try:
    with open('$PI_SETTINGS') as f:
        d = json.load(f)
    ext = d.get('extensions', {}).get('pi-web-toolkit', {})
    print(json.dumps(ext))
except:
    print('{}')
")
fi

# 如果本地 SearXNG 存在，写入配置
if [ "$USE_LOCAL_SEARXNG" = true ]; then
  info "配置扩展使用本地 SearXNG (127.0.0.1:$SEARXNG_PORT)..."
  python3 -c "
import json, os

settings_path = '$PI_SETTINGS'
current = {}
if os.path.exists(settings_path):
    with open(settings_path) as f:
        current = json.load(f)

if 'extensions' not in current:
    current['extensions'] = {}
if 'pi-web-toolkit' not in current['extensions']:
    current['extensions']['pi-web-toolkit'] = {}

current['extensions']['pi-web-toolkit']['searxng_url'] = 'http://127.0.0.1:$SEARXNG_PORT'
current['extensions']['pi-web-toolkit']['search_timeout'] = 10000

os.makedirs(os.path.dirname(settings_path), exist_ok=True)
with open(settings_path, 'w') as f:
    json.dump(current, f, indent=2)
print('settings.json 已更新')
"
  ok "扩展已配置为使用本地 SearXNG"
else
  # 使用默认公共实例
  info "使用默认 SearXNG 公共实例 (https://searx.be)"
  info "如需使用本地实例，请先部署 SearXNG (见 README)"
fi

# ─── Step 4: 部署 SearXNG（可选） ──────────────────────────────
step 4 "部署本地 SearXNG"

deploy_searxng() {
  if [ -f "$SEARXNG_VENV/bin/granian" ] && [ -d "$SEARXNG_REPO/.git" ]; then
    ok "SearXNG 已部署"
    return
  fi

  warn "部署 SearXNG 需要安装系统包和 ~100MB 磁盘空间"
  read -r -p "是否部署本地 SearXNG 服务? [y/N] " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    info "跳过 SearXNG 部署。扩展将使用公共 SearXNG 实例。"
    return
  fi

  # 系统依赖
  info "安装系统依赖..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3-dev python3-venv python3-pip git build-essential libxslt-dev zlib1g-dev libffi-dev libssl-dev 2>&1 | tail -1
  ok "系统依赖已安装"

  # 克隆仓库
  if [ ! -d "$SEARXNG_REPO" ]; then
    info "克隆 SearXNG 仓库..."
    mkdir -p "$SEARXNG_DIR"
    git clone --depth 1 https://github.com/searxng/searxng.git "$SEARXNG_REPO"
    ok "仓库已克隆"
  else
    ok "SearXNG 仓库已存在"
  fi

  # 虚拟环境
  if [ ! -f "$SEARXNG_VENV/bin/python3" ]; then
    info "创建 Python 虚拟环境..."
    python3 -m venv "$SEARXNG_VENV"
    ok "虚拟环境已创建"
  else
    ok "虚拟环境已存在"
  fi

  # 安装 SearXNG
  info "安装 SearXNG..."
  source "$SEARXNG_VENV/bin/activate"
  pip install -q -U pip setuptools wheel pyyaml msgspec typing-extensions 2>&1 | tail -1
  cd "$SEARXNG_REPO"
  pip install -q --use-pep517 --no-build-isolation -e . 2>&1 | tail -1
  pip install -q granian 2>&1 | tail -1
  deactivate
  ok "SearXNG 已安装"

  # 生成配置
  if [ ! -f "$SEARXNG_DIR/settings.yml" ]; then
    info "生成配置..."
    KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    cat > "$SEARXNG_DIR/settings.yml" << YAMLEOF
use_default_settings: true
server:
  port: $SEARXNG_PORT
  bind_address: "127.0.0.1"
  secret_key: "$KEY"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
YAMLEOF
    ok "配置文件已生成"
  fi

  # 启动服务
  info "启动 SearXNG 服务..."
  bash "$EXTENSION_DIR/start-searxng.sh" 2>&1 | tail -1

  # 验证
  sleep 3
  if curl -s --connect-timeout 5 "http://127.0.0.1:$SEARXNG_PORT/search?format=json&q=test" | python3 -c "import sys,json; json.load(sys.stdin); print('OK')" 2>/dev/null; then
    ok "SearXNG 服务运行正常 (http://127.0.0.1:$SEARXNG_PORT)"
  else
    warn "SearXNG 启动后验证失败，请检查日志: $SEARXNG_DIR/searxng.log"
  fi
}

deploy_searxng

# ─── Step 5: 验证 ──────────────────────────────────────────────
step 5 "验证安装"

echo ""
echo -e "${BOLD}──── 安装摘要 ────${NC}"
echo -e "  扩展路径: ${CYAN}$EXTENSION_DIR${NC}"
echo -e "  SearXNG:  ${CYAN}$([ -f "$SEARXNG_VENV/bin/granian" ] && echo '已部署' || echo '未部署 (将使用公共实例)')${NC}"

# 验证扩展加载
info "验证扩展..."
if [ -f "$EXTENSION_DIR/src/index.ts" ] && [ -d "$EXTENSION_DIR/node_modules" ]; then
  ok "扩展文件完整"
else
  warn "扩展文件不完整，请检查 $EXTENSION_DIR"
fi

echo ""
echo -e "${GREEN}${BOLD}安装完成！${NC}"
echo ""
echo "使用方法:"
echo "  1. 启动 Pi:  pi"
echo "  2. LLM 会自动使用 web_search、browser_navigate 等工具"
echo "  3. 如需测试扩展:"
echo "     pi --no-extensions -e $EXTENSION_DIR/src/index.ts \"搜索测试\""
echo ""
echo "SearXNG 管理:"
if [ -f "$SEARXNG_VENV/bin/granian" ]; then
  echo "  启动:  bash $EXTENSION_DIR/start-searxng.sh"
  echo "  停止:  bash $SEARXNG_DIR/stop.sh"
  echo "  状态:  curl http://127.0.0.1:$SEARXNG_PORT"
fi
echo ""
