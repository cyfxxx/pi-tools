#!/bin/bash
# pi-orig.sh - 绕过 wrapper 直接启动 Pi CLI（无自动重启管理）
# 在 wrapper 出现故障时作为逃生通道使用
PI_JS="/root/.local/share/pi-node/node-v22.23.1-linux-arm64/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
exec node "$PI_JS" "$@"
