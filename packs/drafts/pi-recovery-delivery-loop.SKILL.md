---
name: pi-recovery-delivery-loop
description: 处理 pi 崩溃或会话挂死后的诊断、修复、回归验证与提交推送闭环，适用于 Termux 与 WSL2 环境。
---

## 触发条件
当 pi 崩溃、会话挂死、重启后状态异常，或需要交付一轮修复优化时使用。

## 执行步骤
1. **确认环境**：先区分 Termux（Android 设备内 Linux）与 WSL2（Windows 内 Linux），两者运行时、配置和 entries.json 的 environment 标签不可混用。
2. **诊断原因**：检查管理员状态、运行日志、Git 工作区状态和相关会话，定位崩溃或挂死的直接原因。
3. **执行修复**：针对根因做最小改动，避免顺手修改无关配置。
4. **运行验证**：执行适用的确定性回归（如 `bash ~/.pi/scripts/golden-tasks.sh --fast`），确认 F1-F5 全部通过。
5. **提交推送**：`cd ~/.pi && git add -p` 核对变更，`git commit -m "..."`，`git push`。
6. **会话收尾**：仅清理非当前会话；重启后复查管理员状态、当前会话可操作性和关键配置完整性。

## 关键点
- Termux 与 WSL2 是不同运行环境，批量纠错 entries.json 时必须按实际环境分组统计并抽查。
- 崩溃修复后必须做回归验证再提交推送，不能只凭重启成功判断恢复。
- 清理会话时保留当前会话，避免中断正在进行的操作。
- 用户纠正任何 ID、路径或环境标签时，以纠正后的信息为准并重新核验。

## 相关文件
- `~/.pi/scripts/golden-tasks.sh`：快速确定性回归基准
- `~/.pi/scripts/rebuild.sh`：构建/重编译脚本
- `~/.pi/memory/entries.json`：长期记忆条目数据
