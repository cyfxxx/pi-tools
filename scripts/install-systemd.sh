#!/bin/bash
# install-systemd.sh — 安装 pi-scheduler 的 systemd timer
set -u

PI_HOME="${PI_HOME:-$HOME/.pi}"
CRON_SCRIPT="$PI_HOME/scripts/pi-cron.sh"
SERVICE_NAME="pi-scheduler"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
TIMER_FILE="/etc/systemd/system/${SERVICE_NAME}.timer"

if [ ! -f "$CRON_SCRIPT" ]; then
  echo "错误: 未找到 $CRON_SCRIPT"
  exit 1
fi

chmod +x "$CRON_SCRIPT"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "⚠ systemctl 不可用，请使用 install-cron.sh 安装 crontab"
  exit 0
fi

# 创建 service unit
cat > "$SERVICE_FILE" << UNIT
[Unit]
Description=Pi Scheduler — 执行到期定时任务
After=network.target

[Service]
Type=oneshot
ExecStart=$CRON_SCRIPT
User=$(whoami)
Environment=PI_HOME=$PI_HOME
UNIT

# 创建 timer unit
cat > "$TIMER_FILE" << UNIT
[Unit]
Description=Pi Scheduler Timer — 每分钟触发

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
RandomizedDelaySec=5

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.timer"
systemctl start "${SERVICE_NAME}.timer"

echo "✓ systemd timer 已安装并启动:"
echo "  Service: $SERVICE_NAME"
echo "  Timer:   ${SERVICE_NAME}.timer"
echo ""
echo "查看状态: systemctl status ${SERVICE_NAME}.timer"
echo "查看日志: journalctl -u ${SERVICE_NAME}.service -n 50"
echo "停止:     systemctl stop ${SERVICE_NAME}.timer"
echo "禁用:     systemctl disable ${SERVICE_NAME}.timer"
