#!/usr/bin/env bash
# ============================================================
# rebuild.sh — pi-tools 一键重建脚本
# 重建所有被 git 排除的可重建内容。
# 幂等：已存在的内容跳过，只重建缺失项。
# ============================================================
set -euo pipefail

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
    APT_SOURCE="/etc/apt/sources.list.d/ubuntu.sources"
    if [ -f "$APT_SOURCE" ] && grep -q "ports.ubuntu.com" "$APT_SOURCE" 2>/dev/null; then
      sed -i 's|http://ports.ubuntu.com/ubuntu-ports/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/|g' "$APT_SOURCE"
      apt-get update -qq 2>/dev/null
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
  if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -lt 20 ]; then
      warn "Node.js $(node -v) < 20，正在升级..."
      curl -sL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
      apt-get install -y nodejs 2>&1 | tail -1
    fi
  else
    warn "Node.js 未安装，正在安装..."
    curl -sL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
    apt-get install -y nodejs 2>&1 | tail -1
  fi
  ok "Node.js $(node -v) | npm $(npm -v)"

  # 基础系统包
  local pkgs=""
  command -v git        &>/dev/null || pkgs="$pkgs git"
  command -v fdfind     &>/dev/null || pkgs="$pkgs fd-find"
  command -v rg         &>/dev/null || pkgs="$pkgs ripgrep"
  dpkg -l python3.12-venv &>/dev/null 2>&1 || pkgs="$pkgs python3.12-venv"
  if [ -n "$pkgs" ]; then
    info "安装系统依赖:$pkgs"
    apt-get install -y $pkgs 2>&1 | tail -1
  fi
  ok "系统依赖已就绪"
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

# ---- Phase 2-B: Python 环境 ----
phase2_python() {
  title "Phase 2-B" "Python 环境"

  # venv
  if [ -f "$PI_HOME/searxng/settings.yml" ]; then
    if [ ! -f "$PI_HOME/searxng/venv/bin/python" ]; then
      # 确保 python3-venv 已安装（否则 venv 缺少 pip）
      dpkg -l python3-venv &>/dev/null 2>&1 || apt-get install -y python3-venv -qq 2>&1 | tail -1
      info "创建 SearXNG venv..."
      (cd "$PI_HOME/searxng" && python3 -m venv --copies venv \
        && venv/bin/pip install -q searxng granian pyyaml 2>&1 | tail -1)
      ok "searxng/venv/ ($($PI_HOME/searxng/venv/bin/python --version 2>&1))"
    else
      # 确保 pyyaml 在 venv 中可用
      "$PI_HOME/searxng/venv/bin/python" -c "import yaml" 2>/dev/null \
        || "$PI_HOME/searxng/venv/bin/pip" install -q pyyaml 2>&1 | tail -1
      ok "searxng/venv/ 已存在"
    fi
  fi

  # repo
  if [ ! -d "$PI_HOME/searxng/repo/.git" ]; then
    info "克隆 SearXNG repo..."
    local url="https://github.com/searxng/searxng"
    [ -n "${GH_PROXY:-}" ] && url="${GH_PROXY}$url"
    git clone --depth 1 "$url" "$PI_HOME/searxng/repo" 2>&1 | tail -1
    ok "searxng/repo/ (HEAD at $(cd "$PI_HOME/searxng/repo" && git rev-parse --short HEAD 2>/dev/null))"
  else
    ok "searxng/repo/ 已存在"
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

  # 下载 sing-box（自动匹配系统架构）
  SINGBOX_ARCH=$(detect_arch)
  if [ "$SINGBOX_ARCH" = "unsupported: $(uname -m)" ]; then
    warn "不支持的架构 $(uname -m)，跳过 sing-box 下载"
  else
    SINGBOX_VER=$(curl -sL "https://api.github.com/repos/SagerNet/sing-box/releases/latest" | grep tag_name | cut -d'"' -f4 2>/dev/null || echo "v1.13.14")
    download_bin "sing-box" "$PI_HOME/sing-box/sing-box" \
      "https://github.com/SagerNet/sing-box/releases/download/$SINGBOX_VER/sing-box-${SINGBOX_VER#v}-linux-$SINGBOX_ARCH.tar.gz" \
      "$PI_HOME/sing-box/sing-box version 2>&1 | head -1" &
  fi

  PID_SINGBOX=$!

  wait $PID_SINGBOX 2>/dev/null || true
}

# ---- Phase 4: 验证 ----
verify() {
  title "验证" "最终检查"

  local errors=0

  # npm
  for d in "$PI_HOME/agent/npm/node_modules" "$PI_HOME/agent/extensions"/*/node_modules; do
    [ -d "$d" ] && ok "npm: $d ($(ls "$d" 2>/dev/null | wc -l) packages)" || { warn "npm: $d MISSING"; errors=$((errors+1)); }
  done

  # binaries
  [ -f "$PI_HOME/agent/bin/fd" ] && ok "fd: $($PI_HOME/agent/bin/fd --version 2>/dev/null | head -1)" || { warn "fd not found"; errors=$((errors+1)); }
  [ -f "$PI_HOME/agent/bin/rg" ] && ok "rg: $($PI_HOME/agent/bin/rg --version 2>/dev/null | head -1)" || { warn "rg not found"; errors=$((errors+1)); }
  [ -f "$PI_HOME/sing-box/sing-box" ] && ok "sing-box: $($PI_HOME/sing-box/sing-box version 2>&1 | head -1)" || { warn "sing-box not found"; errors=$((errors+1)); }

  # venv
  if [ -f "$PI_HOME/searxng/venv/bin/python" ]; then
    ok "Python: $($PI_HOME/searxng/venv/bin/python --version 2>&1)"
  else
    warn "Python venv not found"; errors=$((errors+1))
  fi

  # repo
  [ -d "$PI_HOME/searxng/repo/.git" ] && ok "SearXNG repo: $(cd "$PI_HOME/searxng/repo" && git rev-parse --short HEAD 2>/dev/null)" || warn "SearXNG repo not found"

  # config 校验
  if [ -f "$PI_HOME/searxng/venv/bin/python" ]; then
    "$PI_HOME/searxng/venv/bin/python" -c "import yaml; yaml.safe_load(open('$PI_HOME/searxng/settings.yml'))" 2>/dev/null \
      && ok "settings.yml: valid YAML" \
      || warn "settings.yml: YAML 校验失败"
    python3 -c "import json; json.load(open('$PI_HOME/agent/settings.json'))" 2>/dev/null \
      && ok "settings.json: valid JSON" \
      || warn "settings.json: JSON 校验失败"
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

# Phase 2-A 和 2-B 可并行执行
phase2_npm &
PID_NPM=$!
phase2_python &
PID_PYTHON=$!
wait $PID_NPM $PID_PYTHON 2>/dev/null || true

phase2_binaries

verify

echo -e "\n${GREEN}重建完成。如需启动 SearXNG，运行:${NC}"
echo "  $PI_HOME/searxng/start.sh"
