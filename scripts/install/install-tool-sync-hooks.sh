#!/bin/bash
# install-tool-sync-hooks.sh — 安装/刷新 tool-stats 同步 git hooks（幂等）
#
# 同步时机（配合 scripts/tool-stats-sync.mjs）：
#   - post-merge：git pull 合并后自动聚合跨设备工具使用统计（30 天窗口）
#   - push 侧无需 hook：pi-backup sync 的 `git add -A` 自动带上本机事件文件
#     （memory/stats/tool-use-<device>.jsonl 按设备分文件，Git 合并无冲突）
#
# 用法：bash scripts/install-tool-sync-hooks.sh [--quiet]
# 挂载：install-wrapper.sh --ensure（各环境 cron 自愈时自动部署）
set -u

PI_HOME="${PI_HOME:-$HOME/.pi}"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

HOOK_DIR="$PI_HOME/.git/hooks"
if [ ! -d "$HOOK_DIR" ]; then
  [ "$QUIET" -eq 1 ] || echo "[tool-sync-hooks] 跳过: $PI_HOME 不是 git 仓库（hook 未安装）"
  exit 0
fi

MARKER="pi tool-stats sync"

cat > "$HOOK_DIR/post-merge" <<HOOK
#!/bin/bash
# ${MARKER}: git pull 合并后自动聚合跨设备工具使用统计（30 天窗口；失败静默不阻塞 pull）
PI_HOME="\$(cd "\$(dirname "\$0")/../../.." && pwd)"
SCRIPT="\$PI_HOME/scripts/tool-stats-sync.mjs"
[ -f "\$SCRIPT" ] || exit 0
if command -v node >/dev/null 2>&1; then
  node "\$SCRIPT" >/dev/null 2>&1 &
fi
exit 0
HOOK
chmod +x "$HOOK_DIR/post-merge"

[ "$QUIET" -eq 1 ] || echo "[tool-sync-hooks] post-merge 已安装/刷新: $HOOK_DIR/post-merge"