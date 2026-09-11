#!/usr/bin/env bash
# ============================================================
# docker-rebuild-test.sh — Docker 干净环境完整重建测试
# 在全新 ubuntu 容器中验证 pi-tools 仓库可完整重建（模拟新设备）。
# 用法: bash scripts/docker-rebuild-test.sh [分支] [镜像]
#   分支: 默认 test/portable-win-merge（合并测试分支）
#   镜像: 默认 ubuntu:24.04
# 依赖: docker 可用；~/.ssh 含 GitHub 认证密钥（挂载进容器）
# ============================================================
set -uo pipefail

BRANCH="${1:-test/portable-win-merge}"
IMAGE="${2:-ubuntu:24.04}"
CONTAINER="pi-rebuild-$(date +%H%M%S)"
REPO="ssh://git@ssh.github.com:443/cyfxxx/pi-tools.git"

info() { echo -e "  \033[0;36m→\033[0m $1"; }
ok()   { echo -e "  \033[0;32m✓\033[0m $1"; }
fail() { echo -e "  \033[0;31m✗\033[0m $1"; }

command -v docker &>/dev/null || { echo "docker 不可用"; exit 1; }
[ -d "$HOME/.ssh" ] || { echo "~/.ssh 不存在（容器 clone 需要密钥）"; exit 1; }

info "启动容器 $CONTAINER（$IMAGE）..."
docker run -d --name "$CONTAINER" -v "$HOME/.ssh:/root/.ssh:ro" "$IMAGE" sleep infinity >/dev/null \
  || { fail "容器启动失败"; exit 1; }

info "安装基础工具（git/curl/ca-certificates/openssh-client）..."
docker exec "$CONTAINER" bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates openssh-client" >/dev/null 2>&1 \
  && ok "基础工具就绪" || { fail "基础工具安装失败"; docker rm -f "$CONTAINER" >/dev/null; exit 1; }

info "clone 仓库（分支 $BRANCH）..."
docker exec "$CONTAINER" bash -c "git config --global core.sshCommand 'ssh -o StrictHostKeyChecking=no'; git clone -b '$BRANCH' '$REPO' /root/.pi" >/dev/null 2>&1 \
  && ok "clone 完成: $(docker exec "$CONTAINER" bash -c "cd /root/.pi && git log --oneline -1")" \
  || { fail "clone 失败"; docker rm -f "$CONTAINER" >/dev/null; exit 1; }

LOG="/root/.pi/logs/docker-rebuild-${CONTAINER}.log"
info "容器内执行 rebuild.sh --yes（完整重建，耗时取决于网络；日志: $LOG）..."
docker exec "$CONTAINER" bash -c "cd /root/.pi && bash scripts/rebuild.sh --yes" 2>&1 | tee "$LOG" >/dev/null
RC=${PIPESTATUS[0]}

echo "===== Docker 重建测试结论（分支 $BRANCH）====="
if [ "$RC" -eq 0 ] && ! grep -q '✗' "$LOG"; then
  ok "重建通过（无 ✗ 项；⚠ 警告可接受）"
  grep -c '✓' "$LOG" | xargs echo "  ✓ 项数:"
  docker exec "$CONTAINER" bash -c "cd /root/.pi && grep -E '重建完成|全部完成' logs/rebuild-*.log | tail -1"
else
  fail "重建失败（RC=$RC，✗ 项如下）"
  grep '✗' "$LOG" | head -10
fi
echo "容器保留（排查用）: docker exec -it $CONTAINER bash"
echo "清理: docker rm -f $CONTAINER"
exit "$RC"
