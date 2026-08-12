#!/bin/bash
# pi-orig.sh - 绕过 wrapper 直接启动 Pi CLI（无自动重启管理）
# 在 wrapper 出现故障时作为逃生通道使用
# 优先通过 pi-original 符号链接解析（install-wrapper.sh 安装），
# 兜底本机 pi-node 安装目录（动态探测，避免跨机硬编码路径失效）
PI_JS=""
if command -v pi-original >/dev/null 2>&1; then
  PI_JS="$(readlink -f "$(command -v pi-original)")"
fi
if [ -z "$PI_JS" ] || [ ! -f "$PI_JS" ]; then
  for d in "$HOME/.local/share/pi-node"/*/; do
    cand="$d/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
    if [ -f "$cand" ]; then PI_JS="$cand"; break; fi
  done
fi
if [ -z "$PI_JS" ] || [ ! -f "$PI_JS" ]; then
  echo "pi-orig.sh: 未找到 pi cli.js（pi-original 缺失且 pi-node 目录无 pi-coding-agent）" >&2
  exit 1
fi
# 与 pi-wrapper.sh 一致的 PI_DIST 导出：直启时 pi-voice 等扩展的 dist 探测
# （which pi + readlink -f）会解析到 wrapper/脚本自身导致加载期报错，需显式提供
export PI_DIST="$(dirname "$PI_JS")"
exec node "$PI_JS" "$@"
