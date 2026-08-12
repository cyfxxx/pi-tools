#!/usr/bin/env bash
# tmux-status.sh — tmux 状态栏右侧渲染（单次调用输出整段，减少 fork）
# 输出: 北京时间 | 1分钟负载（按核数阈值着色）| 内存 used/total (pct，按使用率着色）
# 颜色: ANSI SGR（tmux 状态栏 #() 输出直接渲染）；正常不设色，异常才显色
set -u

cores=$(nproc)
read -r load1 _ < /proc/loadavg

# free -b: Mem: total used free shared buff/cache available
read -r _ total used _ _ _ _ < <(free -b | awk 'NR==2')
pct=$((used * 100 / total))

# 负载阈值: <0.7×核 正常, >=0.7×核 黄, >=1×核 红
load_color=""
awk -v l="$load1" -v c="$cores" 'BEGIN{ if (l+0 >= c) exit 2; if (l+0 >= c*0.7) exit 1; exit 0 }' 2>/dev/null
case $? in
  1) load_color=$'\e[33m' ;;   # 黄
  2) load_color=$'\e[31m' ;;   # 红
esac

# 内存阈值: <75% 正常, >=75% 黄, >=90% 红（注意顺序：先 90 后 75 会被覆盖）
mem_color=""
if [ "$pct" -ge 90 ]; then
  mem_color=$'\e[31m'
elif [ "$pct" -ge 75 ]; then
  mem_color=$'\e[33m'
fi

human() { awk -v n="$1" 'BEGIN{
  if (n >= 1073741824) printf "%.1fG", n/1073741824
  else if (n >= 1048576) printf "%.0fM", n/1048576
  else printf "%.0fK", n/1024 }'; }
used_h=$(human "$used"); total_h=$(human "$total")

printf '\e[33m%s\e[0m %s%.2f\e[0m %s%s/%s (%d%%)\e[0m\n' \
  "$(TZ=Asia/Shanghai date +%H:%M)" \
  "$load_color" "$load1" \
  "$mem_color" "$used_h" "$total_h" "$pct"
