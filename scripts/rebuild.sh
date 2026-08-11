#!/usr/bin/env bash
# ============================================================
# rebuild.sh — pi-tools 一键重建脚本
# 重建所有被 git 排除的可重建内容。
# 幂等：已存在的内容跳过，只重建缺失项。
# ============================================================
# 不启用 set -e：关键步骤手动容错，避免单点失败终止整个重建
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
# ---- 参数解析 ----
# --yes 非交互 | --voice/--no-voice 语音重建开关 | --whisper-model=<名> 模型档位 | --no-gpu/--no-piper 抑制可选子项
YES=0; VOICE=""; WHISPER_MODEL="base"; NO_GPU=0; NO_PIPER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --voice) VOICE=1 ;;
    --no-voice) VOICE=0 ;;
    --whisper-model=*) WHISPER_MODEL="${1#*=}" ;;
    --whisper-model) shift; [ $# -gt 0 ] && WHISPER_MODEL="$1" ;;
    --no-gpu) NO_GPU=1 ;;
    --no-piper) NO_PIPER=1 ;;
    *) warn "未知参数: $1（忽略）" ;;
  esac
  shift
done

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

  # 扩展自动发现：pi 0.83+ 从 ~/.pi/agent/extensions/ 目录自动加载，无需写入 settings.json extensions
  # （settings.json 的 extensions 数组仅作覆盖模式：! 排除 / + 强制包含 / - 强制排除，不再承担注册职责）
  # 动态扫描全部扩展目录（含新扩展免维护），逐个验证 index.ts 入口
  EXT_DIRS=""
  missing=""
  for d in "$PI_HOME/agent/extensions"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in tests|node_modules) continue ;; esac
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

# ---- Phase 2-D: 扩展类型链接（tsconfig paths 同步到实际 pi 安装根） ----
phase2_types() {
  title "Phase 2-D" "扩展类型链接"
  local tsconfig="$PI_HOME/agent/extensions/tsconfig.json"
  [ -f "$tsconfig" ] || { warn "extensions/tsconfig.json 缺失"; return 1; }

  # 定位 pi 安装根：优先 current，否则取最高版本目录
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
    warn "未找到 pi 安装目录（$pi_node_dir/*），跳过 tsconfig 链接同步"
    info "安装 pi（npm install -g @earendil-works/pi-coding-agent）后重跑 rebuild 即可补齐"
    return 0
  fi
  root="$(cd "$root" && pwd -P 2>/dev/null || echo "$root")"

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
    if "$venv/bin/python" -c 'import ctranslate2; exit(0 if ctranslate2.get_cuda_device_count() > 0 else 1)' >/dev/null 2>&1; then
      ok "检测到 GPU：whisper 将自动 cuda/float16 推理（可 /voice model small 提升准确率）"
    else
      warn "检测到 NVIDIA GPU，但 CUDA 库未安装（whisper 仍可用 CPU 推理）"
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
  if [ -f "$PI_HOME/agent/extensions/pi-browser/node_modules/cloakbrowser/package.json" ]; then
    CB_VER=$(node -e "console.log(require('$PI_HOME/agent/extensions/pi-browser/node_modules/cloakbrowser/package.json').version)" 2>/dev/null)
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
    case "$name" in tests|node_modules) continue ;; esac
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
names = sorted(d for d in os.listdir(ext_dir) if os.path.isdir(os.path.join(ext_dir, d)) and d not in ('tests','node_modules'))
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

# Provider 配置检查
  if [ ! -f "$PI_HOME/agent/settings.json" ] || [ ! -f "$PI_HOME/agent/models.json" ]; then
    warn "settings.json / models.json 缺失——恢复到新设备后必须手动提供"
    info "从原机安全传输: scp user@orig:~/.pi/agent/{settings.json,models.json,auth.json} $PI_HOME/agent/"
    info "或原机打包: pi-backup create --with-auth 后 pi-backup restore 恢复"
    info "未提供时 pi 无可用模型，无法启动对话"
  elif [ -f "$PI_HOME/agent/settings.json" ] && [ -f "$PI_HOME/agent/models.json" ]; then
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

# 类型链接需要 pi 已安装；wrapper/whisper 均为幂等
phase2_types
phase2_wrapper
phase2_voice

# TUI 核心补丁（幂等：已打补丁输出跳过；pi update 后必须重跑，否则
# patch-footer-live-context 缺失导致 footer 无实时 token，patch-voice-enter
# 缺失导致 pi-voice 的 Key.enter 注册吞掉全部回车（输入提交失效））
title "Phase 3" "TUI 核心补丁"
if [ -f "$PI_HOME/scripts/patch-footer-live-context.mjs" ]; then
  node "$PI_HOME/scripts/patch-footer-live-context.mjs" >/dev/null 2>&1 \
    && ok "footer 实时上下文 token 补丁" \
    || warn "footer 补丁未应用（pi 版本可能已改动），需人工核对"
else
  warn "patch-footer-live-context.mjs 缺失，跳过"
fi
if [ -f "$PI_HOME/scripts/patch-voice-enter.mjs" ]; then
  node "$PI_HOME/scripts/patch-voice-enter.mjs" >/dev/null 2>&1 \
    && ok "回车条件拦截补丁（pi-voice 听写）" \
    || warn "回车补丁未应用（pi 版本可能已改动）：未打补丁时回车键会被 pi-voice 吞掉"
else
  warn "patch-voice-enter.mjs 缺失，跳过"
fi
if [ -f "$PI_HOME/scripts/patch-plan-tools.mjs" ]; then
  node "$PI_HOME/scripts/patch-plan-tools.mjs" >/dev/null 2>&1 \
    && ok "工具 schema 恢复补丁（plan-mode 模型侧切换）" \
    || warn "工具 schema 补丁未应用（pi 版本可能已改动）：恢复会话模型无法调用新注册工具（plan_enter/plan_exit），可移除补丁改用用户侧快捷键切换（方案 2）"
else
  warn "patch-plan-tools.mjs 缺失，跳过"
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
