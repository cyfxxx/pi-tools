# Git 历史重写说明（2026-08-27）

## 事件

2026-08-27 使用 git-filter-repo 重写了本仓库全部历史，移除大文件：
`packs/pdf-toolkit/examples/scan.pdf`（6.2MB，建包时生成的测试扫描件，PDF 无法被 git 压缩，永久驻留历史）。

- 重写前 HEAD：`895746c`
- 重写后 HEAD：`f83450c`
- 已 force push 到远程 `cyfxxx/pi-tools`

## 影响

任何在 2026-08-27 之前 clone 过本仓库的环境（Termux 手机 / WSL2 / 其他设备 / 便携 pi），其本地历史与远程**分叉**：
- 远程新历史不包含旧提交（重写后所有 commit hash 变化）
- 已存 tag/分支备份可能指向旧（已失效）提交

## 各环境同步步骤

```bash
# 在旧 clone 环境（先确认本地无未推送提交）：
git status                # 如有未推送提交，先备份或将改动复制到安全位置
git fetch origin
git reset --hard origin/master    # 丢弃旧历史，对齐新历史（会丢失本地未推送提交！）
```

注意：
- 本地**未推送**的提交会被 `reset --hard` 丢弃——同步前先确认（`git log origin/master..HEAD` 应为空）
- 若本地有未推送且重要的提交，先 `git stash` 或 `git format-patch` 导出，同步后再 cherry-pick/appl

## 验证同步成功

```bash
git log --oneline -1        # 应显示 f83450c
git rev-list --all --objects | grep scan.pdf   # 应无输出（历史已无此文件）
```

## 预防（避免再次发生）

- 建包/测试产物体积判断：>1MB 的二进制（PDF/模拟数据/截图）不入库；需要示例时用同内容小体积文件或文本占位，并在包 README 注明真实产物如何生成
- 需要验证大文件是否误入库时：`git rev-list --all --objects | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | sort -k3 -n -r | head`
- 仓库体积审计：`git count-objects -vH`（size-pack 为 pack 体积）；GitHub API `size` 字段有缓存延迟，重写后不会立即刷新