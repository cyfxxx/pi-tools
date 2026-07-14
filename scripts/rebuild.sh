#!/usr/bin/env bash
# ============================================================
# rebuild.sh — pi-tools 一键重建脚本
# 重建所有被 git 排除的可重建内容。
# 幂等：已存在的内容跳过，只重建缺失项。
# ============================================================
# 不启用 set -e：关键步骤手动容错，避免单点失败终止整个重建
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
YES="${1:-}"
[ "$YES" = "--yes" ] && YES=1 || YES=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
title(){ echo -e "\n${CYAN}[$1]${NC} $2"; }
run()  { if [ "$YES" = "1" ]; then "$@" 2>&1; else "$@" 2>&1 | tail -3; fi; }

# ---- 网络检测 ----
detect_china_network() {
  # 检测到国内网络时设置镜像变量
  CHINA_MIRROR=0
  timeout 5 curl -s --connect-timeout 3 https://www.baidu.com >/dev/null 2>&1 && CHINA_MIRROR=1
}

set_mirrors() {
  if [ "$CHINA_MIRROR" = "1" ]; then
    info "检测到国内网络，启用镜像加速"

    # npm
    npm config set registry https://registry.npmmirror.com 2>/dev/null
    ok "npm registry → https://registry.npmmirror.com"

    # GitHub 镜像前缀
    GH_PROXY="https://ghproxy.net/"
    ok "GitHub proxy → ghproxy.net"

    # pip
    mkdir -p ~/.pip
    cat > ~/.pip/pip.conf <<'EOF'
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = pypi.tuna.tsinghua.edu.cn
EOF
    ok "pip mirror → tuna.tsinghua"

    # apt (Ubuntu ports for arm64)
    # 先确保 ca-certificates，否则 HTTPS 镜像会因证书验证失败
    if ! dpkg -l ca-certificates &>/dev/null 2>&1; then
      info "安装 ca-certificates (HTTPS 镜像需要)..."
      apt-get install -y ca-certificates -qq 2>&1 | tail -1 || warn "ca-certificates 安装失败，apt 镜像可能不可用"
    fi
    APT_SOURCE="/etc/apt/sources.list.d/ubuntu.sources"
    if [ -f "$APT_SOURCE" ] && grep -q "ports.ubuntu.com" "$APT_SOURCE" 2>/dev/null; then
      sed -i.bak 's|http://ports.ubuntu.com/ubuntu-ports/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/|g' "$APT_SOURCE"
      apt-get update -qq 2>/dev/null || warn "apt update 失败（保留原始源备份: ${APT_SOURCE}.bak）"
      ok "apt mirror → mirrors.tuna.tsinghua.edu.cn"
    fi
  else
    GH_PROXY=""
    ok "网络直连模式"
  fi
}

# ---- 前置检查 ----
preflight() {
  title "Phase 0" "前置检查"

  # Node.js >= 20
  NODE_OK=0
  if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -lt 20 ]; then
      warn "Node.js $(node -v) < 20，正在升级..."
      curl -sL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -1 || warn "NodeSource 安装失败"
      apt-get install -y nodejs 2>&1 | tail -1 || warn "Node.js 安装失败"
    else
      NODE_OK=1
    fi
  else
    warn "Node.js 未安装，正在安装..."
    curl -sL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -1 || warn "NodeSource 安装失败"
    apt-get install -y nodejs 2>&1 | tail -1 || warn "Node.js 安装失败"
  fi
  if command -v node &>/dev/null; then
    ok "Node.js $(node -v) | npm $(npm -v)"
  else
    warn "Node.js 不可用，后续步骤可能失败"
  fi

  # 基础系统包
  local pkgs=""
  command -v git        &>/dev/null || pkgs="$pkgs git"
  command -v fdfind     &>/dev/null || pkgs="$pkgs fd-find"
  command -v rg         &>/dev/null || pkgs="$pkgs ripgrep"
  dpkg -l python3-venv &>/dev/null 2>&1 || pkgs="$pkgs python3-venv"
  if [ -n "$pkgs" ]; then
    info "安装系统依赖:$pkgs"
    apt-get install -y $pkgs 2>&1 | tail -1 || warn "部分系统依赖安装失败，跳过"
  fi
  # 验证关键工具
  command -v git &>/dev/null && ok "git 已就绪" || warn "git 未安装"
  command -v fdfind &>/dev/null && ok "fd-find 已就绪" || warn "fd-find 未安装"
  command -v rg &>/dev/null && ok "ripgrep 已就绪" || warn "ripgrep 未安装"
  dpkg -l python3-venv &>/dev/null 2>&1 && ok "python3-venv 已就绪" || warn "python3-venv 未安装"
}

# ---- Phase 1: 配置补全 ----
phase1_config() {
  title "Phase 1" "配置补全"

  # settings.yml
  if [ -f "$PI_HOME/searxng/generate-config.sh" ]; then
    bash "$PI_HOME/searxng/generate-config.sh" 2>&1 | head -1
  elif [ ! -f "$PI_HOME/searxng/settings.yml" ]; then
    warn "searxng 配置生成脚本缺失，跳过 settings.yml"
  else
    ok "searxng/settings.yml 已存在"
  fi

  # agent/npm/package.json
  if [ ! -f "$PI_HOME/agent/npm/package.json" ]; then
    if [ -f "$PI_HOME/agent/settings.json" ]; then
      PACKAGES=$(python3 -c "import json; d=json.load(open('$PI_HOME/agent/settings.json')); pkgs=d.get('packages',[]); print('\n'.join(pkgs) if pkgs else '')" 2>/dev/null || echo "")
      if [ -n "$PACKAGES" ]; then
        cat > "$PI_HOME/agent/npm/package.json" <<EOF
{
  "name": "pi-agent-npm",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
$(echo "$PACKAGES" | while read -r pkg; do
  echo "    \"${pkg#npm:}\": \"*\","
done)
  }
}
EOF
        ok "agent/npm/package.json 已自动生成"
      else
        warn "settings.json 中无 packages，跳过 package.json 生成"
      fi
    fi
  else
    ok "agent/npm/package.json 已存在"
  fi

  mkdir -p "$PI_HOME/agent/bin"
  ok "agent/bin/ 已就绪"

  true  # placeholder for future infra setup
}

# ---- Phase 2-A: npm 依赖 ----
phase2_npm() {
  title "Phase 2-A" "npm 依赖"

  if [ -f "$PI_HOME/agent/npm/package.json" ]; then
    if [ ! -d "$PI_HOME/agent/npm/node_modules" ] || [ -z "$(ls -A "$PI_HOME/agent/npm/node_modules" 2>/dev/null)" ]; then
      info "安装 agent/npm 依赖..."
      (cd "$PI_HOME/agent/npm" && npm install --no-fund --no-audit 2>&1 | tail -1)
      local count=$(ls "$PI_HOME/agent/npm/node_modules" 2>/dev/null | wc -l)
      ok "agent/npm/node_modules/ ($count packages)"
    else
      ok "agent/npm/node_modules/ 已存在"
    fi
  fi

  for ext in "$PI_HOME/agent/extensions"/*/; do
    [ -d "$ext" ] || continue
    local name=$(basename "$ext")
    if [ -f "$ext/package.json" ]; then
      if [ ! -d "$ext/node_modules" ] || [ -z "$(ls -A "$ext/node_modules" 2>/dev/null)" ]; then
        info "安装扩展 $name 依赖..."
        (cd "$ext" && npm install --no-fund --no-audit 2>&1 | tail -1)
        local count=$(ls "$ext/node_modules" 2>/dev/null | wc -l)
        ok "extensions/$name/node_modules/ ($count packages)"
      else
        ok "extensions/$name/node_modules/ 已存在"
      fi
    fi
  done
}

# ---- Phase 2-B: Python 环境 (venv) ----
phase2_python_venv() {
  title "Phase 2-B" "Python venv"

  if [ -f "$PI_HOME/searxng/settings.yml" ]; then
    if [ ! -f "$PI_HOME/searxng/venv/bin/python" ]; then
      dpkg -l python3-venv &>/dev/null 2>&1 || apt-get install -y python3-venv -qq 2>&1 | tail -1
      info "创建 SearXNG venv..."
      (cd "$PI_HOME/searxng" && python3 -m venv --copies venv) || {
        warn "venv 创建失败"; return 1
      }
      # 先装 pyyaml 用于配置校验
      "$PI_HOME/searxng/venv/bin/pip" install -q pyyaml 2>&1 | tail -1
      ok "searxng/venv/ ($($PI_HOME/searxng/venv/bin/python --version 2>&1))"
    else
      "$PI_HOME/searxng/venv/bin/python" -c "import yaml" 2>/dev/null \
        || "$PI_HOME/searxng/venv/bin/pip" install -q pyyaml 2>&1 | tail -1
      ok "searxng/venv/ 已存在"
    fi
  fi
}

# ---- Phase 2-B2: 克隆 SearXNG repo (可并行) ----
phase2_repo() {
  title "Phase 2-B2" "SearXNG repo"

  if [ ! -d "$PI_HOME/searxng/repo/.git" ]; then
    info "克隆 SearXNG repo..."
    local url="https://github.com/searxng/searxng"
    [ -n "${GH_PROXY:-}" ] && url="${GH_PROXY}$url"
    git clone --depth 1 "$url" "$PI_HOME/searxng/repo" 2>&1 | tail -1 || {
      warn "SearXNG repo 克隆失败"
      return 1
    }
    ok "searxng/repo/ (HEAD at $(cd "$PI_HOME/searxng/repo" && git rev-parse --short HEAD 2>/dev/null))"
  else
    ok "searxng/repo/ 已存在"
  fi
}

# ---- Phase 2-B3: 从 repo requirements.txt 安装 SearXNG 依赖 (串行，在 venv+repo 就绪后) ----
phase2_searxng_deps() {
  title "Phase 2-B3" "SearXNG 依赖"

  if [ -f "$PI_HOME/searxng/venv/bin/python" ] && [ -f "$PI_HOME/searxng/repo/requirements.txt" ]; then
    # 检查关键模块是否缺失
    if ! "$PI_HOME/searxng/venv/bin/python" -c "import searx" 2>/dev/null; then
      info "从 repo/requirements.txt 安装 SearXNG 依赖..."
      "$PI_HOME/searxng/venv/bin/pip" install -q -r "$PI_HOME/searxng/repo/requirements.txt" 2>&1 | tail -3 || {
        warn "SearXNG 依赖安装失败"
        return 1
      }
    fi
    ok "SearXNG 依赖已就绪"
  else
    warn "venv 或 repo 不完整，跳过 SearXNG 依赖安装"
  fi
}

# ---- 架构检测 ----
detect_arch() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64)   echo "amd64"  ;;
    aarch64|arm64)  echo "arm64"  ;;
    armv7l|armv7)   echo "armv7"  ;;
    i386|i686)      echo "386"    ;;
    riscv64)        echo "riscv64" ;;
    *)              echo "unsupported: $arch" ;;
  esac
}

# ---- Phase 2-C: 二进制下载（并发） ----
phase2_binaries() {
  title "Phase 2-C" "二进制下载（并发）"

  download_bin() {
    local name="$1" dest="$2" url="$3" ver_cmd="$4"
    if [ ! -f "$dest" ]; then
      local final_url="${GH_PROXY:-}$url"
      mkdir -p "$(dirname "$dest")"
      info "下载 $name..."
      curl -sL "$final_url" -o "/tmp/$name.download" && mv "/tmp/$name.download" "$dest" && chmod +x "$dest"
      if [ -n "$ver_cmd" ]; then
        local ver=$(eval "$ver_cmd" 2>/dev/null | head -1)
        ok "$dest ($ver)"
      else
        ok "$dest (downloaded)"
      fi
    else
      local ver=$(eval "$ver_cmd" 2>/dev/null | head -1)
      ok "$dest ($ver)"
    fi
  }

  # fd / rg (via apt)
  if ! command -v fdfind &>/dev/null; then
    apt-get install -y fd-find -qq 2>&1 | tail -1
  fi
  if ! command -v rg &>/dev/null; then
    apt-get install -y ripgrep -qq 2>&1 | tail -1
  fi
  ln -sf "$(command -v fdfind)" "$PI_HOME/agent/bin/fd" 2>/dev/null || true
  ln -sf "$(command -v rg)" "$PI_HOME/agent/bin/rg" 2>/dev/null || true
  ok "agent/bin/fd ($($PI_HOME/agent/bin/fd --version 2>/dev/null | head -1))"
  ok "agent/bin/rg ($($PI_HOME/agent/bin/rg --version 2>/dev/null | head -1))"

  true  # placeholder for future infra download
}

# ---- Phase 4: 验证 ----
verify() {
  title "验证" "最终检查"

  local errors=0

  # npm
  for d in "$PI_HOME/agent/npm/node_modules" "$PI_HOME/agent/extensions"/*/node_modules; do
    [ -d "$d" ] && ok "npm: $d ($(ls "$d" 2>/dev/null | wc -l) packages)" || {
      # 检查 package.json 有无依赖：无依赖时 node_modules 不生成是正常行为
      local pkg_json="${d%/node_modules}/package.json"
      if [ -f "$pkg_json" ]; then
        local dep_count=$(python3 -c "import json; d=json.load(open('$pkg_json')); print(len(d.get('dependencies',{})))" 2>/dev/null || echo "?")
        if [ "$dep_count" = "0" ]; then
          ok "npm: $d (无依赖，跳过)"
        else
          warn "npm: $d MISSING ($dep_count 依赖未安装)"; errors=$((errors+1))
        fi
      else
        warn "npm: $d MISSING"; errors=$((errors+1))
      fi
    }
  done

  # binaries
  [ -f "$PI_HOME/agent/bin/fd" ] && ok "fd: $($PI_HOME/agent/bin/fd --version 2>/dev/null | head -1)" || { warn "fd not found"; errors=$((errors+1)); }
  [ -f "$PI_HOME/agent/bin/rg" ] && ok "rg: $($PI_HOME/agent/bin/rg --version 2>/dev/null | head -1)" || { warn "rg not found"; errors=$((errors+1)); }

  # venv
  if [ -f "$PI_HOME/searxng/venv/bin/python" ]; then
    ok "Python: $($PI_HOME/searxng/venv/bin/python --version 2>&1)"
  else
    warn "Python venv not found"; errors=$((errors+1))
  fi

  # repo
  [ -d "$PI_HOME/searxng/repo/.git" ] && ok "SearXNG repo: $(cd "$PI_HOME/searxng/repo" && git rev-parse --short HEAD 2>/dev/null)" || warn "SearXNG repo not found"

  # config 校验（用 venv 的 python 确保 yaml 可用）
  if [ -f "$PI_HOME/searxng/venv/bin/python" ]; then
    "$PI_HOME/searxng/venv/bin/python" -c "import yaml; yaml.safe_load(open('$PI_HOME/searxng/settings.yml'))" 2>/dev/null \
      && ok "settings.yml: valid YAML" \
      || warn "settings.yml: YAML 校验失败"
    "$PI_HOME/searxng/venv/bin/python" -c "import json; json.load(open('$PI_HOME/agent/settings.json'))" 2>/dev/null \
      && ok "settings.json: valid JSON" \
      || warn "settings.json: JSON 校验失败"
    "$PI_HOME/searxng/venv/bin/python" -c "import json; json.load(open('$PI_HOME/agent/models.json'))" 2>/dev/null \
      && ok "models.json: valid JSON" \
      || warn "models.json: JSON 校验失败"
  else
    python3 -c "import json; json.load(open('$PI_HOME/agent/settings.json'))" 2>/dev/null \
      && ok "settings.json: valid JSON" \
      || warn "settings.json: JSON 校验失败"
    python3 -c "import json; json.load(open('$PI_HOME/agent/models.json'))" 2>/dev/null \
      && ok "models.json: valid JSON" \
      || warn "models.json: JSON 校验失败"
  fi

  # Pi CLI 可用性
  if command -v pi &>/dev/null; then
    PI_VER=$(timeout 5 pi --version 2>/dev/null || echo "")
    if [ -n "$PI_VER" ]; then
      ok "Pi CLI v$PI_VER"
    else
      warn "Pi CLI 已安装但未能在 5s 内响应（可能等待 provider 连接）"
      info "运行: timeout 10 pi --version 检查"
    fi
  else
    warn "Pi CLI 未在 PATH 中找到"
    info "Pi 安装路径: $(find / -name pi -type f 2>/dev/null | head -1 || echo '未找到')"
  fi

  # CloakBrowser 检测
  if [ -f "$PI_HOME/agent/extensions/pi-web-toolkit/node_modules/cloakbrowser/package.json" ]; then
    CB_VER=$(node -e "console.log(require('$PI_HOME/agent/extensions/pi-web-toolkit/node_modules/cloakbrowser/package.json').version)" 2>/dev/null)
    ok "CloakBrowser v$CB_VER"
    # 检测 Chromium 是否已安装
    if command -v npx &>/dev/null && npx cloakbrowser list 2>/dev/null | grep -q chromium; then
      ok "Chromium 已安装（可通过 CloakBrowser 启动）"
    else
      warn "Chromium 未安装，浏览器功能不可用"
      info "运行: cd $PI_HOME && npx cloakbrowser install 安装"
    fi
  else
    warn "CloakBrowser npm 包未安装，浏览器功能不可用"
  fi

  # ctx-lite 数据目录
  if [ -d "$PI_HOME/ctx-lite/checkpoints" ]; then
    ok "ctx-lite/checkpoints/ 已就绪"
  else
    mkdir -p "$PI_HOME/ctx-lite/checkpoints"
    ok "ctx-lite/checkpoints/ 已创建"
  fi

  # Provider 配置检查
  if [ -f "$PI_HOME/agent/settings.json" ] && [ -f "$PI_HOME/agent/models.json" ]; then
    DEFAULT_PROVIDER=$(python3 -c "import json; print(json.load(open('$PI_HOME/agent/settings.json')).get('defaultProvider',''))" 2>/dev/null)
    DEFAULT_MODEL=$(python3 -c "import json; print(json.load(open('$PI_HOME/agent/settings.json')).get('defaultModel',''))" 2>/dev/null)
    PROVIDER_EXISTS=$(python3 -c "
import json; d=json.load(open('$PI_HOME/agent/models.json'))
providers=d.get('providers',{})
print('yes' if '$DEFAULT_PROVIDER' in providers else 'no')" 2>/dev/null)
    if [ "$PROVIDER_EXISTS" = "yes" ]; then
      ok "默认 provider '$DEFAULT_PROVIDER' 在 models.json 中已定义"
      # 检测后端是否可达
      BASE_URL=$(python3 -c "
import json; d=json.load(open('$PI_HOME/agent/models.json'))
p=d['providers']['$DEFAULT_PROVIDER']
print(p.get('baseUrl',''))" 2>/dev/null)
      if [ -n "$BASE_URL" ]; then
        if timeout 3 curl -s "$BASE_URL/models" >/dev/null 2>&1; then
          ok "Provider 后端可达 ($BASE_URL)"
        else
          warn "Provider 后端不可达 ($BASE_URL)"
          info "如需使用远程 API，请创建 $PI_HOME/agent/auth.json"
        fi
      fi
    else
      warn "默认 provider '$DEFAULT_PROVIDER' 未在 models.json 中定义"
    fi
  fi

  if [ "$errors" -gt 0 ]; then
    echo -e "\n${YELLOW}⚠ 完成（$errors 项异常）${NC}"
  else
    echo -e "\n${GREEN}✓ 全部完成${NC}"
  fi
}

# ============================================================
# Main
# ============================================================
cd "$PI_HOME"
detect_china_network
set_mirrors
preflight
phase1_config

# Phase 2-A (npm), 2-B (venv), 2-B2 (repo) 可并行执行
phase2_npm &
PID_NPM=$!
phase2_python_venv &
PID_VENV=$!
phase2_repo &
PID_REPO=$!
wait $PID_NPM $PID_VENV $PID_REPO 2>/dev/null || true

# 之后安装 SearXNG 完整依赖（需要 venv + repo 都已就绪）
phase2_searxng_deps

phase2_binaries

verify

echo -e "\n${GREEN}重建完成。${NC}"
echo ""
echo "  启动 SearXNG:  $PI_HOME/searxng/start.sh"
echo "  停止 SearXNG:  $PI_HOME/searxng/stop.sh"
echo "  重新生成配置:  $PI_HOME/searxng/generate-config.sh --force"
echo "  安装浏览器:    cd $PI_HOME && npx cloakbrowser install"
