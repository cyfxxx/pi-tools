# 每日任务标准 prompt（v3，2026-08-28）

多设备竞态容忍架构：各设备同时执行也无害。主流程靠查重防"先后重复"；竞态产生的"同时重复"由 daily-review 交叉比对兜底清理（冗余措施），最终一致。**各设备 scheduled-tasks.json 不入库，需按本文件手动应用。**

## daily-task（cron 0 8 * * *，原 knowledge-subscribe 更名）

```text
执行每日统一任务（拉取→检查→订阅→报告）：1) cd ~/.pi && git pull --rebase 拉取远程更新；entries.json 冲突按三方比对流程处理（比对条目数/recurrence/时间戳，验证本地为远端真子集才放行）。2) 日常检查（只读快速）：df -h /、free -m、uptime、pi 进程数、memory_stats 记忆库条目总数。3) 跨设备查重：entries.json 当天({{date}})已有 tags 含 knowledge+订阅 的条目→说明其他设备已完成订阅，跳过步骤4，报告注明。4) 知识订阅：python3 scripts/knowledge-fetch.py；有新增筛 3-5 条高价值条目 memory_store，写 ~/.pi/logs/knowledge/summary-{{date}}.md；无新增如实说明。渠道维护/触发排查用 packs/knowledge-fetch 技能。5) 汇总报告：写 memory/daily-results/{{date}}-<本机hostname>.md（检查结果+订阅执行/跳过+要点，200字内），git add 该文件与 entries.json 后 commit+push；推送冲突→git pull --rebase 三方比对后重试，仍失败则在报告注明即可（重复条目由 daily-review 兜底清理）。
```

## daily-review（cron 5 9 * * *）

```text
执行每日回顾（含交叉比对兜底）：1) cd ~/.pi && git pull --rebase 同步远端（entries.json 冲突按三方比对流程处理）。2) 读 memory/daily-results/ 全部设备当日结果，对比各设备执行情况，识别遗漏与信息不对称。3) 冗余兜底——交叉比对当日订阅条目：entries.json 中同主题/同事件/同 URL 出现多设备重复入库时，保留信息更完整的一条，多余条目 memory_forget 删除。4) 回顾过去 24h 会话摘要有价值经验，提炼 1-3 条 memory_store。5) 回顾结论（200字内，含兜底清理结果）写入 memory/daily-results/{{date}}-<本机hostname>.md，git add+commit+push（冲突先 pull --rebase）；其他设备任务长期未跑需明确指出。
```

## 应用方式（每台新设备/存量设备）

编辑 `agent/scheduled-tasks.json`：knowledge-subscribe 改名 daily-task 并替换 prompt 为上文；daily-review 替换 prompt 为上文。id 不变，仅 name/prompt/updatedAt 变。改后无需重启，scheduler 下轮读取生效。
