# Pi Scripts 目录

Pi 项目核心脚本集合，涵盖进程生命周期管理、崩溃恢复、构建部署、环境维护和开发工具。

## 目录结构

```
scripts/
├── pi-wrapper.sh          # 进程外生命周期管理器（入口）
├── pi-orig.sh             # 绕过 wrapper 直接启动 Pi CLI
├── rebuild.sh             # 全量重建 pi（extensions + skills + docs）
├── pi-source-build.sh     # 从源码构建 pi
│
├── crash-recovery/        # 崩溃恢复与诊断
│   ├── pi-crash-analyzer.sh    # 崩溃原因分析器（13 种崩溃类型分类）
│   ├── pi-recovery-audit.sh    # 恢复操作审计日志
│   └── pi-rescue.sh            # 手动救援脚本
│
├── maintenance/           # 日常维护与检查
│   ├── daily-health.mjs        # 每日健康检查（缓存/token/压缩）
│   ├── pi-bench.sh             # 用量基准聚合报告
│   ├── verify-patches.mjs      # 校验 TUI 补丁版本匹配
│   ├── npm-missing-deps.py     # 检测缺失/损坏的 npm 依赖
│   ├── migrate-tool-events.sh  # 一次性迁移 tool-use 事件文件
│   ├── doc-lint.mjs            # 扩展 README 一致性检查
│   ├── doc-extract.py          # 文档提取工具
│   ├── lesson-miner.mjs        # 经验教训挖掘
│   ├── check-cache-impact.sh   # 缓存影响检查
│   ├── packs-sync.sh           # 技能包同步
│   └── golden-tasks.sh         # 黄金任务测试
│
├── install/               # 安装与配置
│   ├── install-wrapper.sh      # 安装 pi-wrapper
│   ├── install-cron.sh         # 安装定时任务
│   ├── install-systemd.sh      # 安装 systemd 服务
│   └── install-tool-sync-hooks.sh  # 安装工具同步 hooks
│
├── test/                  # 测试
│   ├── test-all.sh             # 全量回归测试
│   ├── test-recovery.sh        # 恢复系统测试
│   └── smoke-test.sh           # 重建后端到端冒烟测试
│
├── environment/           # 环境准备
│   └── termux-prereq.sh        # Termux 环境依赖安装
│
└── docs/                  # 文档
    ├── README-pi-bg.md         # 后台任务使用说明
    └── README-recovery.md      # 自动修复系统快速指南
```

## 核心脚本说明

### 进程管理

| 脚本 | 用途 | 依赖 |
|------|------|------|
| `pi-wrapper.sh` | Pi 进程外生命周期管理器，负责启动/监控/崩溃恢复/熔断 | pi, node |
| `pi-orig.sh` | 绕过 wrapper 直接启动 Pi CLI（调试用） | pi |
| `pi-rescue.sh` | 手动救援：启动最小化 pi 实例修复问题 | pi |

### 构建部署

| 脚本 | 用途 | 依赖 |
|------|------|------|
| `rebuild.sh` | 全量重建 pi（extensions + skills + docs + patches） | node, npm |
| `pi-source-build.sh` | 从源码构建 pi（用于 pi_self 崩溃恢复） | node, npm, pnpm |
| `smoke-test.sh` | 重建后端到端冒烟测试 | pi, node |

### 崩溃恢复

| 脚本 | 用途 | 依赖 |
|------|------|------|
| `pi-crash-analyzer.sh` | 崩溃原因分析器，支持 13 种崩溃类型分类 | bash |
| `pi-recovery-audit.sh` | 恢复操作审计日志记录 | bash |

### 维护工具

| 脚本 | 用途 | 依赖 |
|------|------|------|
| `daily-health.mjs` | 每日健康检查（缓存命中/token 消耗/压缩状态） | node |
| `pi-bench.sh` | 用量基准聚合报告（usage/timing/compare） | node |
| `verify-patches.mjs` | 校验 TUI 补丁的目标 pi 版本与当前安装版本匹配 | node |
| `npm-missing-deps.py` | 检测 node_modules 中缺失/损坏/版本不匹配的依赖 | python3 |
| `doc-lint.mjs` | 扩展 README 与代码一致性检查（工具名/命令面） | node |

## 使用方式

```bash
# 全量重建
bash scripts/rebuild.sh

# 全量回归测试
bash scripts/test/test-all.sh

# 快速测试单个扩展
bash scripts/test/test-all.sh --only=pi-context,pi-memory

# 健康检查
node scripts/maintenance/daily-health.mjs

# 用量基准
bash scripts/maintenance/pi-bench.sh usage
bash scripts/maintenance/pi-bench.sh timing
bash scripts/maintenance/pi-bench.sh compare <基准文件>

# 检查 npm 依赖
python3 scripts/maintenance/npm-missing-deps.py agent/extensions/pi-voice

# 文档一致性检查
node scripts/maintenance/doc-lint.mjs
```

## 约束

- **pi-wrapper.sh** 是唯一推荐的 pi 启动入口，不要直接调用 pi CLI
- **rebuild.sh** 必须在 pi 停止时执行（避免 dist 文件被占用）
- **test-all.sh** 支持 `--only`/`--fast`/`--no-tsc` 参数分层验证
- 所有脚本遵循 `set -euo pipefail` 严格模式
- 长任务使用 `tmux_run` 后台执行，禁止 `tmux_wait` 阻塞

## 相关文档

- 自动修复系统详情：`docs/README-recovery.md`
- 后台任务使用说明：`docs/README-pi-bg.md`
- 测试回归细节：`agent/AGENTS.md` → 验证章节
