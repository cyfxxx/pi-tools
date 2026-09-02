#!/bin/bash
# pi-rescue.sh - Pi 手动救援脚本
# 用于手动修复主程序崩溃问题

set -e

PI_DIR="$HOME/.pi"
RESCUE_DIR="$PI_DIR/agent/rescue"
SNAPSHOT_DIR="$PI_DIR/.snapshots"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 显示菜单
show_menu() {
  echo -e "${GREEN}Pi 救援模式${NC}"
  echo "================================"
  echo "1. 查看崩溃日志"
  echo "2. 恢复配置文件"
  echo "3. 恢复到快照"
  echo "4. 重新安装依赖"
  echo "5. 重新运行 rebuild"
  echo "6. 启动救援模式 pi"
  echo "7. 退出"
  echo "================================"
}

# 查看崩溃日志
show_logs() {
  echo -e "${YELLOW}最近的日志文件:${NC}"
  ls -lt "$PI_DIR/logs/" 2>/dev/null | head -10
  
  echo ""
  echo -e "${YELLOW}最近的 wrapper 日志:${NC}"
  tail -50 "$PI_DIR/logs/warm-diag.jsonl" 2>/dev/null || echo "没有日志文件"
  
  echo ""
  echo -e "${YELLOW}崩溃计数:${NC}"
  cat "$PI_DIR/agent/.pi-autopilot-crash.json" 2>/dev/null || echo "没有崩溃记录"
}

# 恢复配置文件
restore_config() {
  echo -e "${YELLOW}选择恢复来源:${NC}"
  echo "1. 从快照恢复"
  echo "2. 恢复默认配置"
  echo "3. 取消"
  read -p "请选择 (1-3): " choice
  
  case $choice in
    1)
      echo -e "${YELLOW}可用快照:${NC}"
      list_snapshots
      read -p "输入快照路径: " snapshot_path
      if [ -d "$snapshot_path" ]; then
        cp "$snapshot_path/settings.json" "$PI_DIR/agent/settings.json" 2>/dev/null || true
        echo -e "${GREEN}配置已恢复${NC}"
      else
        echo -e "${RED}快照不存在${NC}"
      fi
      ;;
    2)
      cp "$RESCUE_DIR/rescue-config.json" "$PI_DIR/agent/settings.json"
      echo -e "${GREEN}已恢复默认配置${NC}"
      ;;
    3)
      return
      ;;
    *)
      echo -e "${RED}无效选择${NC}"
      ;;
  esac
}

# 恢复到快照
restore_snapshot() {
  echo -e "${YELLOW}可用快照:${NC}"
  list_snapshots
  read -p "输入快照路径: " snapshot_path
  if [ -d "$snapshot_path" ]; then
    cp "$snapshot_path/settings.json" "$PI_DIR/agent/settings.json" 2>/dev/null || true
    cp "$snapshot_path/modes.json" "$PI_DIR/agent/modes.json" 2>/dev/null || true
    echo -e "${GREEN}已恢复到快照: $snapshot_path${NC}"
  else
    echo -e "${RED}快照不存在${NC}"
  fi
}

# 重新安装依赖
reinstall_deps() {
  echo -e "${YELLOW}重新安装 npm 依赖...${NC}"
  cd "$PI_DIR/agent" && npm install
  echo -e "${GREEN}依赖安装完成${NC}"
}

# 重新运行 rebuild
run_rebuild() {
  echo -e "${YELLOW}重新运行 rebuild...${NC}"
  bash "$PI_DIR/scripts/rebuild.sh" --yes
  echo -e "${GREEN}rebuild 完成${NC}"
}

# 启动救援模式 pi
start_rescue_pi() {
  echo -e "${YELLOW}启动救援模式 pi...${NC}"
  cd "$PI_DIR"
  
  # 使用救援配置启动 pi
  node "$(cat "$PI_DIR/scripts/.pi-cli-path" 2>/dev/null || echo "$PI_DIR/agent/node_modules/.bin/pi")" \
    --no-extensions \
    --no-skills \
    --append-system-prompt "$RESCUE_DIR/rescue-prompt.md"
}

# 列出快照
list_snapshots() {
  if [ -d "$SNAPSHOT_DIR" ]; then
    ls -1d "$SNAPSHOT_DIR"/snapshot_* 2>/dev/null || echo "没有快照"
  else
    echo "没有快照目录"
  fi
}

# 主循环
while true; do
  show_menu
  read -p "请选择 (1-7): " choice
  
  case $choice in
    1)
      show_logs
      ;;
    2)
      restore_config
      ;;
    3)
      restore_snapshot
      ;;
    4)
      reinstall_deps
      ;;
    5)
      run_rebuild
      ;;
    6)
      start_rescue_pi
      ;;
    7)
      echo -e "${GREEN}退出救援模式${NC}"
      exit 0
      ;;
    *)
      echo -e "${RED}无效选择${NC}"
      ;;
  esac
  
  echo ""
  read -p "按 Enter 继续..."
  clear
done
