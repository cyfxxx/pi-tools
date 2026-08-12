#!/usr/bin/env bash
# ============================================================
# rebuild.sh — pi-tools 一键重建脚本
# 重建所有被 git 排除的可重建内容。
# 幂等：已存在的内容跳过，只重建缺失项。
# ============================================================
# 不启用 set -e：关键步骤手动容错，避免单点失败终止整个重建
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
# PI_HOME 必须存在（仓库/配置未就绪时后续相对路径全部失效）
if [ ! -d "$PI_HOME" ]; then
  echo "rebuild.sh: PI_HOME 不存在: $PI_HOME" >&2
  echo "请先克隆仓库: git clone https://github.com/cyfxxx/pi-tools.git $PI_HOME" >&2
  exit 1
fi

# ---- 参数解析 ----
# --yes 非交互 | --voice/--no-voice 语音重建开关 | --whisper-model=<名> 模型档位 | --no-gpu/--no-piper 抑制可选子项
# --no-log 关闭自动日志（默认 --yes 模式落盘 logs/rebuild-<ts>.log，带时间戳可追溯）
YES=0; VOICE=""; WHISPER_MODEL="base"; NO_GPU=0; NO_PIPER=0; NO_LOG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --voice) VOICE=1 ;;
    --no-voice) VOICE=0 ;;
    --whisper-model=*) WHISPER_MODEL="${1#*=}" ;;
    --whisper-model) shift; [ $# -gt 0 ] && WHISPER_MODEL="$1" ;;
    --no-gpu) NO_GPU=1 ;;
    --no-piper) NO_PIPER=1 ;;
    --no-log) NO_LOG=1 ;;
    *) warn "未知参数: $1（忽略）" ;;
  esac
  shift
done

# --yes 模式自动落盘日志（进程替换 tee：脚本退出即 EOF，无丢行）
if [ "$YES" = "1" ] && [ "$NO_LOG" = "0" ]; then
  LOG_FILE="$PI_HOME/logs/rebuild-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p "$(dirname "$LOG_FILE")"
  exec > >(tee -a "$LOG_FILE") 2>&1
  echo "重建日志: $LOG_FILE"
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
title(){ echo -e "\n${CYAN}[$1]${NC} $2（+${SECONDS}s）"; }
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

  # 基础系统包（libnss3/libnspr4 为 Chromium 运行所需；安装前先 update，避免缓存过期找不到包）
  local pkgs=""
  command -v git        &>/dev/null || pkgs="$pkgs git"
  command -v fdfind     &>/dev/null || pkgs="$pkgs fd-find"
  command -v rg         &>/dev/null || pkgs="$pkgs ripgrep"
  dpkg -l python3-venv &>/dev/null 2>&1 || pkgs="$pkgs python3-venv"
  dpkg -l libnss3      &>/dev/null 2>&1 || pkgs="$pkgs libnss3"
  dpkg -l libnspr4     &>/dev/null 2>&1 || pkgs="$pkgs libnspr4"
  if [ -n "$pkgs" ]; then
    info "apt-get update（确保包索引最新）..."
    apt-get update -qq 2>&1 | tail -1 || warn "apt-get update 失败（网络问题？继续尝试安装）"
    info "安装系统依赖:$pkgs"
    apt-get install -y $pkgs 2>&1 | tail -1 || warn "部分系统依赖安装失败，跳过"
  fi

  # Chromium 运行库（按 .so 探测缺失，Ubuntu 24.04+ 用 t64 包名，旧版回退经典名）
  # 缺库时 CloakBrowser 启动 exit 127 / chrome 崩溃，smoke-test 浏览器项失败
  local chrome_libs=(
    "libasound.so.2:libasound2t64:libasound2"
    "libatk-1.0.so.0:libatk1.0-0t64:libatk1.0-0"
    "libcups.so.2:libcups2t64:libcups2"
    "libgbm.so.1:libgbm1:"
  )
  local chrome_missing=""
  for entry in "${chrome_libs[@]}"; do
    local so="${entry%%:*}" rest="${entry#*:}"
    ldconfig -p 2>/dev/null | grep -q "$so" && continue
    local p1="${rest%%:*}" p2="${rest#*:}"
    if [ -z "$p2" ]; then
      chrome_missing="$chrome_missing $p1"
    else
      # 优先 t64 包名，失败回退经典名（apt 索引已在上面 update）
      if ! apt-get install -y "$p1" -qq >/dev/null 2>&1; then
        apt-get install -y "$p2" -qq >/dev/null 2>&1 || chrome_missing="$chrome_missing $p1($p2)"
      fi
    fi
  done
  [ -z "$chrome_missing" ] || warn "Chromium 库安装失败:$chrome_missing（浏览器可能无法启动）"

  # python3 venv 可用性实际探测（dpkg 显示已装 ≠ ensurepip 可用，Debian/Ubuntu 存在空壳）
  VENV_PROBE=/tmp/.venv-probe
  rm -rf "$VENV_PROBE"
  VENV_OK=0
  if python3 -m venv "$VENV_PROBE" >/dev/null 2>&1 && [ -x "$VENV_PROBE/bin/python" ]; then
    VENV_OK=1; rm -rf "$VENV_PROBE"
  else
    rm -rf "$VENV_PROBE"
    info "python3 venv 不可用（ensurepip 缺失），安装 python3.12-venv/python3-venv ..."
    apt-get update -qq 2>&1 | tail -1 || true
    apt-get install -y python3.12-venv python3-venv 2>&1 | tail -1 || warn "venv 包安装失败"
    if python3 -m venv "$VENV_PROBE" >/dev/null 2>&1 && [ -x "$VENV_PROBE/bin/python" ]; then
      VENV_OK=1; rm -rf "$VENV_PROBE"
    fi
  fi
  [ "$VENV_OK" = "1" ] && ok "python3 venv 可用" || warn "python3 venv 仍不可用（SearXNG 将无法重建）"
  # 验证关键工具
  command -v git &>/dev/null && ok "git 已就绪" || warn "git 未安装"
  command -v curl &>/dev/null && ok "curl 已就绪" || warn "curl 未安装（网络探测/下载将失败）"
  command -v fdfind &>/dev/null && ok "fd-find 已就绪" || warn "fd-find 未安装"
  command -v rg &>/dev/null && ok "ripgrep 已就绪" || warn "ripgrep 未安装"
  dpkg -l python3-venv &>/dev/null 2>&1 && ok "python3-venv 已就绪" || warn "python3-venv 未安装"

  # 磁盘空间（README 要求 >=2GB：SearXNG venv+repo+依赖 ~150MB，npm ~330MB，Chromium ~200MB）
  local avail_kb=$(df -k "$PI_HOME" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$avail_kb" ]; then
    if [ "$avail_kb" -lt 2097152 ]; then
      warn "磁盘可用 $(($avail_kb / 1024)) MB < 2GB——重建可能中途失败，建议先清理空间"
    else
      ok "磁盘空间 $(($avail_kb / 1024 / 1024)) GB 可用"
    fi
  fi
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

  # pi-web-search 指向本地 SearXNG（幂等：仅在未配置 searxng_url 时写入）
  if [ -f "$PI_HOME/searxng/settings.yml" ] && [ -f "$PI_HOME/agent/settings.json" ]; then
    python3 - "$PI_HOME/agent/settings.json" <<'PY' | tail -1
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    raise SystemExit(0)
ws = dict(d.get('pi-web-search') or {})
if 'searxng_url' not in ws:
    ws['searxng_url'] = 'http://127.0.0.1:8889'
    ws.setdefault('search_timeout', 10000)
    d['pi-web-search'] = ws
    json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
    print('pi-web-search → 已指向本地 SearXNG (127.0.0.1:8889)')
else:
    print('pi-web-search → 已存在配置，跳过')
PY
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

  # 扩展自动发现：pi 0.83+ 从 ~/.pi/agent/extensions/ 目录自动加载，无需写入 settings.json extensions
  # （settings.json 的 extensions 数组仅作覆盖模式：! 排除 / + 强制包含 / - 强制排除，不再承担注册职责）
  # 动态扫描全部扩展目录（含新扩展免维护），逐个验证 index.ts 入口
  EXT_DIRS=""
  missing=""
  for d in "$PI_HOME/agent/extensions"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in tests|node_modules|types) continue ;; esac
    EXT_DIRS="$EXT_DIRS $name"
    [ -f "$d/index.ts" ] || missing="$missing $name"
  done
  if [ -z "$missing" ]; then
    ok "扩展目录 index.ts 齐备（$(echo $EXT_DIRS | wc -w) 个: $EXT_DIRS）"
  else
    warn "扩展目录缺失 index.ts:$missing（重建后自动发现将不完整）"
  fi
}

# ---- Phase 2-A: npm 依赖 ----
# 幂等判定：node_modules 目录非空 ≠ 依赖齐备（中断/失败的 install 会残留部分包）。
# 按 package.json 的 dependencies+devDependencies 逐包探测缺失，缺则装。
# 并发：≤3 个 npm install 同时跑（滚动窗口，避免 npm 缓存争抢/registry 压力）。
npm_missing_deps() {
  python3 - "$1" <<'PY'
import json, os, sys
pkg_dir = sys.argv[1]
try:
    d = json.load(open(os.path.join(pkg_dir, 'package.json')))
except Exception:
    print('PKGERR')
    raise SystemExit(0)
deps = {**d.get('dependencies', {}), **d.get('devDependencies', {})}
nm = os.path.join(pkg_dir, 'node_modules')
print(' '.join(k for k in deps if not os.path.isdir(os.path.join(nm, k))))
PY
}

phase2_npm() {
  title "Phase 2-A" "npm 依赖（并发 ≤3）"

  local MAX_JOBS=3
  local -a pids=()
  local n=0
  local installed_count=0

  npm_install_bg() {
    local d="$1"
    info "安装依赖: ${d#$PI_HOME/}"
    (cd "$d" && npm install --no-fund --no-audit >/dev/null 2>&1)
    if [ $? -eq 0 ]; then
      echo "  ✓ npm install 完成: ${d#$PI_HOME/}"
    else
      echo "  ✗ npm install 失败: ${d#$PI_HOME/}"
    fi
  }

  enqueue_install() {
    local d="$1"
    npm_install_bg "$d" &
    pids+=("$!")
    n=$((n + 1))
    installed_count=$((installed_count + 1))
    # 滚动窗口：满 MAX_JOBS 时等最早一个完成再继续
    if [ "$n" -ge "$MAX_JOBS" ]; then
      wait "${pids[0]}" 2>/dev/null || true
      pids=("${pids[@]:1}")
      n=$((n - 1))
    fi
  }

  if [ -f "$PI_HOME/agent/npm/package.json" ]; then
    local missing
    missing=$(npm_missing_deps "$PI_HOME/agent/npm")
    if [ -n "$missing" ] && [ "$missing" != "PKGERR" ]; then
      enqueue_install "$PI_HOME/agent/npm"
    else
      ok "agent/npm/node_modules/ 依赖齐备"
    fi
  fi

  for ext in "$PI_HOME/agent/extensions"/*/; do
    [ -d "$ext" ] || continue
    local name=$(basename "$ext")
    if [ -f "$ext/package.json" ]; then
      local missing
      missing=$(npm_missing_deps "${ext%/}")
      if [ -n "$missing" ] && [ "$missing" != "PKGERR" ]; then
        enqueue_install "${ext%/}"
      else
        ok "extensions/$name/node_modules/ 依赖齐备"
      fi
    fi
  done

  # 收尾：等剩余并发任务
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  if [ "$installed_count" -gt 0 ]; then
    info "本次安装 $installed_count 个依赖集（其余幂等跳过）"
    # 安装后统一报告各目录包数
    [ -d "$PI_HOME/agent/npm/node_modules" ] && ok "agent/npm: $(ls "$PI_HOME/agent/npm/node_modules" 2>/dev/null | wc -l) packages"
    for ext in "$PI_HOME/agent/extensions"/*/; do
      [ -d "$ext/node_modules" ] && ok "extensions/$(basename "$ext"): $(ls "$ext/node_modules" 2>/dev/null | wc -l) packages"
    done
  fi
}

# ---- Phase 2-B: Python 环境 (venv) ----
phase2_python_venv() {
  title "Phase 2-B" "Python venv"

  if [ -f "$PI_HOME/searxng/settings.yml" ]; then
    # 幂等判定：python 与 pip 都必须存在（中断的 venv 创建可能只有 python 没有 pip）
    if [ ! -x "$PI_HOME/searxng/venv/bin/python" ] || [ ! -x "$PI_HOME/searxng/venv/bin/pip" ]; then
      # preflight 已探测 venv 可用性（VENV_OK）；此处兑底再试一次安装
      if [ "${VENV_OK:-0}" != "1" ]; then
        apt-get install -y python3.12-venv python3-venv -qq 2>&1 | tail -1
      fi
      info "创建 SearXNG venv..."
      (cd "$PI_HOME/searxng" && python3 -m venv --copies venv) || {
        warn "venv 创建失败——SearXNG 将不可用。修复: apt-get install python3.12-venv 后重跑 rebuild"
        return 1
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
    # start.sh 使用 granian 启动（在 requirements-server.txt 中），缺失会导致无法启动
    if ! "$PI_HOME/searxng/venv/bin/python" -c "import granian" 2>/dev/null; then
      info "安装 SearXNG server 依赖（granian）..."
      "$PI_HOME/searxng/venv/bin/pip" install -q -r "$PI_HOME/searxng/repo/requirements-server.txt" 2>&1 | tail -3 || {
        warn "SearXNG server 依赖安装失败（start.sh 将无法启动）"
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

# 定位 pi 安装根（优先 current，否则取最高版本目录）；输出绝对路径，找不到输出空
find_pi_root() {
  local pi_node_dir="$HOME/.local/share/pi-node"
  local root=""
  if [ -d "$pi_node_dir/current" ]; then
    root="$(readlink -f "$pi_node_dir/current" 2>/dev/null || echo "$pi_node_dir/current")"
  fi
  if [ -z "$root" ] || [ ! -d "$root/lib/node_modules/@earendil-works" ]; then
    for d in "$pi_node_dir"/*/; do
      [ -d "$d/lib/node_modules/@earendil-works" ] && root="${d%/}" && break
    done
  fi
  if [ -z "$root" ]; then
    echo ""
    return 1
  fi
  (cd "$root" && pwd -P 2>/dev/null || echo "$root")
}

# ---- Phase 2-C: 二进制（fd/rg via apt） ----
phase2_binaries() {
  title "Phase 2-C" "fd/rg 二进制"

  # fd / rg (via apt)
  local fd_src rg_src
  fd_src="$(command -v fdfind 2>/dev/null)"; rg_src="$(command -v rg 2>/dev/null)"
  [ -x "$fd_src" ] || apt-get install -y fd-find -qq 2>&1 | tail -1
  [ -x "$rg_src" ] || apt-get install -y ripgrep -qq 2>&1 | tail -1
  # 解真实路径：PATH 前缀可能已含 agent/bin（本仓库约定），command -v 会命中旧链接自身，
  # 直接 ln -sf 会生成自引用链接（第二次重建即坏）。readlink -f 解不出时回退标准路径。
  fd_src="$(readlink -f "$fd_src" 2>/dev/null || echo "$fd_src")"
  rg_src="$(readlink -f "$rg_src" 2>/dev/null || echo "$rg_src")"
  case "$fd_src" in "$PI_HOME/agent/bin/"*) fd_src="/usr/bin/fdfind" ;; esac
  case "$rg_src" in "$PI_HOME/agent/bin/"*) rg_src="/usr/bin/rg" ;; esac
  ln -sf "$fd_src" "$PI_HOME/agent/bin/fd" 2>/dev/null || true
  ln -sf "$rg_src" "$PI_HOME/agent/bin/rg" 2>/dev/null || true
  ok "agent/bin/fd ($($PI_HOME/agent/bin/fd --version 2>/dev/null | head -1))"
  ok "agent/bin/rg ($($PI_HOME/agent/bin/rg --version 2>/dev/null | head -1))"
}

# ---- Phase 2-C2: CloakBrowser Chromium（pi-browser 扩展依赖） ----
# 直连失败时：① GH_PROXY 镜像 GitHub Releases（CLOAKBROWSER_DOWNLOAD_URL 支持自定义源，
# 校验和也从镜像拉取，失败则跳过校验——与官方逻辑一致）；② 仍失败给出手动 TLS 绕过命令。
phase2_browser() {
  title "Phase 2-C2" "CloakBrowser Chromium"

  local ext="$PI_HOME/agent/extensions/pi-browser"
  if [ ! -d "$ext/node_modules/cloakbrowser" ]; then
    info "pi-browser 扩展未安装，跳过"
    return 0
  fi

  # 已装且共享库齐备 → 幂等跳过
  local chrome=""
  chrome=$(cd "$ext" && timeout 60 npx cloakbrowser info 2>/dev/null | grep -oE '/[^ ]+chrome$' | head -1)
  if [ -n "$chrome" ] && [ -f "$chrome" ]; then
    local miss=$(ldd "$chrome" 2>/dev/null | grep -c "not found")
    if [ "$miss" = "0" ]; then
      ok "Chromium 已就绪（$chrome）"
      return 0
    fi
    warn "Chromium 缺 $miss 个共享库（rebuild 已补装运行库仍缺，手动: apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libcups2t64 libgbm1）"
    return 0
  fi

  info "安装 Chromium（cloakbrowser install，约 200MB）..."
  if (cd "$ext" && timeout 600 npx cloakbrowser install >/dev/null 2>&1); then
    ok "Chromium 安装完成"
    return 0
  fi

  if [ -n "${GH_PROXY:-}" ]; then
    info "直连失败，改用 GitHub 镜像重试（GH_PROXY）..."
    if (cd "$ext" && CLOAKBROWSER_DOWNLOAD_URL="${GH_PROXY}https://github.com/CloakHQ/cloakbrowser/releases/download" timeout 600 npx cloakbrowser install >/dev/null 2>&1); then
      ok "Chromium 安装完成（镜像源）"
      return 0
    fi
  fi

  warn "Chromium 安装失败——浏览器功能不可用"
  info "不可信网络可手动绕过 TLS 校验: cd $ext && NODE_TLS_REJECT_UNAUTHORIZED=0 npx cloakbrowser install"
}

# ---- Phase 2-D: 扩展类型链接（tsconfig paths 同步到实际 pi 安装根） ----
phase2_types() {
  title "Phase 2-D" "扩展类型链接"
  local tsconfig="$PI_HOME/agent/extensions/tsconfig.json"
  [ -f "$tsconfig" ] || { warn "extensions/tsconfig.json 缺失"; return 1; }

  # 定位 pi 安装根（复用 find_pi_root；wrapper 已接管 pi 命令，which pi 反推不可靠）
  local root="$(find_pi_root)"
  if [ -z "$root" ]; then
    warn "未找到 pi 安装目录（$HOME/.local/share/pi-node/*），跳过 tsconfig 链接同步"
    info "安装 pi（npm install -g @earendil-works/pi-coding-agent）后重跑 rebuild 即可补齐"
    return 0
  fi

  if grep -qF "$root/lib/node_modules" "$tsconfig"; then
    ok "tsconfig paths 已指向 $root"
    return 0
  fi

  python3 - "$tsconfig" "$root" <<'PY' && ok "tsconfig paths 已重写到 $root"
import json, sys
p, root = sys.argv[1], sys.argv[2]
d = json.load(open(p))
paths = d.get('compilerOptions', {}).get('paths', {})
changed = False
for k, v in paths.items():
    for i, x in enumerate(v):
        marker = '/lib/node_modules/'
        j = x.find(marker)
        if j > 0 and '.local/share/pi-node/' in x[:j]:
            v[i] = root + x[j:]
            changed = True
if changed:
    with open(p, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write('\n')
PY
}

# ---- Phase 2-E: pi-wrapper 自愈 ----
phase2_wrapper() {
  title "Phase 2-E" "Pi wrapper 自愈"
  local sw="$PI_HOME/scripts/install-wrapper.sh"
  if [ ! -f "$sw" ]; then
    warn "install-wrapper.sh 缺失"
    return 0
  fi
  if bash "$sw" --ensure --quiet; then
    ok "wrapper 已就绪（cron 每分钟 + 交互 shell 双保险）"
  else
    warn "wrapper ensure 失败，请手动运行: bash $sw"
  fi
}

# ---- Phase 2-F: 语音服务（pi-voice 后端，条件触发） ----
# 触发条件：agent/pi-voice.json 存在（本机配置过语音）或 --voice 强制；--no-voice 强制跳过。
# 子项按平台/能力分支：termux 提示 termux-api；linux 装 espeak-ng/paplay；
# GPU 检测提示 CUDA 库（--no-gpu 跳过）；piper 可选（--no-piper 跳过）。
phase2_voice() {
  title "Phase 2-F" "语音服务（pi-voice 后端）"
  local wsv="$PI_HOME/scripts/pi-whisper.sh"
  local voice_cfg="$PI_HOME/agent/pi-voice.json"
  [ -f "$wsv" ] || { warn "pi-whisper.sh 缺失，跳过"; return 0; }

  # 条件触发判定
  local want=0
  if [ "$VOICE" = "1" ]; then want=1
  elif [ "$VOICE" = "0" ]; then want=0
  elif [ -f "$voice_cfg" ]; then want=1
  fi
  if [ "$want" = "0" ]; then
    info "未检测到语音配置（agent/pi-voice.json 不存在），跳过 whisper/语音依赖（需要时: rebuild --voice）"
    return 0
  fi

  # 平台探测（termux / wsl / 其他 linux）
  local is_termux=0 is_wsl=0
  command -v termux-microphone-record >/dev/null 2>&1 && is_termux=1
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && is_wsl=1
  [ "$is_termux" = "1" ] && info "平台: Termux (Android)" || info "平台: $([ "$is_wsl" = "1" ] && echo WSL2 || echo Linux)"

  # 1. whisper venv（含 opencc 繁→简，缺失时中文转写输出繁体）
  local venv="${PI_WHISPER_VENV:-/opt/pi-whisper/venv}"
  if [ ! -x "$venv/bin/python" ]; then
    info "创建 whisper venv 并安装 faster-whisper + opencc …"
    if python3 -m venv "$venv" && "$venv/bin/pip" install -q faster-whisper opencc-python-reimplemented 2>&1 | tail -1; then
      ok "whisper venv 就绪（含 opencc）"
    else
      warn "venv 安装失败，请手动: python3 -m venv $venv && $venv/bin/pip install faster-whisper opencc-python-reimplemented"
      return 0
    fi
  elif ! "$venv/bin/python" -c 'import opencc' >/dev/null 2>&1; then
    warn "opencc 未安装（中文转写将输出繁体），修复: $venv/bin/pip install opencc-python-reimplemented"
  fi

  # 2. whisper 模型（--whisper-model，默认 base；hf-mirror）
  local models_dir=/opt/pi-whisper/models
  if [ ! -d "$models_dir" ] || [ -z "$(ls -A "$models_dir" 2>/dev/null)" ]; then
    info "下载 whisper 模型 $WHISPER_MODEL（hf-mirror，${WHISPER_MODEL}≈74MB，大模型更久）…"
    if HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 "$venv/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('$WHISPER_MODEL', device='cpu', compute_type='int8', download_root='$models_dir')" >/dev/null 2>&1; then
      ok "whisper 模型 $WHISPER_MODEL 就绪"
    else
      warn "模型下载失败，可稍后手动运行: HF_ENDPOINT=https://hf-mirror.com $venv/bin/python -c \"from faster_whisper import WhisperModel; WhisperModel('$WHISPER_MODEL', device='cpu', compute_type='int8', download_root='$models_dir')\""
    fi
  else
    ok "whisper 模型目录已有模型（如需切换档位: /voice model <tiny|base|small|medium|large-v3>）"
  fi

  # 3. GPU 推理（linux；CUDA 库可选，约 500MB）
  if [ "$is_termux" = "0" ] && [ "$NO_GPU" = "0" ] && command -v nvidia-smi >/dev/null 2>&1; then
    # CUDA 可用需同时满足：ctranslate2 报 GPU 可见 + nvidia-cublas/cudnn pip 库已安装
    # （仅驱动可见时推理会报 libcublas.so.12 not found，whisper-server 会降级 CPU）
    NV_LIB="$(ls -d "$venv"/lib/python*/site-packages/nvidia 2>/dev/null | head -1)"
    if "$venv/bin/python" -c 'import ctranslate2; exit(0 if ctranslate2.get_cuda_device_count() > 0 else 1)' >/dev/null 2>&1 \
       && [ -n "$NV_LIB" ] && [ -d "$NV_LIB/cublas/lib" ] && [ -d "$NV_LIB/cudnn/lib" ]; then
      ok "检测到 GPU：CUDA 库齐备，whisper 将自动 cuda/float16 推理（可 /voice model small 提升准确率）"
    else
      warn "检测到 NVIDIA GPU，但 CUDA 库缺失（whisper 将回退 CPU 推理）"
      info "可选安装（约 500MB，--no-gpu 跳过）: $venv/bin/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12"
    fi
  fi

  # 4. TTS 平台依赖
  if [ "$is_termux" = "1" ]; then
    info "Termux 录音依赖请手动: pkg install termux-api（rebuild 无法代跑 Android 侧）"
  else
    if ! command -v espeak-ng >/dev/null 2>&1 || ! command -v paplay >/dev/null 2>&1; then
      info "安装 TTS 依赖（espeak-ng + pulseaudio-utils）…"
      apt-get install -y espeak-ng pulseaudio-utils >/dev/null 2>&1 \
        && ok "TTS 依赖就绪" || warn "TTS 依赖安装失败（不影响 whisper 转写）"
    fi
    if [ "$NO_PIPER" = "0" ] && ! command -v piper >/dev/null 2>&1; then
      warn "piper 神经 TTS 未安装（当前用 espeak-ng 拼音合成）"
      info "可选安装（63MB 模型，--no-piper 跳过）: 见 ~/.pi/agent/extensions/pi-voice/README.md"
    fi
  fi

  # 5. 启动服务
  bash "$wsv" start >/dev/null 2>&1 \
    && ok "whisper 服务已启动（$(bash "$wsv" status 2>/dev/null | head -1)）" \
    || warn "whisper 启动失败，可稍后运行: bash $wsv start"
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
  # 模型配置文件名随 pi 版本变化：<0.84 models.json，≥0.84 models-store.json，按存在性校验
  local mfile=""
  [ -f "$PI_HOME/agent/models.json" ] && mfile="$PI_HOME/agent/models.json"
  [ -f "$PI_HOME/agent/models-store.json" ] && mfile="$PI_HOME/agent/models-store.json"
  if [ -f "$PI_HOME/searxng/venv/bin/python" ]; then
    "$PI_HOME/searxng/venv/bin/python" -c "import yaml; yaml.safe_load(open('$PI_HOME/searxng/settings.yml'))" 2>/dev/null \
      && ok "settings.yml: valid YAML" \
      || warn "settings.yml: YAML 校验失败"
    "$PI_HOME/searxng/venv/bin/python" -c "import json; json.load(open('$PI_HOME/agent/settings.json'))" 2>/dev/null \
      && ok "settings.json: valid JSON" \
      || warn "settings.json: JSON 校验失败"
    if [ -n "$mfile" ]; then
      "$PI_HOME/searxng/venv/bin/python" -c "import json; json.load(open('$mfile'))" 2>/dev/null \
        && ok "models config: valid JSON ($(basename "$mfile"))" \
        || warn "models config: JSON 校验失败 ($mfile)"
    fi
  else
    python3 -c "import json; json.load(open('$PI_HOME/agent/settings.json'))" 2>/dev/null \
      && ok "settings.json: valid JSON" \
      || warn "settings.json: JSON 校验失败"
    if [ -n "$mfile" ]; then
      python3 -c "import json; json.load(open('$mfile'))" 2>/dev/null \
        && ok "models config: valid JSON ($(basename "$mfile"))" \
        || warn "models config: JSON 校验失败 ($mfile)"
    fi
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
  if [ -f "$PI_HOME/agent/extensions/pi-browser/node_modules/cloakbrowser/package.json" ]; then
    CB_VER=$(node -e "console.log(require('$PI_HOME/agent/extensions/pi-browser/node_modules/cloakbrowser/package.json').version)" 2>/dev/null)
    ok "CloakBrowser v$CB_VER"
    # 检测 Chromium 是否已安装且共享库齐备（缺库时启动 exit 127）
    if command -v npx &>/dev/null \
       && CHROME_BIN=$(cd "$PI_HOME/agent/extensions/pi-browser" 2>/dev/null && npx cloakbrowser info 2>/dev/null | grep -oE '/[^ ]+chrome$' | head -1) \
       && [ -n "$CHROME_BIN" ]; then
      local miss=$(ldd "$CHROME_BIN" 2>/dev/null | grep -c "not found")
      if [ "$miss" = "0" ]; then
        ok "Chromium 已安装且共享库齐备（$CHROME_BIN）"
      else
        warn "Chromium 已安装但缺 $miss 个共享库（启动将失败）"
        info "修复: apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libcups2t64 libgbm1（旧发行版去掉 t64 后缀）"
      fi
    else
      warn "Chromium 未安装，浏览器功能不可用"
      info "运行: cd $PI_HOME/agent/extensions/pi-browser && npx cloakbrowser install 安装"
    fi
  else
    warn "CloakBrowser npm 包未安装，浏览器功能不可用"
  fi

  # pi-memory 数据目录（合并 ctx-lite 后）
  if [ -d "$PI_HOME/memory/checkpoints" ]; then
    ok "pi-memory/checkpoints/ 已就绪"
  else
    mkdir -p "$PI_HOME/memory/checkpoints"
    ok "pi-memory/checkpoints/ 已创建"
  fi

  # 扩展依赖：动态扫描全部扩展（有依赖的需 node_modules；无依赖的跳过）
  for d in "$PI_HOME/agent/extensions"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in tests|node_modules|types) continue ;; esac
    if [ -f "$d/package.json" ]; then
      dep_count=$(python3 -c "import json; print(len(json.load(open('$d/package.json')).get('dependencies',{})))" 2>/dev/null || echo "?")
    else
      dep_count=0
    fi
    if [ -d "$d/node_modules" ]; then
      pkgs=$(ls "$d/node_modules" 2>/dev/null | wc -l)
      [ "$dep_count" -gt 0 ] && ok "$name: $pkgs npm 包已安装" || ok "$name: $pkgs npm 包（无依赖声明）"
    else
      if [ "$dep_count" -gt 0 ]; then
        warn "$name: node_modules 未安装"
        info "运行: cd $PI_HOME/agent/extensions/$name && npm install"
      fi
    fi
  done

  # 扩展自动发现完整性（动态扫描；pi 0.83+ 从目录自动加载）
  python3 -c "
import os
ext_dir = '$PI_HOME/agent/extensions'
names = sorted(d for d in os.listdir(ext_dir) if os.path.isdir(os.path.join(ext_dir, d)) and d not in ('tests','node_modules','types'))
missing = [n for n in names if not os.path.isfile(os.path.join(ext_dir, n, 'index.ts'))]
print(('missing:'+','.join(missing)) if missing else ('ok:%d' % len(names)))
" 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      ok:*) ok "扩展自动发现: ${line#ok:} 个扩展目录 index.ts 齐备" ;;
      missing:*) warn "扩展自动发现缺失 index.ts: ${line#missing:}" ;;
    esac
  done
  # 检查 cron / systemd 是否已配置
  if command -v crontab &>/dev/null && crontab -l 2>/dev/null | grep -q pi-cron; then
    ok "pi-autopilot: crontab 已安装"
  elif command -v systemctl &>/dev/null && systemctl is-enabled pi-autopilot.timer &>/dev/null; then
    ok "pi-autopilot: systemd timer 已安装"
  else
    info "pi-autopilot: 运行 $PI_HOME/scripts/install-cron.sh 安装定时触发"
  fi

  # SearXNG 服务可达性（smoke-test 第 1 项依赖；rebuild 不代启动，给出命令）
  if [ -f "$PI_HOME/searxng/settings.yml" ] && [ -x "$PI_HOME/searxng/venv/bin/python" ]; then
    if curl -s --max-time 5 http://127.0.0.1:8889/ >/dev/null 2>&1; then
      ok "SearXNG 服务运行中 (127.0.0.1:8889)"
    else
      warn "SearXNG 服务未运行（smoke-test 需先启动）"
      info "启动: $PI_HOME/searxng/start.sh"
    fi
  fi

  # Provider 配置检查（模型配置文件名随 pi 版本变化，双文件兼容）
  local mfile=""
  [ -f "$PI_HOME/agent/models.json" ] && mfile="$PI_HOME/agent/models.json"
  [ -f "$PI_HOME/agent/models-store.json" ] && mfile="$PI_HOME/agent/models-store.json"
  if [ ! -f "$PI_HOME/agent/settings.json" ] || [ -z "$mfile" ]; then
    warn "settings.json / models 配置缺失——恢复到新设备后必须手动提供"
    info "从原机安全传输: scp user@orig:~/.pi/agent/{settings.json,models.json,auth.json} $PI_HOME/agent/"
    info "或原机打包: pi-backup create --with-auth 后 pi-backup restore 恢复"
    info "未提供时 pi 无可用模型，无法启动对话"
  elif [ -f "$PI_HOME/agent/settings.json" ] && [ -n "$mfile" ]; then
    DEFAULT_PROVIDER=$(python3 -c "import json; print(json.load(open('$PI_HOME/agent/settings.json')).get('defaultProvider',''))" 2>/dev/null)
    if [ -n "$DEFAULT_PROVIDER" ] && command -v pi &>/dev/null; then
      # 用 pi 自身模型目录判定：内置 provider（如 opencode-go）不在 models-store.json 中，
      # 旧逻辑按 models 配置查找会对内置 provider 误报"未定义"
      if timeout 30 pi --list-models "$DEFAULT_PROVIDER" 2>/dev/null | grep -qE "^\s*$DEFAULT_PROVIDER\s"; then
        ok "默认 provider '$DEFAULT_PROVIDER' 已就绪（pi 目录可解析）"
        if [ ! -f "$PI_HOME/agent/auth.json" ]; then
          warn "agent/auth.json 缺失——需要 API 凭据的 provider 将无法对话"
          info "原机打包恢复: pi-backup create --with-auth → 新机 pi-backup restore"
        fi
      else
        warn "默认 provider '$DEFAULT_PROVIDER' 未在模型目录中定义"
      fi
    else
      warn "pi CLI 不可用，跳过 provider 检查"
    fi
  fi

  if [ "$errors" -gt 0 ]; then
    echo -e "\n${YELLOW}⚠ 完成（$errors 项异常）${NC}"
  else
    echo -e "\n${GREEN}✓ 全部完成${NC}"
  fi
  return $errors
}

# ============================================================
# Main
# ============================================================
cd "$PI_HOME"
detect_china_network
set_mirrors
preflight
phase1_config

# Phase 2-A (npm), 2-B (venv), 2-B2 (repo) 并行执行
# SearXNG 依赖只需 venv+repo，与 npm 安装（耗时大头）重叠跑，省 ~1-2min
phase2_npm &
PID_NPM=$!
phase2_python_venv &
PID_VENV=$!
phase2_repo &
PID_REPO=$!
wait $PID_VENV $PID_REPO 2>/dev/null || true
phase2_searxng_deps
wait $PID_NPM 2>/dev/null || true

phase2_binaries
phase2_browser

# 类型链接需要 pi 已安装；wrapper/whisper 均为幂等
phase2_types
phase2_wrapper
phase2_voice

# TUI 核心补丁（幂等：已打补丁输出跳过；pi update 后必须重跑，否则
# patch-footer-live-context 缺失导致 footer 无实时 token，patch-voice-enter
# 缺失导致 pi-voice 的 Key.enter 注册吞掉全部回车（输入提交失效））
title "Phase 3" "TUI 核心补丁"
# wrapper 已接管 pi 命令（Phase 2-E），补丁脚本的 which pi 反推会拿到 wrapper 路径导致失败；
# 显式推导 dist 目录并导出 PI_DIST 传给补丁脚本（幂等：已打补丁输出跳过）
PI_ROOT="$(find_pi_root)"
PI_DIST=""
if [ -n "$PI_ROOT" ] && [ -d "$PI_ROOT/lib/node_modules/@earendil-works/pi-coding-agent/dist" ]; then
  PI_DIST="$PI_ROOT/lib/node_modules/@earendil-works/pi-coding-agent/dist"
  export PI_DIST
fi
if [ -z "$PI_DIST" ]; then
  warn "未找到 pi dist 目录，跳过全部 TUI 补丁（安装 pi 后重跑 rebuild 即可补齐）"
else
if [ -f "$PI_HOME/scripts/patch-footer-live-context.mjs" ]; then
  node "$PI_HOME/scripts/patch-footer-live-context.mjs" "$PI_DIST" >/dev/null 2>&1 \
    && ok "footer 实时上下文 token 补丁" \
    || warn "footer 补丁未应用（pi 版本可能已改动），需人工核对"
else
  warn "patch-footer-live-context.mjs 缺失，跳过"
fi
if [ -f "$PI_HOME/scripts/patch-voice-enter.mjs" ]; then
  node "$PI_HOME/scripts/patch-voice-enter.mjs" "$PI_DIST" >/dev/null 2>&1 \
    && ok "回车条件拦截补丁（pi-voice 听写）" \
    || warn "回车补丁未应用（pi 版本可能已改动）：未打补丁时回车键会被 pi-voice 吞掉"
else
  warn "patch-voice-enter.mjs 缺失，跳过"
fi
if [ -f "$PI_HOME/scripts/patch-plan-tools.mjs" ]; then
  node "$PI_HOME/scripts/patch-plan-tools.mjs" "$PI_DIST" >/dev/null 2>&1 \
    && ok "工具 schema 恢复补丁（plan-mode 模型侧切换）" \
    || warn "工具 schema 补丁未应用（pi 版本可能已改动）：恢复会话模型无法调用新注册工具（plan_enter/plan_exit），可移除补丁改用用户侧快捷键切换（方案 2）"
else
  warn "patch-plan-tools.mjs 缺失，跳过"
fi
fi

# Scheduler 离线调度安装（可选）
if [ -f "$PI_HOME/scripts/install-cron.sh" ]; then
  title "Phase 4" "定时调度安装"
  bash "$PI_HOME/scripts/install-cron.sh" 2>&1 | while IFS= read -r line; do
    if echo "$line" | grep -q "^✓"; then
      ok "${line#✓ }"
    elif echo "$line" | grep -q "^⚠"; then
      warn "${line#⚠ }"
    fi
  done
fi

verify
VERR=$?

echo -e "\n${GREEN}重建完成。${NC}"
echo ""
echo "  启动 SearXNG:    $PI_HOME/searxng/start.sh"
echo "  停止 SearXNG:    $PI_HOME/searxng/stop.sh"
echo "  重新生成配置:    $PI_HOME/searxng/generate-config.sh --force"
echo "  安装浏览器:      cd $PI_HOME && npx cloakbrowser install"
echo "  安装定时调度:    $PI_HOME/scripts/install-cron.sh"
echo "  Whisper 转写:    $PI_HOME/scripts/pi-whisper.sh {start|stop|status}"
echo "  wrapper 自愈:    $PI_HOME/scripts/install-wrapper.sh --ensure"
echo "  循环任务:        /loop 5m <prompt>"
echo "  定时任务:        /schedule cron \"0 9 * * 1-5\" <prompt>"
echo "  提醒:            /remind +30m <prompt>"

# 退出码反映 verify 结果：有异常时非 0（自动化/CI 可判定失败，勿吞错）
if [ "$VERR" -gt 0 ]; then
  echo -e "${YELLOW}重建结束：$VERR 项异常，见上方 ⚠ 行（修复后重跑 rebuild 幂等补齐）。${NC}" >&2
  exit 1
fi
exit 0
