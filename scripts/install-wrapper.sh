#!/bin/bash
# install-wrapper.sh - 安装 pi-wrapper.sh 作为 pi 命令的替代
#
# 将原 pi 命令备份为 pi-original（symlink），创建 wrapper 接管 pi 命令
# 卸载: sudo mv $(dirname $(which pi))/pi-original $(which pi)

set -e

PI_BIN="$(which pi 2>/dev/null || true)"
PI_DIR="$(dirname "$PI_BIN")"
PI_ORIGINAL="$PI_DIR/pi-original"
WRAPPER_SCRIPT="$HOME/.pi/scripts/pi-wrapper.sh"

if [ -z "$PI_BIN" ]; then
  echo "错误: 未找到 pi 命令" >&2
  exit 1
fi

if [ ! -f "$WRAPPER_SCRIPT" ]; then
  echo "错误: 未找到 $WRAPPER_SCRIPT" >&2
  exit 1
fi

# 检测是否已安装
if [ -f "$PI_BIN" ] && head -1 "$PI_BIN" 2>/dev/null | grep -q "pi wrapper"; then
  echo "检测到已安装的 wrapper，当前 pi 命令:"
  ls -la "$PI_BIN"
  read -p "重新安装？(y/N): " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "已取消"
    exit 0
  fi
fi

# 备份原 pi 命令
# 关键: 先备份（读取 symlink 目标），再删除原 symlink，最后创建 wrapper
if [ ! -L "$PI_ORIGINAL" ] && [ ! -f "$PI_ORIGINAL" ]; then
  ORIG_TARGET="$(readlink "$PI_BIN" 2>/dev/null || echo "")"
  if [ -n "$ORIG_TARGET" ]; then
    echo "备份原 pi 命令到 $PI_ORIGINAL (symlink)..."
    ln -s "$ORIG_TARGET" "$PI_ORIGINAL"
  else
    echo "错误: $PI_BIN 不是 symlink，不会备份（可能是已安装的 wrapper）" >&2
    exit 1
  fi
fi

# 删除原 symlink，创建 wrapper 脚本（注意: cat > symlink 会覆盖目标文件！）
echo "安装 wrapper 到 $PI_BIN..."
rm -f "$PI_BIN"
cat > "$PI_BIN" << 'WRAPPER'
#!/bin/bash
# pi wrapper - 由 install-wrapper.sh 安装
# 原命令已备份到同目录的 pi-original
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_SCRIPT="$HOME/.pi/scripts/pi-wrapper.sh"

if [ -f "$WRAPPER_SCRIPT" ]; then
  exec "$WRAPPER_SCRIPT" "$@"
else
  exec "${SCRIPT_DIR}/pi-original" "$@"
fi
WRAPPER

chmod +x "$PI_BIN"

echo "安装完成!"
echo "  原命令: $PI_ORIGINAL (symlink)"
echo "  当前:   $PI_BIN (bash wrapper) -> $WRAPPER_SCRIPT"
echo ""
echo "卸载: sudo rm $PI_BIN && sudo mv $PI_ORIGINAL $PI_BIN"
