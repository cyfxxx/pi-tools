#!/usr/bin/env bash
# pi-link 目标侧入口（sshd forced command 用）
#
# 用法：目标设备 ~/.ssh/authorized_keys 的远程条目写：
#   command="~/.pi/scripts/pi-link-entry.sh",restrict <公钥>
# 作用：把设备 A 的 ssh 通道**限制为只能启动 pi RPC 会话**，
# 即使 A 侧被攻破也无法执行其他命令。
#
# 安全模型：
#   - 远程命令固定为 pi --mode rpc --no-extensions（不可由 A 改变参数）
#   - 工作目录固定为远程用户 home；会话目录固定 ~/.pi/agent/sessions/pi-link
#   - 不读取 $SSH_ORIGINAL_COMMAND（A 传的任何命令均被忽略）

set -u

# 远程用户 home 的 .pi 目录（entry 脚本位置即仓库位置，兼容 Termux/PROOT 与常规 Linux）
PI_HOME_DIR="${HOME}/.pi"
PI_BIN="pi"

if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  # 审计 LOW：set -u 下 SSH_ORIGINAL_COMMAND 未设置时直接引用会 unbound 崩溃丢失诊断信息
  echo "pi-link-entry: pi 命令不在 PATH 中（original_command=${SSH_ORIGINAL_COMMAND:-<none>}）" >&2
  exit 127
fi

mkdir -p "${PI_HOME_DIR}/agent/sessions/pi-link"

exec "$PI_BIN" --mode rpc --no-extensions --session-dir "${PI_HOME_DIR}/agent/sessions/pi-link"
