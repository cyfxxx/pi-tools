#!/bin/bash
# install-wrapper.sh - 安装 pi-wrapper.sh 作为 pi 命令的替代
#
# 将原 pi 命令备份为 pi-original（symlink），创建 wrapper 接管 pi 命令
# 卸载: sudo mv $(dirname $(which pi))/pi-original $(which pi)
#
# 模式:
#   默认       交互式安装（有确认提示）
#   --ensure   幂等自愈：已正确安装则静默退出；否则自动重装（无交互）
#   --quiet    抑制非错误输出（可与 --ensure 联用）
#
# 注意:一台机器可能存在多个 pi 安装（Termux 前缀 + node 安装目录），
# pi update（npm 全局安装）只会覆盖其托管的那一个入口。
# --ensure 会遍历所有候选入口逐一自愈。

set -e

ENSURE=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --ensure) ENSURE=1 ;;
    --quiet) QUIET=1 ;;
  esac
done

log() {
  if [ "$QUIET" -ne 1 ]; then
    echo "$@"
  fi
}

WRAPPER_SCRIPT="$HOME/.pi/scripts/pi-wrapper.sh"
if [ ! -f "$WRAPPER_SCRIPT" ]; then
  echo "错误: 未找到 $WRAPPER_SCRIPT" >&2
  exit 1
fi
WRAPPER_MARKER="由 install-wrapper.sh 安装"

# ── 枚举所有可能的 pi 入口（去重、保持存在性）──
list_pi_bins() {
  {
    command -v pi 2>/dev/null || true
    ls "$HOME/.local/share/pi-node"/*/bin/pi 2>/dev/null || true
    ls "$HOME/.nvm/versions/node"/*/bin/pi 2>/dev/null || true
    echo /usr/local/bin/pi
    echo /usr/bin/pi
    [ -d /data/data/com.termux ] && echo /data/data/com.termux/files/usr/bin/pi
  } | while read -r p; do
    [ -n "$p" ] || continue
    if [ -L "$p" ] || [ -f "$p" ]; then
      # 关键: 输出原始路径（保留 symlink 本身），
      # 用 readlink -f 解析后的真实路径做去重 key。
      # 若直接输出解析结果，install_one 拿到的将是真实文件（如 dist/cli.js），
      # readlink 备份会失败报"不是 symlink，无法备份"。
      echo "$p|$(readlink -f "$p" 2>/dev/null || echo "$p")"
    fi
  done | sort -u -t'|' -k2 | cut -d'|' -f1
}

# ── 判断指定 pi 是否已是我们的 wrapper（幂等检测）──
is_wrapper_installed() {
  local bin="$1"
  [ -L "$bin" ] && return 1
  [ ! -f "$bin" ] && return 1
  head -c 300 "$bin" 2>/dev/null | grep -q "$WRAPPER_MARKER"
}

# ── 自愈/安装单个入口 ──
install_one() {
  local PI_BIN="$1"
  local PI_DIR="$(dirname "$PI_BIN")"
  local PI_ORIGINAL="$PI_DIR/pi-original"

  # 备份原 pi 命令
  # 关键: 先备份（读取 symlink 目标），再删除原 symlink，最后创建 wrapper
  if [ ! -L "$PI_ORIGINAL" ] && [ ! -f "$PI_ORIGINAL" ]; then
    local ORIG_TARGET="$(readlink "$PI_BIN" 2>/dev/null || echo "")"
    if [ -n "$ORIG_TARGET" ]; then
      log "备份原 pi 命令到 $PI_ORIGINAL (symlink)..."
      ln -s "$ORIG_TARGET" "$PI_ORIGINAL"
    else
      echo "错误: $PI_BIN 不是 symlink，无法备份（可能已被覆盖）" >&2
      exit 1
    fi
  fi

  # 原子安装 wrapper（tmp + mv，避免并发/中断产生半写文件）
  log "安装 wrapper 到 $PI_BIN..."
  local TMP_SHIM="$PI_BIN.tmp.$$"
  cat > "$TMP_SHIM" << WRAPPER
#!/bin/bash
# pi wrapper - $WRAPPER_MARKER
# 原命令已备份到同目录的 pi-original
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
WRAPPER_SCRIPT="\$HOME/.pi/scripts/pi-wrapper.sh"

if [ -f "\$WRAPPER_SCRIPT" ]; then
  exec "\$WRAPPER_SCRIPT" "\$@"
else
  exec "\${SCRIPT_DIR}/pi-original" "\$@"
fi
WRAPPER

  chmod +x "$TMP_SHIM"
  mv -f "$TMP_SHIM" "$PI_BIN"
  log "  安装完成: $PI_BIN"
}

# ── 主流程 ──
FOUND=0
for PI_BIN in $(list_pi_bins); do
  if is_wrapper_installed "$PI_BIN"; then
    continue
  fi
  FOUND=1
  if [ "$ENSURE" -eq 1 ]; then
    install_one "$PI_BIN"
  else
    log "检测到未托管的 pi 命令: $PI_BIN"
    log "  $(ls -la "$PI_BIN")"
    read -p "安装 wrapper 到 $PI_BIN？(y/N): " CONFIRM
    if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
      install_one "$PI_BIN"
    else
      echo "已取消"
    fi
  fi
done

if [ "$FOUND" -eq 0 ]; then
  if [ "$ENSURE" -eq 1 ]; then
    exit 0
  fi
  echo "所有 pi 入口均已安装 wrapper。当前:"
  for PI_BIN in $(list_pi_bins); do
    ls -la "$PI_BIN"
  done
  echo ""
  echo "卸载: sudo rm <pi> && sudo mv <pi-original> <pi>"
fi