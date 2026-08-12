#!/usr/bin/env bash
# status-loop.sh — tmux 状态栏数据循环刷新（flock 幂等，可安全重复启动）
# 每 3 秒调用 tmux-status.sh 生成 /tmp/tmux-status.txt，
# 状态栏 #(cat /tmp/tmux-status.txt) 读取。
# 启动: tmux.conf 中 run-shell '~/.pi/tmux/status-loop.sh >/dev/null 2>&1 &'
# 停止: pkill -f status-loop.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# flock 幂等：已有循环持有锁则退出（避免 pgrep 误匹配）
exec 9>/tmp/tmux-status.lock
flock -n 9 || exit 0

bash "$SCRIPT_DIR/tmux-status.sh"   # 立即生成一次
while true; do
  sleep 3
  bash "$SCRIPT_DIR/tmux-status.sh"
done
