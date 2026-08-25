#!/usr/bin/env bash
# 修复 tmux "access not allowed"（Termux proot 陈旧 server / socket 残留）
# 症状: 所有 tmux 命令 stderr 报 access not allowed 但 exit 0（会话创建无效/注入假成功）
# 注意: 会结束当前 tmux server 及其全部会话（含正在运行的 pi）——请在退出 pi 后执行，
#       或执行时接受会话中断（脚本带 3s 倒计时可 Ctrl-C 取消）。
# 用法: bash scripts/tmux-fix.sh             # 执行修复
#       bash scripts/tmux-fix.sh --dry-run   # 仅预览将执行的命令
#       bash scripts/tmux-fix.sh --yes       # 跳过倒计时直接执行
set -uo pipefail

DRY=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes)     FORCE=1 ;;
  esac
done

run() { echo ">> $*"; [ "$DRY" = 1 ] || eval "$*"; }

echo "== 修复前 tmux 状态 =="
tmux ls 2>&1 | head -5
echo

# 检测是否在 tmux 会话内（自杀保护）
if [ -n "${TMUX:-}" ] && [ "$FORCE" != 1 ]; then
  echo "⚠ 当前 shell 在 tmux 会话内（TMUX=$TMUX）。执行将结束本 tmux server 及其全部会话（含运行中的 pi）。"
  [ "$DRY" = 1 ] && echo "(dry-run: 仅预览，不执行)" && exit 0
  echo "3 秒后继续（Ctrl-C 取消）..."; sleep 3
fi

echo "== 清理陈旧 server 与 socket 残留 =="
# 杀所有 tmux server（-x 精确匹配进程名 tmux；只 kill 连接，不 kill status-loop 等）
run "pkill -9 -x tmux 2>/dev/null; sleep 1"
# socket 目录：Termux 默认在 $TMPDIR(=Termux tmp)/tmux-<uid>，proot 映射到 /tmp/tmux-0。
# 收窄为本用户目录（对齐 pi-wrapper.sh），不再通配删所有用户的 tmux-*；
# 保留 /tmp/tmux-0（proot 内 uid=0 的映射位）
run "rm -rf /tmp/tmux-$(id -u) /tmp/tmux-0 2>/dev/null"
[ -n "$PREFIX" ] && run "rm -rf $PREFIX/tmp/tmux-$(id -u) 2>/dev/null"

echo
echo "== 重建 tmux =="
# 新建一个主会话作为新 server 起点（幂等；已在 tmux 外时创建）
run "tmux new-session -d -s main -c '$HOME' 2>/dev/null || true"
sleep 1
echo
echo "== 修复后验证 =="
if tmux ls >/dev/null 2>&1; then
  echo "✓ tmux 恢复可用："
  tmux ls
else
  echo "✗ 仍不可用——请检查是否有其他进程持有旧 socket（lsof /tmp/tmux-*），或尝试退出全部 tmux/parent proot 后重试"
fi
echo
echo "提示: 若之前 pi 会话被结束，请重新启动 pi（tmux attach -t main 或直接 pi）。"
echo "      之后 relay 可用 tmux 注入（改 agent/ntfy-relay.json 为 {\"injectMode\":\"tmux\"}）。"
