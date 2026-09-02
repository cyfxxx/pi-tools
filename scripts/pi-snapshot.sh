#!/bin/bash
# pi-snapshot.sh - Pi 状态快照脚本
# 在 pi 启动前自动保存当前状态，崩溃时可以恢复

set -e

PI_DIR="$HOME/.pi"
SNAPSHOT_DIR="$PI_DIR/.snapshots"
MAX_SNAPSHOTS=10

# 创建快照目录
mkdir -p "$SNAPSHOT_DIR"

# 获取当前时间戳
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# 创建快照
create_snapshot() {
  local snapshot_name="snapshot_${TIMESTAMP}"
  local snapshot_path="$SNAPSHOT_DIR/$snapshot_name"
  
  mkdir -p "$snapshot_path"
  
  # 保存关键配置文件
  cp "$PI_DIR/agent/settings.json" "$snapshot_path/" 2>/dev/null || true
  cp "$PI_DIR/agent/modes.json" "$snapshot_path/" 2>/dev/null || true
  
  # 保存扩展列表
  ls "$PI_DIR/agent/extensions/" > "$snapshot_path/extensions.list" 2>/dev/null || true
  
  # 保存 git 状态
  cd "$PI_DIR"
  git rev-parse HEAD > "$snapshot_path/git-commit" 2>/dev/null || true
  git status --porcelain > "$snapshot_path/git-status" 2>/dev/null || true
  
  echo "$snapshot_path"
}

# 清理旧快照
cleanup_snapshots() {
  local count=$(ls -1d "$SNAPSHOT_DIR"/snapshot_* 2>/dev/null | wc -l)
  if [ "$count" -gt "$MAX_SNAPSHOTS" ]; then
    ls -1d "$SNAPSHOT_DIR"/snapshot_* | head -n $((count - MAX_SNAPSHOTS)) | xargs rm -rf
  fi
}

# 恢复快照
restore_snapshot() {
  local snapshot_path="$1"
  
  if [ ! -d "$snapshot_path" ]; then
    echo "错误: 快照不存在: $snapshot_path"
    return 1
  fi
  
  # 恢复配置文件
  cp "$snapshot_path/settings.json" "$PI_DIR/agent/settings.json" 2>/dev/null || true
  cp "$snapshot_path/modes.json" "$PI_DIR/agent/modes.json" 2>/dev/null || true
  
  echo "已恢复快照: $snapshot_path"
}

# 列出所有快照
list_snapshots() {
  ls -1d "$SNAPSHOT_DIR"/snapshot_* 2>/dev/null || echo "没有快照"
}

# 主函数
case "${1:-create}" in
  create)
    create_snapshot
    cleanup_snapshots
    ;;
  restore)
    restore_snapshot "$2"
    ;;
  list)
    list_snapshots
    ;;
  *)
    echo "用法: $0 {create|restore <path>|list}"
    exit 1
    ;;
esac
