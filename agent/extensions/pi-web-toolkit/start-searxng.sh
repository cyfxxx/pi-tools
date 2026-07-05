#!/usr/bin/env bash
# 启动本地 SearXNG 服务
# 委托给 ~/.pi/searxng/start.sh
SEARXNG_DIR="$HOME/.pi/searxng"
if [ -f "$SEARXNG_DIR/start.sh" ]; then
  bash "$SEARXNG_DIR/start.sh"
else
  echo "错误: SearXNG 未部署在 $SEARXNG_DIR"
  echo "请先运行 install.sh 部署 SearXNG"
  exit 1
fi
