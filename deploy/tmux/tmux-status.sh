#!/usr/bin/env bash
# tmux-status.sh — 生成 tmux 状态栏右侧内容
# 输出: stdout 一行（状态循环 set-option 用）同时写入 ~/.pi/deploy/tmux/tmux-status.txt（调试/兼容）。
# 内容: 北京时间 | 1分钟负载（按核数阈值着色）| 内存 used/total (pct，按使用率着色）
# 颜色: tmux 格式指令 #[fg=...]（渲染时解析）
# 注意: 不用 tmux #() 命令替换——Termux 的 tmux 3.7b 中 #() 不执行（实测为空），
#       故状态循环用 set-option 直接写入 status-right。
# 容错: /proc/loadavg 在 Termux(SELinux) 不可读时负载显示 '--'；meminfo 同理。
set -u

OUT="$(cd "$(dirname "$0")" && pwd)/tmux-status.txt"

load1="--"
if [ -r /proc/loadavg ]; then
  read -r load1 _ < /proc/loadavg
fi
cores=$(nproc 2>/dev/null || echo 1)

load_color=""
if [ "$load1" != "--" ]; then
  awk -v l="$load1" -v c="$cores" 'BEGIN{ if (l+0 >= c) exit 2; if (l+0 >= c*0.7) exit 1; exit 0 }' 2>/dev/null
  case $? in
    1) load_color='#[fg=yellow]' ;;   # 黄
    2) load_color='#[fg=red]' ;;      # 红
  esac
fi

used_h="--"; total_h="--"; pct="--"; mem_color=""
if [ -r /proc/meminfo ]; then
  read -r _ total _ < <(sed -n 1p /proc/meminfo)
  read -r _ avail _ < <(sed -n 3p /proc/meminfo)
  used=$((total - avail))

  pct=$((used * 100 / total))
  if [ "$pct" -ge 90 ]; then
    mem_color='#[fg=red]'
  elif [ "$pct" -ge 75 ]; then
    mem_color='#[fg=yellow]'
  fi

  human() { awk -v n="$1" 'BEGIN{
    if (n >= 1073741824) printf "%.1fG", n/1073741824
    else if (n >= 1048576) printf "%.0fM", n/1048576
    else printf "%.0fK", n/1024 }'; }
  used_h=$(human "$((used * 1024))"); total_h=$(human "$((total * 1024))")
fi

line=$(printf '#[fg=yellow]%s#[default] %s%s#[default] %s%s/%s (%s%%)#[default]' \
  "$(TZ=Asia/Shanghai date +%H:%M 2>/dev/null || date +%H:%M)" \
  "$load_color" "$load1" \
  "$mem_color" "$used_h" "$total_h" "$pct")
printf '%s\n' "$line"
printf '%s\n' "$line" > "$OUT" 2>/dev/null || true
