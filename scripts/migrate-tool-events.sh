#!/bin/bash
# 一次性迁移：tool-use-<device>.jsonl 移出 git 跟踪（2026-08-27 起原始事件不再入库，
# 跨设备同步改用每日聚合计数 tool-count-<device>.json，见 scripts/tool-stats-sync.mjs --daily）
#
# 其他设备首个 pull 前执行本脚本，避免 "Your local changes ... would be overwritten"
# delete/modify 冲突：解除本地跟踪（工作区 jsonl 保留，历史数据不丢），随后 git pull 干净合并。
#
# 用法: bash scripts/migrate-tool-events.sh   （在 ~/.pi 仓库根执行；幂等）

set -u
cd "$(dirname "$0")/.." || exit 1

if git rm --cached memory/stats/tool-use-*.jsonl >/dev/null 2>&1; then
  echo "[migrate] 已解除 tool-use-*.jsonl 跟踪（工作区文件保留）"
else
  echo "[migrate] 已是最新状态（无跟踪的 jsonl），无需操作"
fi
exit 0