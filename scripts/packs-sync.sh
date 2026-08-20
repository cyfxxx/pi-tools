#!/usr/bin/env bash
# 第三方技能包同步：从 GitHub 原项目拉取 packs/<名>（本仓库不托管第三方内容）
# 供其他设备在 clone 本仓库后重建环境时复用；packs/ 不入 git。
# 用法:
#   bash scripts/packs-sync.sh            # 同步清单内全部包
#   bash scripts/packs-sync.sh reverse-skill  # 仅同步指定包
set -euo pipefail

PACKS_DIR="$(cd "$(dirname "$0")/.." && pwd)/packs"
mkdir -p "$PACKS_DIR"

# 包清单: <目录名>|<git URL>
PACKS=(
  "reverse-skill|https://github.com/zhaoxuya520/reverse-skill.git"
)

target="${1:-}"

for entry in "${PACKS[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"
  if [ -n "$target" ] && [ "$target" != "$name" ]; then
    continue
  fi
  if [ -d "$PACKS_DIR/$name/.git" ]; then
    echo "[packs] 更新 $name ..."
    git -C "$PACKS_DIR/$name" fetch -q && git -C "$PACKS_DIR/$name" pull -q || echo "[packs] $name 更新失败（网络或本地改动）"
  else
    echo "[packs] 首次拉取 $name ..."
    git clone --depth 1 "$url" "$PACKS_DIR/$name" || echo "[packs] $name 拉取失败"
  fi
done
echo "[packs] 完成。仅供按需读取，不注册进 pi 技能面。"
