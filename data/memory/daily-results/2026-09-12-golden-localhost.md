# golden-fast 失败记录 — 2026-09-12 (localhost)

## 失败项

- ✗ F1 task-metrics 管线异常
- ✗ F2b usage-stats 异常

## golden 输出尾部 10 行

```
✓ F2a lesson-miner 可运行
✗ F2b usage-stats 异常
F3 entries.json 完整: 905 条有效 / 无明文密钥
✓ F3 entries.json 完整性与脱敏
F4 interventions.jsonl 结构完整: 22 条
✓ F4 干预快照结构
F5 写→读→删校验通过（原有 22 条不受影响）
✓ F5 干预快照写路径

══ golden-tasks [fast] 失败 2 项 ══
```