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

# ---- 输出辅助（先于参数解析定义：warn 可能在参数解析中被调用） ----
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
# 阶段耗时：增量显示（上次 title 至今），非脚本启动累计
_TITLE_TS=0
title(){ local now=$SECONDS; echo -e "\n${CYAN}[$1]${NC} $2（+$((now-_TITLE_TS))s）"; _TITLE_TS=$now; }
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
  # SIGPIPE 防御：日志管道读端（tee/外部 tail）被杀时脚本不应随之死亡，
  # 只丢弃后续写入（A1：管道中断导致 rebuild 被连带杀死的事故根因）
  trap '' PIPE
  exec > >(stdbuf -oL tee -a "$LOG_FILE") 2>&1
  echo "重建日志: $LOG_FILE"

  # 中断检测：上次重建日志无完成标记时提示幂等续跑（A2）
  # 注意：此处位于函数外，不能用 local（bash 报 "local: can only be used in a function"）
  last_log=$(ls -t "$PI_HOME"/logs/rebuild-*.log 2>/dev/null | head -1)
  if [ -n "$last_log" ] && [ "$last_log" != "$LOG_FILE" ] && ! grep -q "重建完成" "$last_log" 2>/dev/null; then
    echo "⚠ 检测到未完成的重建日志: $(basename "$last_log")——本次幂等续跑（已完成的将跳过）"
  fi
fi

# ---- 平台检测（Termux/Android 原生 vs Debian/Ubuntu 系）----
# 包名映射仅影响 Termux；其他平台（proot/WSL/原生 Linux）行为与原先完全一致。
IS_TERMUX=0
[ -d /data/data/com.termux ] && IS_TERMUX=1

# Debian/Ubuntu 包名 → 本平台包名（Termux 包名不同；非 Termux 原样透传）
pkg_map() {
  [ "$IS_TERMUX" = "1" ] || { echo "$1"; return 0; }
  case "$1" in
    fd-find)             echo "fd" ;;
    python3-venv|python3.12-venv) echo "python-ensurepip-wheels" ;;
    openssl)             echo "openssl-tool" ;;
    libnss3)             echo "libnss" ;;
    libnspr4)            echo "libnspr" ;;
    libasound2t64|libasound2) echo "libasound" ;;
    libatk1.0-0t64|libatk1.0-0) echo "atk" ;;
    libcups2t64|libcups2) echo "libcups" ;;
    libgbm1)             echo "libgbm" ;;
    pulseaudio-utils)    echo "pulseaudio" ;;
    *)                   echo "$1" ;;
  esac
}

# 包安装（Termux 走映射后包名，其余平台原样）
pkg_install() {
  local pkgs=""
  for p in "$@"; do pkgs="$pkgs $(pkg_map "$p")"; done
  apt-get install -y $pkgs -qq 2>&1 | tail -1
}

# ---- 网络检测 ----
detect_china_network() {
  # 检测到国内网络时设置镜像变量
  CHINA_MIRROR=0
  timeout 5 curl -s --connect-timeout 3 https://www.baidu.com >/dev/null 2>&1 && CHINA_MIRROR=1
}

set_mirrors() {
  # C3：测速结果缓存（TTL 1h，幂等续跑跳过 ~12s 测速）
  # 前置校验：curl 缺失时检测结果不可信（探测会静默失败误判直连）——不读缓存不写缓存
  local CACHE="$PI_HOME/logs/.mirror-cache"
  if command -v curl &>/dev/null && [ -f "$CACHE" ] && [ $(( $(date +%s) - $(stat -c %Y "$CACHE" 2>/dev/null || echo 0) )) -lt 3600 ]; then
    read -r GH_PROXY CHINA_MIRROR < "$CACHE" 2>/dev/null || true
    ok "镜像缓存命中（<1h）：GH_PROXY=${GH_PROXY:-直连}"
    return 0
  fi
  if [ "$CHINA_MIRROR" = "1" ]; then
    info "检测到国内网络，启用镜像加速"

    # npm
    npm config set registry https://registry.npmmirror.com 2>/dev/null
    ok "npm registry → https://registry.npmmirror.com"

    # GitHub 镜像前缀：多候选实测吞吐取最快（直连也算候选；
    # 固定单镜像可能踩到限速/失效，测速窗口 4s/候选，总耗时约 12s）
    local best="" best_speed=0 pfx sp
    for pfx in "" "https://gh-proxy.com/" "https://ghproxy.net/"; do
      sp=$(timeout 8 curl -s -o /dev/null --max-time 4 -w "%{speed_download}" \
        "${pfx}https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz" 2>/dev/null || echo "0")
      sp="${sp%.*}"
      [ "${sp:-0}" -gt "$best_speed" ] 2>/dev/null && { best="$pfx"; best_speed=$sp; }
    done
    GH_PROXY="$best"
    if [ -n "$GH_PROXY" ]; then
      ok "GitHub proxy → $GH_PROXY（${best_speed}B/s）"
    else
      ok "GitHub 直连最快（${best_speed}B/s）"
    fi

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
  # 仅 curl 可用时写缓存（curl 缺失时探测结果不可信，写入会污染后续续跑）
  if command -v curl &>/dev/null; then
    echo "$GH_PROXY $CHINA_MIRROR" > "$PI_HOME/logs/.mirror-cache" 2>/dev/null || true
  else
    rm -f "$PI_HOME/logs/.mirror-cache" 2>/dev/null || true
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
  # Termux 包名经 pkg_map 映射；fd 探测兼容 Termux 的 fd 命令
  local pkgs=""
  command -v git        &>/dev/null || pkgs="$pkgs git"
  command -v curl       &>/dev/null || pkgs="$pkgs curl"
  command -v fdfind     &>/dev/null || { command -v fd &>/dev/null || pkgs="$pkgs fd-find"; }
  command -v rg         &>/dev/null || pkgs="$pkgs ripgrep"
  dpkg -l python3-venv &>/dev/null 2>&1 || pkgs="$pkgs python3-venv"
  dpkg -l libnss3      &>/dev/null 2>&1 || pkgs="$pkgs libnss3"
  dpkg -l libnspr4     &>/dev/null 2>&1 || pkgs="$pkgs libnspr4"
  if [ -n "$pkgs" ]; then
    info "apt-get update（确保包索引最新）..."
    apt-get update -qq 2>&1 | tail -1 || warn "apt-get update 失败（网络问题？继续尝试安装）"
    info "安装系统依赖:$pkgs"
    pkg_install $pkgs || warn "部分系统依赖安装失败，跳过"
  fi

  # Chromium 运行库（按 .so 探测缺失，Ubuntu 24.04+ 用 t64 包名，旧版回退经典名）
  # 缺库时 CloakBrowser 启动 exit 127 / chrome 崩溃，smoke-test 浏览器项失败
  # Termux：官方 cloakbrowser 无 android 预编译包，用本地 chromium（termux-prereq.sh），无需 glibc 库
  local chrome_missing=""
  if [ "$IS_TERMUX" = "0" ]; then
    local chrome_libs=(
      "libasound.so.2:libasound2t64:libasound2"
      "libatk-1.0.so.0:libatk1.0-0t64:libatk1.0-0"
      "libcups.so.2:libcups2t64:libcups2"
      "libgbm.so.1:libgbm1:"
    )
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
  fi
  [ -z "$chrome_missing" ] || warn "Chromium 库安装失败:$chrome_missing（浏览器可能无法启动）"

  # python3 venv 可用性实际探测（dpkg 显示已装 ≠ ensurepip 可用，Debian/Ubuntu 存在空壳）
  # /tmp 只读环境（Termux 无 root）自动回退到 PI_HOME 下探测，避免误报不可用
  local probe_dir="$PI_HOME/.venv-probe"
  if mkdir -p /tmp 2>/dev/null; then probe_dir=/tmp/.venv-probe; fi
  VENV_PROBE="$probe_dir"
  rm -rf "$VENV_PROBE"
  VENV_OK=0
  if python3 -m venv "$VENV_PROBE" >/dev/null 2>&1 && [ -x "$VENV_PROBE/bin/python" ]; then
    VENV_OK=1; rm -rf "$VENV_PROBE"
  else
    rm -rf "$VENV_PROBE"
    info "python3 venv 不可用（ensurepip 缺失），安装 python3.12-venv/python3-venv ..."
    apt-get update -qq 2>&1 | tail -1 || true
    pkg_install python3.12-venv python3-venv || warn "venv 包安装失败"
    if python3 -m venv "$VENV_PROBE" >/dev/null 2>&1 && [ -x "$VENV_PROBE/bin/python" ]; then
      VENV_OK=1; rm -rf "$VENV_PROBE"
    fi
  fi
  [ "$VENV_OK" = "1" ] && ok "python3 venv 可用" || warn "python3 venv 仍不可用（SearXNG 将无法重建）"
  # 验证关键工具
  command -v git &>/dev/null && ok "git 已就绪" || warn "git 未安装"
  command -v curl &>/dev/null && ok "curl 已就绪" || warn "curl 未安装（网络探测/下载将失败）"
  command -v fdfind &>/dev/null && ok "fd-find 已就绪" || { command -v fd &>/dev/null && ok "fd (Termux) 已就绪" || warn "fd 未安装"; }
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
    # 失败时给出可操作诊断（如 Termux 缺 openssl-tool 曾导致 settings.yml 静默缺失）
    if ! out=$(bash "$PI_HOME/searxng/generate-config.sh" 2>&1); then
      warn "settings.yml 生成失败: $(echo "$out" | tail -1)"
      if [ "$IS_TERMUX" = "1" ] && ! command -v openssl >/dev/null 2>&1; then
        info "修复: pkg install openssl-tool（Termux openssl CLI 独立包）后重跑 rebuild"
      elif ! command -v openssl >/dev/null 2>&1; then
        info "修复: apt-get install -y openssl 后重跑 rebuild"
      fi
    else
      echo "$out" | head -1
    fi
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

  # npm install 超时（秒）：网络挂起时避免 rebuild 永久卡住（2026-08-15 容器实测
  # 直连 npmjs 挂 10 分钟无进展）。成功后跳过；失败按既有 A3 重跑捕获诊断。
  local NPM_INSTALL_TIMEOUT=300

  npm_install_bg() {
    local d="$1"
    info "安装依赖: ${d#$PI_HOME/}"
    if (cd "$d" && timeout $NPM_INSTALL_TIMEOUT npm install --no-fund --no-audit >/dev/null 2>&1); then
      echo "  ✓ npm install 完成: ${d#$PI_HOME/}"
    else
      echo "  ✗ npm install 失败: ${d#$PI_HOME/}"
      # A3：失败重跑一次捕获输出尾部，避免无从排查
      echo "  └ 诊断输出（尾部 10 行）:"
      (cd "$d" && timeout $NPM_INSTALL_TIMEOUT npm install --no-fund --no-audit 2>&1 | tail -10 | sed 's/^/    /')
    fi
  }

  enqueue_install() {
    local d="$1"
    npm_install_bg "$d" &
    pids+=("$!")
    n=$((n + 1))
    installed_count=$((installed_count + 1))
    # 滚动窗口：满 MAX_JOBS 时等最早一个完成再继续。
    # 注：bash 5.2.21 实测 wait -n 不输出完成 pid（手册 "may print"），
    # 无法精确移除——等最早一个（pids[0]）语义正确且兼容所有 bash ≥4.0。
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
        pkg_install python3.12-venv python3-venv
      fi
      info "创建 SearXNG venv..."
      (cd "$PI_HOME/searxng" && python3 -m venv --copies venv) || {
        warn "venv 创建失败——SearXNG 将不可用。修复: pkg_install python3.12-venv（Termux: pkg install python-ensurepip-wheels）后重跑 rebuild"
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
    # 多源轮换：主源 GH_PROXY（测速选出）；失败依次换 gh-proxy.com/ghproxy.net/直连
    # （单源在 GFW 限速/镜像失效时直接失败，换源可显著提高成功率）
    local tried="" url ok=0
    for pfx in "${GH_PROXY:-}" "https://gh-proxy.com/" "https://ghproxy.net/" ""; do
      url="${pfx}https://github.com/searxng/searxng"
      case " $tried " in *" $url "*) continue ;; esac
      tried="$tried $url"
      info "尝试: $url"
      # C1/C2：克隆加超时防镜像挂起无限卡；失败后 GIT_SSL_NO_VERIFY 兜底一次（沙箱证书损坏场景）
      if timeout 300 git clone --depth 1 "$url" "$PI_HOME/searxng/repo" >/dev/null 2>&1 || \
         { rm -rf "$PI_HOME/searxng/repo"; timeout 300 env GIT_SSL_NO_VERIFY=1 git clone --depth 1 "$url" "$PI_HOME/searxng/repo" >/dev/null 2>&1; }; then
        ok=1
        break
      fi
      rm -rf "$PI_HOME/searxng/repo"
    done
    if [ "$ok" = "1" ]; then
      ok "searxng/repo/ (HEAD at $(cd "$PI_HOME/searxng/repo" && git rev-parse --short HEAD 2>/dev/null))"
    else
      # C1：clone 全失败 → tarball 兜底（与测速资源一致，无 git 增量更新依赖故安全）
      local tb_url="${GH_PROXY:-}https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz"
      info "git clone 失败，改用 tarball: $tb_url"
      rm -rf "$PI_HOME/searxng/repo"; mkdir -p "$PI_HOME/searxng/repo"
      if timeout 300 curl -fsSL "$tb_url" | tar xz -C "$PI_HOME/searxng/repo" --strip-components=1 2>/dev/null \
         && [ -f "$PI_HOME/searxng/repo/requirements.txt" ]; then
        # git init + 基线提交：保持 .git 存在性判断与 verify 的 rev-parse 一致
        (cd "$PI_HOME/searxng/repo" && git init -q && git add -A >/dev/null 2>&1 \
          && git -c user.email=rebuild@local -c user.name=rebuild commit -qm tarball 2>/dev/null) || true
        ok "searxng/repo/（tarball 方式，requirements.txt 校验通过）"
        ok=1
      else
        warn "tarball 下载失败（$tb_url）"
      fi
    fi
    if [ "$ok" != "1" ]; then
      warn "SearXNG repo 获取失败（已尝试: $tried + tarball）"
      return 1
    fi
  else
    ok "searxng/repo/ 已存在"
  fi
}

# ---- Phase 2-B3: 从 repo requirements.txt 安装 SearXNG 依赖 (串行，在 venv+repo 就绪后) ----
phase2_searxng_deps() {
  title "Phase 2-B3" "SearXNG 依赖"

  if [ -f "$PI_HOME/searxng/venv/bin/python" ] && [ -f "$PI_HOME/searxng/repo/requirements.txt" ]; then
    # 检查关键模块是否缺失。searx 本体由 start.sh 的 PYTHONPATH=repo 提供，
    # 判定与复验均带 repo 路径，否则装完依赖仍 import 失败导致每次重装
    local searx_ok
    (cd "$PI_HOME/searxng/repo" && PYTHONPATH=. "$PI_HOME/searxng/venv/bin/python" -c "import searx" >/dev/null 2>&1) && searx_ok=1 || searx_ok=0
    if [ "$searx_ok" = "0" ]; then
      info "从 repo/requirements.txt 安装 SearXNG 依赖..."
      "$PI_HOME/searxng/venv/bin/pip" install -q -r "$PI_HOME/searxng/repo/requirements.txt" 2>&1 | tail -3 || {
        warn "SearXNG 依赖安装失败"
        return 1
      }
      # 复验：装完确认可导入（幂等判定与依赖完整性一致）
      (cd "$PI_HOME/searxng/repo" && PYTHONPATH=. "$PI_HOME/searxng/venv/bin/python" -c "import searx" >/dev/null 2>&1) \
        || warn "依赖安装完成但 import searx 仍失败（Python $( "$PI_HOME/searxng/venv/bin/python" --version 2>&1) 兼容问题？）"
    fi
    # start.sh 使用 granian 启动（在 requirements-server.txt 中），缺失会导致无法启动
    # Termux/android: granian(Rust) 无 wheel 无法构建，start.sh 已自动回退 uvicorn，此处告警即可
    if ! "$PI_HOME/searxng/venv/bin/python" -c "import granian" 2>/dev/null; then
      info "安装 SearXNG server 依赖（granian）..."
      "$PI_HOME/searxng/venv/bin/pip" install -q -r "$PI_HOME/searxng/repo/requirements-server.txt" 2>&1 | tail -3 || {
        if [ "$IS_TERMUX" = "1" ]; then
          warn "granian 安装失败（Termux 无预编译包）——start.sh 将用 uvicorn 回退启动"
        else
          warn "SearXNG server 依赖安装失败（start.sh 将无法启动）"
        fi
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
  # Termux (npm 全局安装)
  if [ -z "$root" ] && [ -d /data/data/com.termux/files/usr/lib/node_modules/@earendil-works ]; then
    root=/data/data/com.termux/files/usr
  fi
  # 通用兜底：npm 全局安装（任何平台，wrapper 接管后 which pi 不可靠）
  if [ -z "$root" ] && command -v npm >/dev/null 2>&1; then
    local npm_root
    npm_root="$(npm root -g 2>/dev/null || echo '')"
    [ -n "$npm_root" ] && [ -d "$npm_root/@earendil-works" ] && root="$(dirname "$npm_root")"
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
  fd_src="$(command -v fdfind 2>/dev/null)"
  # Termux: fd 命令名无 fdfind 前缀，直接认 fd
  [ -n "$fd_src" ] || fd_src="$(command -v fd 2>/dev/null)"
  rg_src="$(command -v rg 2>/dev/null)"
  [ -x "$fd_src" ] || pkg_install fd-find
  [ -x "$rg_src" ] || pkg_install ripgrep
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
# 可靠性判定：info 的 `Installed:` 字段（文件缺失时 info 仍打印 Binary 路径，grep 路径会假阳性）；
# ldd 仅对存在的文件执行（不存在时 ldd 报 "No such file" 而非 "not found"，grep -c 得 0 会误判齐备）。
# 返回：0=就绪 / 1=未安装 / 2=已装但缺共享库；CHROME_BIN_PATH 输出二进制路径。
# Termux/android: 官方无预编译包，本地 Chromium（CLOAKBROWSER_BINARY_PATH 或 ~/.cloakbrowser 符号链接）即就绪。
CHROME_BIN_PATH=""
chrome_ready() {
  local ext="$1" installed="" bin="" miss
  CHROME_BIN_PATH=""
  if [ "$IS_TERMUX" = "1" ]; then
    # 优先显式环境变量，其次 Termux chromium（Phase 3 自动建缓存符号链接 + playwright 补丁）
    bin="${CLOAKBROWSER_BINARY_PATH:-}"
    [ -n "$bin" ] && [ -x "$bin" ] || bin="$(command -v chromium-browser 2>/dev/null)"
    [ -n "$bin" ] && [ -x "$bin" ] || bin="$(ls "$HOME/.cloakbrowser"/*/chrome 2>/dev/null | head -1)"
    if [ -n "$bin" ] && [ -x "$bin" ]; then
      CHROME_BIN_PATH="$bin"
      return 0
    fi
    return 1
  fi
  # B3：单次 npx 调用取两个字段（Installed 状态 + 二进制路径），避免每次 rebuild 白跑 2 次 CLI
  local out installed bin
  out=$(cd "$ext" && timeout 60 npx cloakbrowser info 2>/dev/null)
  installed=$(echo "$out" | grep -E '^Installed:' | awk '{print $2}' | tr -d '\r')
  [ "$installed" = "true" ] || return 1
  bin=$(echo "$out" | grep -oE '/[^ ]+chrome$' | head -1)
  [ -n "$bin" ] && [ -f "$bin" ] || return 1
  CHROME_BIN_PATH="$bin"
  miss=$(ldd "$bin" 2>/dev/null | grep -c "not found")
  [ "$miss" = "0" ] && return 0 || return 2
}
phase2_browser() {
  title "Phase 2-C2" "CloakBrowser Chromium"

  local ext="$PI_HOME/agent/extensions/pi-browser"
  if [ ! -d "$ext/node_modules/cloakbrowser" ]; then
    info "pi-browser 扩展未安装，跳过"
    return 0
  fi

  # 已装且共享库齐备 → 幂等跳过
  chrome_ready "$ext"
  local rc=$?
  if [ "$rc" = "0" ]; then
    ok "Chromium 已就绪（$CHROME_BIN_PATH）"
    return 0
  fi
  if [ "$rc" = "2" ]; then
    warn "Chromium 已装但缺共享库（手动: apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libcups2t64 libgbm1）"
    return 0
  fi

  # 安装：直连 → 直连+绕 TLS → GH_PROXY 镜像兜底（实测直连绕 TLS 1.8MB/s，ghproxy 仅 0.49MB/s）
  # A4：清理上次中断残留的半截下载包
  rm -f "$HOME/.cloakbrowser"/_download_*.tar.gz "$HOME/.cloakbrowser"/*.part 2>/dev/null || true
  info "安装 Chromium（cloakbrowser install，约 200MB）..."
  if (cd "$ext" && timeout 600 npx cloakbrowser install >/dev/null 2>&1) && chrome_ready "$ext"; then
    ok "Chromium 安装完成"
    return 0
  fi
  # 沙箱/代理拦截证书链（UNABLE_TO_VERIFY_LEAF_SIGNATURE）时绕过 TLS 校验，仅限不可信网络环境
  if (cd "$ext" && NODE_TLS_REJECT_UNAUTHORIZED=0 timeout 600 npx cloakbrowser install >/dev/null 2>&1) && chrome_ready "$ext"; then
    ok "Chromium 安装完成（TLS 绕过）"
    return 0
  fi
  if [ -n "${GH_PROXY:-}" ]; then
    info "直连失败，改用 GitHub 镜像重试（GH_PROXY）..."
    if (cd "$ext" && CLOAKBROWSER_DOWNLOAD_URL="${GH_PROXY}https://github.com/CloakHQ/cloakbrowser/releases/download" timeout 600 npx cloakbrowser install >/dev/null 2>&1) && chrome_ready "$ext"; then
      ok "Chromium 安装完成（镜像源）"
      return 0
    fi
  fi

  warn "Chromium 安装失败——浏览器功能不可用"
  # A3：失败重跑捕获输出尾部（短超时 120s），便于诊断网络/证书问题
  warn "诊断输出（尾部 10 行）:"
  (cd "$ext" && timeout 120 npx cloakbrowser install 2>&1 | tail -10 | sed 's/^/    /') || true
  info "手动安装（不可信网络）: cd $ext && NODE_TLS_REJECT_UNAUTHORIZED=0 npx cloakbrowser install"
}

# ---- Phase 2-D: 扩展类型链接（tsconfig.local.json 生成，paths 指向本机 pi 安装根） ----
# tsconfig.json（共享）不含 paths——每环境安装路径不同，入库互相覆盖会导致 tsc 失败。
# 本阶段生成 gitignored 的 tsconfig.local.json（extends 共享配置 + 本机 paths）。
phase2_types() {
  title "Phase 2-D" "扩展类型链接（tsconfig.local.json）"
  # 定位 pi 安装根（复用 find_pi_root；wrapper 已接管 pi 命令，which pi 反推不可靠）
  local root="$(find_pi_root)"
  if [ -z "$root" ]; then
    warn "未找到 pi 安装目录（$HOME/.local/share/pi-node/*），跳过 tsconfig.local.json 生成"
    info "安装 pi（npm install -g @earendil-works/pi-coding-agent）后重跑 rebuild 即可补齐"
    return 0
  fi

  local out="$PI_HOME/agent/extensions/tsconfig.local.json"
  ROOT="$root" python3 - "$out" <<'PY2D' && ok "tsconfig.local.json 已生成（paths → $root）"
import json, sys, os
out = sys.argv[1]
root = os.environ['ROOT']
paths = {
    "@earendil-works/pi-coding-agent": [root + "/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
    "@earendil-works/pi-agent-core": [root + "/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"],
    "@earendil-works/pi-ai": [root + "/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
    "@earendil-works/pi-tui": [root + "/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
    "typebox": [root + "/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.d.mts"],
}
d = {"extends": "./tsconfig.json", "compilerOptions": {"baseUrl": ".", "paths": paths}}
json.dump(d, open(out, "w"), indent=2, ensure_ascii=False)
open(out, "a").write("\n")
PY2D

  return 0
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

# ---- Phase 2-F2: tmux 配置同步（仓库 deploy/tmux/tmux.conf → ~/.tmux.conf） ----
# git 同步边界只覆盖 ~/.pi/，~/.tmux.conf 在主目录需手动安装（README「git 模式边界」表）。
# 本阶段自动补上：diff 幂等 → cp 同步 → server 运行中时 source-file 热加载（不 kill-server，
# 避免杀掉用户 tmux 会话；extended-keys/状态栏立即生效，status-loop flock 幂等重复 source 安全）。
phase2_tmux() {
  title "Phase 2-F2" "tmux 配置同步"
  local src="$PI_HOME/deploy/tmux/tmux.conf"
  local dst="$HOME/.tmux.conf"
  if [ ! -f "$src" ]; then
    warn "仓库 deploy/tmux/tmux.conf 缺失，跳过"
    return 0
  fi
  if [ -f "$dst" ] && diff -q "$src" "$dst" >/dev/null 2>&1; then
    ok "~/.tmux.conf 与仓库一致"
    return 0
  fi
  # 覆盖前备份旧配置（时间戳后缀，幂等；dst 不存在时静默跳过）
  cp "$dst" "$dst.bak.$(date +%s)" 2>/dev/null || true
  cp "$src" "$dst" && ok "~/.tmux.conf 已同步（仓库版本，旧配置已备份）" || { warn "cp 失败"; return 1; }
  # 热加载：仅当 tmux server 在运行时 source-file（list-sessions 无 server 不会拉起新 server）
  if command -v tmux >/dev/null 2>&1 && tmux ls >/dev/null 2>&1; then
    if tmux source-file "$dst" >/dev/null 2>&1; then
      ok "tmux 配置已热加载（source-file，server 未重启，会话保留）"
    else
      warn "tmux source-file 失败（配置语法错误？手动: tmux source-file ~/.tmux.conf）"
    fi
  else
    info "tmux server 未运行，配置将在下次启动时自动读取"
  fi
}

# ---- Phase 2-F3: pi-link 互连公钥安装（deploy/keys/authorized_keys → 本机 authorized_keys） ----
# 多设备免密互连：仓库 deploy/keys/authorized_keys 收集所有设备公钥（git 同步），
# 每台设备重建时自动安装；pi-link-keys.sh install 幂等（Termux 双位置）。
phase2_link_keys() {
  title "Phase 2-F3" "pi-link 互连公钥安装"
  if [ ! -f "$PI_HOME/scripts/pi-link-keys.sh" ] || [ ! -f "$PI_HOME/deploy/keys/authorized_keys" ]; then
    warn "pi-link-keys.sh 或 deploy/keys/authorized_keys 缺失，跳过"
    return 0
  fi
  bash "$PI_HOME/scripts/pi-link-keys.sh" install >/dev/null 2>&1 \
    && ok "互连公钥已安装（仓库 deploy/keys/authorized_keys → 本机 authorized_keys）" \
    || warn "pi-link 公钥安装失败（手动: bash $PI_HOME/scripts/pi-link-keys.sh install）"
}

# ---- Phase 2-G: systemd 服务注册（SearXNG + whisper 常驻自启） ----
# 仅真实 systemd 环境生效（Termux/proot/容器内无 systemctl 时自动跳过）。
# unit 模板在 $PI_HOME/deploy/systemd/ 目录
# 只 enable（开机自启）+ 未运行时 start；旧手动进程占用端口时先停掉再拉起。
phase2_systemd() {
  title "Phase 2-G" "systemd 服务注册（SearXNG + whisper 自启）"
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    info "无 systemd（Termux/proot/容器），跳过常驻服务自启"
    return 0
  fi
  local sd_dir="$PI_HOME/deploy/systemd" sys_dir="/etc/systemd/system" installed=0
  for unit in pi-searxng.service pi-whisper.service; do
    if [ ! -f "$sd_dir/$unit" ]; then
      warn "模板缺失: $sd_dir/$unit，跳过"
      continue
    fi
    sed "s|%PI_HOME%|$PI_HOME|g" "$sd_dir/$unit" > "$sys_dir/$unit"
    chmod 644 "$sys_dir/$unit"
    ok "已安装 $unit"
    installed=1
  done
  [ "$installed" = "1" ] || return 0
  systemctl daemon-reload
  # 停旧手动进程（start.sh/pi-whisper.sh 的 nohup 实例），避免端口冲突
  local searx_pid="$PI_HOME/searxng/searxng.pid"
  if [ -f "$searx_pid" ] && kill -0 "$(cat "$searx_pid")" 2>/dev/null; then
    kill "$(cat "$searx_pid")" 2>/dev/null && warn "已停止手动 SearXNG 进程（由 systemd 接管）"
  fi
  if [ -f "$PI_HOME/logs/whisper/server.pid" ] && kill -0 "$(cat "$PI_HOME/logs/whisper/server.pid")" 2>/dev/null; then
    "$PI_HOME/scripts/pi-whisper.sh" stop >/dev/null 2>&1 && warn "已停止手动 whisper 进程（由 systemd 接管）"
  fi
  local rc=0
  systemctl enable pi-searxng.service >/dev/null 2>&1 || rc=1
  systemctl enable pi-whisper.service >/dev/null 2>&1 || rc=1
  systemctl start pi-searxng.service >/dev/null 2>&1 || { warn "pi-searxng 启动失败（journalctl -u pi-searxng 查看）"; rc=1; }
  systemctl start pi-whisper.service >/dev/null 2>&1 || { warn "pi-whisper 启动失败（journalctl -u pi-whisper 查看）"; rc=1; }
  if [ "$rc" = "0" ]; then
    ok "SearXNG + whisper 已注册 systemd 自启（journalctl -u pi-searxng / -u pi-whisper 查看日志）"
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

  # 无配置时生成最小配置（不写 whisperDevice：服务端 auto 探测——缺 CUDA 库自动 CPU，
  # 后续安装 nvidia-cublas/cudnn 后重启服务自动 GPU，零配置切换）
  if [ ! -f "$voice_cfg" ]; then
    cat > "$voice_cfg" <<EOF
{
  "language": "zh",
  "whisperModel": "$WHISPER_MODEL",
  "whisperEndpoint": "http://127.0.0.1:18766"
}
EOF
    ok "已生成最小 pi-voice.json（whisperDevice 未写死，服务端 auto：缺 CUDA 库→CPU，装库重启后自动 GPU）"
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

  # git 卫生（D2）：敏感文件不得被意外追踪（与 pi-backup verify 对齐——审计 LOW：
  # 此前只查 4 个，漏 pi-voice.json/trust.json/searxng settings.yml/pi-link.json）
  if [ -d "$PI_HOME/.git" ]; then
    if git -C "$PI_HOME" ls-files agent/auth.json agent/settings.json agent/models.json agent/models-store.json agent/pi-voice.json agent/trust.json searxng/settings.yml pi-link.json 2>/dev/null | grep -q .; then
      warn "敏感文件被 git 追踪（auth/settings/models/pi-voice/trust/searxng.yml/pi-link.json）——运行 git rm --cached 排除"; errors=$((errors+1))
    else
      ok "git 卫生：敏感文件未被追踪"
    fi
  fi

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
    # 检测 Chromium 是否已安装且共享库齐备（chrome_ready：Installed 字段 + 文件存在 + ldd，无假阳性）
    if command -v npx &>/dev/null; then
      chrome_ready "$PI_HOME/agent/extensions/pi-browser"
      local crc=$?
      if [ "$crc" = "0" ]; then
        ok "Chromium 已安装且共享库齐备（$CHROME_BIN_PATH）"
      elif [ "$crc" = "2" ]; then
        warn "Chromium 已安装但缺共享库（启动将失败）"
        info "修复: apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libcups2t64 libgbm1（旧发行版去掉 t64 后缀）"
      else
        warn "Chromium 未安装，浏览器功能不可用"
        info "运行: cd $PI_HOME/agent/extensions/pi-browser && NODE_TLS_REJECT_UNAUTHORIZED=0 npx cloakbrowser install 安装"
      fi
    else
      warn "npx 不可用，无法检测 Chromium"
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

  # SearXNG 服务可达性（smoke-test 第 1 项依赖）
  if [ -f "$PI_HOME/searxng/settings.yml" ] && [ -x "$PI_HOME/searxng/venv/bin/python" ]; then
    if curl -s --max-time 5 http://127.0.0.1:8889/ >/dev/null 2>&1; then
      ok "SearXNG 服务运行中 (127.0.0.1:8889)"
    elif [ -d /run/systemd/system ]; then
      warn "SearXNG 服务未运行——启动: systemctl start pi-searxng 或 $PI_HOME/searxng/start.sh"
    else
      # D1：无 systemd 环境（Termux/proot/容器）自动拉起，避免 rebuild 后服务不可用
      info "无 systemd，自动启动 SearXNG（start.sh，uvicorn 回退由其处理）..."
      if bash "$PI_HOME/searxng/start.sh" >/dev/null 2>&1 && sleep 3 \
         && curl -s --max-time 5 http://127.0.0.1:8889/ >/dev/null 2>&1; then
        ok "SearXNG 已自动启动 (127.0.0.1:8889)"
      else
        warn "SearXNG 自动启动失败——手动: $PI_HOME/searxng/start.sh"
      fi
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
# 审计 MEDIUM：preflight 才安装 curl——缺 curl 的机器上 detect 探测静默失败
# （baidu 不可达 → CHINA_MIRROR=0，本次全程直连；npm/pip/apt 未配镜像，失败后
# 靠下一次重跑才补上）。装好 curl 后重新探测一次（set_mirrors 幂等：缓存为空时
# 重新测速；真直连网络重探测仍为 0，无副作用）。
if command -v curl &>/dev/null && [ "$CHINA_MIRROR" = "0" ]; then
  detect_china_network
  set_mirrors
fi
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
phase2_tmux
phase2_link_keys
phase2_systemd
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
if [ -f "$PI_HOME/scripts/patch-tab-arg-completion.mjs" ]; then
  node "$PI_HOME/scripts/patch-tab-arg-completion.mjs" "$PI_DIST" >/dev/null 2>&1 \
    && ok "Tab 参数补全补丁（/voice 等子命令 Tab 可见）" \
    || warn "Tab 参数补全补丁未应用（pi-tui 版本可能已改动）：斜杠命令有空格时 Tab 仍走文件补全，子命令需手动删空格重打空格触发"
else
  warn "patch-tab-arg-completion.mjs 缺失，跳过"
fi
fi

# Termux 浏览器适配（仅 Termux；其他平台 cloakbrowser 官方预编译包直接可用）
# 1) playwright-core android→linux 平台补丁（pi-browser npm 重装后自动恢复）
# 2) 本地 Chromium 符号链接到 cloakbrowser 缓存路径（跳过平台检测与下载）
if [ "$IS_TERMUX" = "1" ]; then
  pwext="$PI_HOME/agent/extensions/pi-browser"
  if [ -d "$pwext/node_modules/cloakbrowser" ]; then
    if [ -f "$PI_HOME/scripts/patch-playwright-core.mjs" ]; then
      node "$PI_HOME/scripts/patch-playwright-core.mjs" "$pwext" >/dev/null 2>&1 \
        && ok "playwright-core android→linux 补丁（Termux 浏览器）" \
        || warn "playwright-core 补丁未应用（pi-browser 重装后需重跑 rebuild）"
    fi
    # 本地 Chromium 符号链接（CLOAKBROWSER_BINARY_PATH 优先；无则用缓存符号链接）
    if [ -z "${CLOAKBROWSER_BINARY_PATH:-}" ] && command -v chromium-browser >/dev/null 2>&1; then
      cb_ver="" cb_bin=""
      # 从 config.js 静态映射提取 linux-arm64 版本号（不 import：android 平台 getPlatformTag 会抛错）
      cb_ver=$(grep -oE '"linux-arm64"[[:space:]]*:[[:space:]]*"[^"]+"' "$pwext/node_modules/cloakbrowser/dist/config.js" | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
      cb_bin="$(command -v chromium-browser 2>/dev/null)"
      if [ -n "$cb_ver" ] && [ -n "$cb_bin" ]; then
        mkdir -p "$HOME/.cloakbrowser/chromium-$cb_ver"
        ln -sf "$cb_bin" "$HOME/.cloakbrowser/chromium-$cb_ver/chrome"
        ok "cloakbrowser → Termux Chromium 符号链接 (v$cb_ver)"
      else
        warn "未能建立 chromium 符号链接（version=$cb_ver bin=$cb_bin）"
      fi
    fi
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
