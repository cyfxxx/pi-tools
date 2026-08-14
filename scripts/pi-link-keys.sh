#!/usr/bin/env bash
# pi-link-keys.sh — 多设备互连公钥管理
#
# 思路：所有设备的公钥集中存放在仓库 deploy/keys/authorized_keys（git 同步），
# 每台设备跑一次 install 即获得全部设备授权，两两免密互连。
#
# 用法：
#   pi-link-keys.sh install   把仓库公钥合集合并到本机 authorized_keys（幂等）
#   pi-link-keys.sh export    输出本机公钥（加入仓库用）
#   pi-link-keys.sh add <公钥>  把新设备公钥追加到仓库合集（需在仓库目录执行）
#   pi-link-keys.sh help      本帮助
#
# 兼容 Termux（proot）+ 常规 Linux/macOS：
#   Termux sshd 读 Termux home（/data/data/com.termux/files/home/.ssh），
#   proot 内 shell 的 $HOME=/root —— 两个位置都写入（幂等）。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_HOME="$(dirname "$SCRIPT_DIR")"          # 仓库根（~/.pi）
KEYS_FILE="$PI_HOME/deploy/keys/authorized_keys"  # 仓库公钥合集

# 目标 authorized_keys 位置（数组，逐目标安装）
TARGETS=()
[ -n "${HOME:-}" ] && TARGETS+=("$HOME/.ssh/authorized_keys")
# Termux 真实 home（sshd 使用）：$PREFIX 或 /data/data/com.termux 存在时
if [ -d /data/data/com.termux/files/home ]; then
  TARGETS+=("/data/data/com.termux/files/home/.ssh/authorized_keys")
fi

info() { printf '[\033[36m*\033[0m] %s\n' "$*"; }
ok()   { printf '[\033[32m✓\033[0m] %s\n' "$*"; }
warn() { printf '[\033[33m!\033[0m] %s\n' "$*" >&2; }
err()  { printf '[\033[31m✗\033[0m] %s\n' "$*" >&2; }

install_keys() {
  [ -f "$KEYS_FILE" ] || { err "仓库公钥合集缺失: $KEYS_FILE（先 pull 最新代码）"; return 1; }

  # 收集合集里的有效公钥（去重，忽略注释/空行）
  local -A seen
  local added=0 total=0
  local installed=0

  for target in "${TARGETS[@]}"; do
    [ -n "$target" ] || continue
    mkdir -p "$(dirname "$target")" || continue
    [ -f "$target" ] || touch "$target"
    chmod 600 "$target" 2>/dev/null

    # 现有行作为基准——按密钥体（前两字段，不含尾部 comment）去重：
    # comment 变体（如 root@localhost vs termux@100.x.x.x）不应导致重复授权
    local -A seen=()
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in \#*) continue ;; esac
      set -- $line
      [ $# -ge 2 ] && seen["$1 $2"]=1
    done < "$target"

    total=0; added=0
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in \#*) continue ;; esac
      total=$((total+1))
      set -- $line
      body="$1 $2"
      if [ -z "${seen["$body"]+x}" ]; then
        printf '%s\n' "$line" >> "$target"
        seen["$body"]=1
        added=$((added+1))
      fi
    done < "$KEYS_FILE"

    installed=$((installed+added))
    if [ "$added" -gt 0 ]; then
      ok "$target：已添加 $added 条公钥（共 $total 条）"
    else
      ok "$target：已是最新（$total 条公钥全部已授权）"
    fi
  done

  [ "${#TARGETS[@]}" -gt 0 ] || { err "未找到可写入的 authorized_keys 位置"; return 1; }
  info "完成。若本机是 sshd 目标设备，新设备公钥即刻生效（无需重启 sshd）。"
}

export_key() {
  for f in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
    [ -f "$f" ] && { cat "$f"; return 0; }
  done
  # Termux 侧
  for f in /data/data/com.termux/files/home/.ssh/id_ed25519.pub \
           /data/data/com.termux/files/home/.ssh/id_rsa.pub; do
    [ -f "$f" ] && { cat "$f"; return 0; }
  done
  err "未找到本机公钥（先 ssh-keygen -t ed25519 生成）"
  return 1
}

add_key() {
  local key="$1"
  case "$key" in
    ssh-*) ;;
    *) err "无效公钥（应为 ssh-ed25519 AAAA... 格式）"; return 1 ;;
  esac
  [ -f "$KEYS_FILE" ] || { err "仓库公钥合集缺失: $KEYS_FILE（需在仓库目录 ~/.pi 下执行）"; return 1; }
  if grep -qF "$key" "$KEYS_FILE"; then
    info "该公钥已在合集中，跳过"
    return 0
  fi
  printf '%s\n' "$key" >> "$KEYS_FILE"
  ok "已追加到 $KEYS_FILE（提交推送后，其他设备 pull + install 即获得授权）"
}

case "${1:-help}" in
  install) install_keys ;;
  export)  export_key ;;
  add)     [ $# -ge 2 ] && add_key "$2" || { err "用法: pi-link-keys.sh add <公钥>"; exit 1; } ;;
  help|-h|--help)
    sed -n '1,12p' "$0" | sed 's/^# //; /^$/d' ;;
  *) err "未知子命令: $1（help 查看用法）"; exit 1 ;;
esac
