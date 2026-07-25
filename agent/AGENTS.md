# 配置目录介绍
```
├── agent/
│   ├── settings.json          Pi 主配置
│   ├── AGENTS.md              本文件
│   ├── APPEND_SYSTEM.md       追加系统提示词
│   ├── lib/                   共享库模块
│   │   ├── token-budget.ts    跨扩展 Token 用量追踪
│   │   ├── note-store.ts      ctx-lite 笔记持久化
│   │   ├── prune.ts           工具输出裁剪
│   │   ├── TOKEN-BUDGET.md    使用文档
│   │   └── tests/             单元测试
│   ├── extensions/            自定义扩展
│   │   ├── pi-web-toolkit/    浏览器自动化 + 搜索
│   │   ├── pi-scheduler/      定时任务（interval / cron / once + 离线唤醒）
│   │   ├── ctx-lite/          轻量上下文笔记
│   │   ├── plan-mode/         计划模式
│   │   ├── pi-memory/         跨会话持久记忆
│   │   ├── subagent/          子代理（delegate 给专门 agent）
│   │   ├── pi-router/         before_agent_start 注入主动路由策略
│   │   └── pi-context-efficiency/  token 优化（thinking 剥离/context 过滤/输出截断）
│   ├── skills/                自定义技能
│   │   ├── pi-translate-zh/   tui 中文翻译
│   │   └── pi-backup/         备份恢复技能（本地归档 + GitHub 同步）
│   └── npm/
│       ├── package.json       npm 包声明
│       └── .gitignore         只排除 node_modules/ 和 package-lock.json
│   ├── agents/                   agent 定义（子代理模板）
│   │   ├── scout.md              Haiku 快速代码探测，返回压缩上下文
│   │   ├── planner.md            实现计划生成（Sonnet）
│   │   ├── worker.md             通用执行 agent
│   │   └── reviewer.md           代码审查（Sonnet）
│   └── prompts/                  工作流 prompt（子代理 chain 模板）
│       ├── implement.md          完整实现流：scout→planner→worker
│       ├── scout-and-plan.md     探测+计划：scout→planner
│       └── implement-and-review.md  实现+审查：worker→reviewer→worker
├── ctx-lite/                  ctx-lite 运行时数据（checkpoints）
│   └── checkpoints/           笔记检查点
├── memory/                    pi-memory 运行时数据
├── searxng/                   SearXNG 自托管搜索引擎
│   ├── settings.yml           SearXNG 配置（含 secret_key）
│   ├── generate-config.sh     settings.yml 自动生成脚本
│   ├── start.sh               启动脚本
│   └── stop.sh                停止脚本
├── scripts/
│   ├── rebuild.sh             一键重建脚本（幂等、并行下载、国内镜像加速）
│   ├── pi-cron.sh             pi-scheduler 离线执行包装脚本
│   ├── install-cron.sh        安装 crontab 条目
│   ├── install-systemd.sh     安装 systemd timer（备选）
│   ├── pi-wrapper.sh          进程外生命周期管理器（自动重启）
│   ├── install-wrapper.sh     wrapper 安装/卸载
│   └── pi-orig.sh             绕过 wrapper 直启（故障逃生）
├── logs/
│   └── scheduler/             离线执行日志（自动清理，不 git 跟踪）
├── .gitignore                 已排除大二进制、密钥、运行时产物
└── README.md                  配置目录说明
```
