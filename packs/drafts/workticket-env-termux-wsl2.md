status: proposed

## 问题
Termux 与 WSL2 被错误视为同一环境，导致环境专属记忆条目标签纠错、合并时产生冲突，实际两者是完全不同的运行环境。

## 建议改动
1) 为 Termux 条目明确标签 environments: ["termux"]，为 WSL2 条目标签 environments: ["wsl2"]  
2) 更新记忆库检索逻辑，按 environment 字段过滤，禁止跨环境合并  
3) 定期运行标签纠错脚本，确保 wsl2→termux 环境隔离无误

## 验证方式
使用 memory_search 查询 tags: ["termux"] 与 tags: ["wsl2"] 的结果分别仅包含对应环境的条目；如出现跨环境条目，标记需纠错。