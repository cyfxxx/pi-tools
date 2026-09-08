#!/bin/bash
# 回滚脚本 - 恢复到迁移前状态
# 用法: bash .migration-snapshot/rollback.sh [phase1|phase2|phase3|all]

set -e
cd "$(dirname "$0")/.."
PI_HOME="$(pwd)"

echo "=== 回滚 .pi 模块化迁移 ==="
echo "目标: $PI_HOME"

PHASE="${1:-all}"

# 删除所有为迁移创建的 symlink
cleanup_symlinks() {
    local count=0
    # 扩展配置目录中的 symlink
    for f in "$PI_HOME"/agent/extensions/*/config; do
        if [ -L "$f" ] || [ -d "$f" ] && [ "$(readlink "$f" 2>/dev/null)" ]; then
            rm -rf "$f"
            count=$((count + 1))
        fi
    done
    # 扩展脚本目录中的 symlink
    for f in "$PI_HOME"/agent/extensions/*/scripts; do
        if [ -L "$f" ] || [ -d "$f" ] && [ "$(readlink "$f" 2>/dev/null)" ]; then
            rm -rf "$f"
            count=$((count + 1))
        fi
    done
    # agent/ 根目录中被 symlink 替换的文件
    for f in "$PI_HOME"/agent/.pi-autopilot-*.json "$PI_HOME"/agent/.notify-state.json \
             "$PI_HOME"/agent/.pi-tmux-registry.json "$PI_HOME"/agent/.usage-diag.jsonl \
             "$PI_HOME"/agent/notify.json "$PI_HOME"/agent/ntfy-relay.json \
             "$PI_HOME"/agent/.ntfy-relay-state.json "$PI_HOME"/agent/.ntfy-relay.pid \
             "$PI_HOME"/agent/pi-voice.json "$PI_HOME"/agent/scheduled-tasks.json; do
        if [ -L "$f" ]; then
            rm "$f"
            count=$((count + 1))
        fi
    done
    # 顶层 pi-link symlink
    for f in "$PI_HOME"/pi-link.json; do
        if [ -L "$f" ]; then
            rm "$f"
            count=$((count + 1))
        fi
    done
    echo "  清理了 $count 个 symlink"
}

# 用 git 恢复被移动的文件
restore_git() {
    echo "  从 git 恢复文件..."
    git checkout -- . 2>/dev/null || true
    git clean -fd -- extensions/*/config extensions/*/scripts 2>/dev/null || true
}

case "$PHASE" in
    phase1)
        echo "回滚 Phase 1: 配置文件..."
        cleanup_symlinks
        restore_git
        ;;
    phase2)
        echo "回滚 Phase 2: 脚本文件..."
        cleanup_symlinks
        restore_git
        ;;
    phase3)
        echo "回滚 Phase 3: 运行时状态..."
        cleanup_symlinks
        restore_git
        ;;
    all)
        echo "回滚所有阶段..."
        cleanup_symlinks
        restore_git
        ;;
    *)
        echo "用法: $0 [phase1|phase2|phase3|all]"
        exit 1
        ;;
esac

echo "=== 回滚完成 ==="
echo "请运行测试验证: bash scripts/test-all.sh"
