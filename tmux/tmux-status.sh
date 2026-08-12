#!/usr/bin/env bash
# tmux-status.sh — 生成 tmux 状态栏右侧内容（写入 /tmp/tmux-status.txt）
# 由 status-loop.sh 每 3 秒调用；状态栏用 #(cat /tmp/tmux-status.txt) 读取。
# 内容: 北京时间 | 1分钟负载（按核数阈值着色）| 内存 used/total (pct，按使用率着色）
# 颜色: 输出 tmux 格式指令 #[fg=...]（#() 输出会被渲染解析；ANSI ESC 会被剥离，不可用）
# 说明: tmux 3.4 的 #() 有极短执行超时，慢命令/脚本直接执行会超时被杀，
#       故采用"文件+cat"模式而非 #(script) 直出。
set -u

OUT=/tmp/tmux-status.txt

cores=$(nproc)
read -r load1 _ < /proc/loadavg

# /proc/meminfo 单位 kB: MemTotal(1行) MemAvailable(3行)
read -r _ total _ < <(sed -n 1p /proc/meminfo)
read -r _ avail _ < <(sed -n 3p /proc/meminfo)
used=$((total - avail))

# 负载阈值: <0.7×核 正常, >=0.7×核 黄, >=1×核 红
load_color=""
awk -v l="$load1" -v c="$cores" 'BEGIN{ if (l+0 >= c) exit 2; if (l+0 >= c*0.7) exit 1; exit 0 }' 2>/dev/null
case $? in
  1) load_color='#[fg=yellow]' ;;   # 黄
  2) load_color='#[fg=red]' ;;      # 红
esac

# 内存阈值: <75% 正常, >=75% 黄, >=90% 红（注意顺序：先 90 后 75 会被覆盖）
mem_color=""
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

printf '#[fg=yellow]%s#[default] %s%.2f#[default] %s%s/%s (%d%%)#[default]\n' \
  "$(TZ=Asia/Shanghai date +%H:%M)" \
  "$load_color" "$load1" \
  "$mem_color" "$used_h" "$total_h" "$pct" > "$OUT"
