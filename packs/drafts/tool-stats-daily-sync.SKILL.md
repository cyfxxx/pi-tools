---
name: tool-stats-daily-sync
description: 每日聚合工具调用统计并推送到远程仓库，用于跨会话缓存命中分析与历史对比
---

## 触发条件
每日定时或手动执行，当天数据已完整时。

## 执行步骤
1. 运行统计脚本：
   ```bash
   node ~/.pi/scripts/tool-stats-sync.mjs --daily
   ```
   脚本读取当天工具调用数据，生成 `memory/stats/tool-count-<hostname>.json`。

2. 确认生成文件：
   ```bash
   ls -la ~/.pi/memory/stats/tool-count-$(hostname).json
   ```

3. 提交并推送到远程：
   ```bash
   cd ~/.pi
   git add memory/stats/tool-count-$(hostname).json
   git commit -m "chore: daily tool stats sync $(date +%F)"
   git push
   ```

## 关键点
- 脚本幂等，可重复运行覆盖当天数据
- 远程仓库为 `ssh://ssh.github.com:443/cyfxxx/pi-tools.git`
- 统计文件按主机名隔离，跨环境聚合时再合并
- 推送前确认 `git remote -v` 无 token 泄露

## 相关文件
- `~/.pi/scripts/tool-stats-sync.mjs`：聚合脚本
- `~/.pi/memory/stats/`：输出目录
- `~/.pi/scripts/test-all.sh`：全量回归含统计验证