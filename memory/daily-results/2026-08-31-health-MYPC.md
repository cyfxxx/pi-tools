2026-08-31 08:14 命中=96.6% 断裂=7(AB=5) 浪费=217K 存储=0.87MB 条目=807 会话=48 轮=374 设备=1(失联0) 种子失配=2 结论=alert
原因: 种子任务 knowledge-subscribe schedule 漂移(0 8 * * *≠20 8 * * *)；种子任务 daily-review prompt 漂移(与 seeds 不一致，需同步本地任务)；A/B 断裂 5>3
