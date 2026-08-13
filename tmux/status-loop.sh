#!/usr/bin/env bash
# status-loop.sh — tmux 状态栏数据循环刷新（flock 幂等，可安全重复启动）
# 每 3 秒生成状态内容并 set-option 写入 status-right（不依赖 tmux #() 替换，
# Termux tmux 3.7b 的 #() 不执行；run-shell/set-option 正常）。
# 启动: tmux.conf 中 run-shell '~/.pi/tmux/status-loop.sh >/dev/null 2>&1 &'
# 停止: pkill -f status-loop.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# flock 幂等：已有循环持有锁则退出（避免 pgrep 误匹配）；锁放仓库目录（无 /tmp 环境兼容）
exec 9>"$SCRIPT_DIR/status-loop.lock"
flock -n 9 || exit 0

# 在 tmux 会话内（TMUX 环境变量存在）才 set-option；会话外手动跑只生成文件
update() {
  local line
  line=$(bash "$SCRIPT_DIR/tmux-status.sh")
  if [ -n "${TMUX:-}" ]; then
    tmux set-option -g status-right "$line" >/dev/null 2>&1 || true
  fi
}

update   # 立即刷新一次
while true; do
  sleep 3
  update
done
