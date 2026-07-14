#!/bin/bash
# install-cron.sh — 安装 pi-scheduler 的 crontab 条目
set -u

PI_HOME="${PI_HOME:-$HOME/.pi}"
CRON_SCRIPT="$PI_HOME/scripts/pi-cron.sh"

if [ ! -f "$CRON_SCRIPT" ]; then
  echo "错误: 未找到 $CRON_SCRIPT"
  exit 1
fi

chmod +x "$CRON_SCRIPT"

# crontab 条目：每分钟执行
CRON_LINE="* * * * * $CRON_SCRIPT"

# 检查 crontab 是否可用
if ! command -v crontab >/dev/null 2>&1; then
  echo "⚠ crontab 命令不可用，请手动添加 crontab 条目:"
  echo "  echo '$CRON_LINE' | crontab -"
  exit 0
fi

# 检查是否已存在相同条目
EXISTING=$(crontab -l 2>/dev/null || true)
if echo "$EXISTING" | grep -Fq "$CRON_SCRIPT"; then
  echo "✓ crontab 条目已存在: $CRON_SCRIPT"
  exit 0
fi

# 追加条目
(
  echo "$EXISTING"
  echo "# pi-scheduler: 每分钟检查到期任务"
  echo "$CRON_LINE"
) | crontab -

echo "✓ crontab 已安装:"
echo "  $CRON_LINE"
echo ""
echo "如需移除: crontab -l | grep -v '$CRON_SCRIPT' | crontab -"
