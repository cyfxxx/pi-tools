# 模块化整合方案

**日期**: 2026-09-07  
**基线提交**: `17d3a99` (remove pi-webui extension)  
**目标**: 将 .pi 目录从"扁平散落"重构为"按扩展内聚"，方便独立调整、分享扩展

---

## 当前问题

1. **配置散落**: `pi-link*.json` 在顶层、`notify.json`/`.pi-autopilot-*.json` 在 `agent/` 根目录
2. **脚本归属不清**: 50+ 脚本全堆在 `scripts/`，无法一眼看出哪个归哪个扩展
3. **运行时状态混杂**: `.notify-state.json`、`.pi-tmux-registry.json` 等状态文件在 `agent/` 根目录
4. **lib/ 导出不清晰**: `token-budget.ts` 是 `context-budget.ts` 的兼容层，命名混乱

---

## 分层设计原则（2026-09-08 确立）

### 五层架构

```
┌─────────────────────────────────────────────┐
│  用户配置层 (Config)                          │
│  settings.json / models.json / auth.json     │
├─────────────────────────────────────────────┤
│  技能包层 (Packs)                             │
│  packs/<name>/  — 外部技能包、社区贡献         │
├─────────────────────────────────────────────┤
│  技能层 (Skills)                              │
│  agent/skills/<name>/  — 内置技能             │
├─────────────────────────────────────────────┤
│  扩展层 (Extensions)                          │
│  agent/extensions/<name>/  — 功能扩展         │
├─────────────────────────────────────────────┤
│  核心层 (Core)                                │
│  pi-coding-agent npm dist/  — 运行时          │
└─────────────────────────────────────────────┘
```

### 分层职责

| 层 | 目录 | 职责 | 归属规则 |
|----|------|------|----------|
| Core | `pi-coding-agent/dist/` | CLI 入口、扩展加载、会话管理 | npm 包，不直接修改 |
| Extensions | `agent/extensions/<name>/` | 功能模块（调度/语音/搜索/tmux 等） | 每个扩展自包含 |
| Skills | `agent/skills/<name>/` | 用户可安装的技能包 | 按需加载 |
| Packs | `packs/<name>/` | 外部/社区技能包 | 独立分发 |
| Config | `agent/settings.json` 等 | 用户配置 | 每环境独立 |

### 模块化要求

1. **扩展自包含**: 每个扩展的配置、脚本、状态文件必须在 `extensions/<name>/` 下
   - 配置: `extensions/<name>/config/` 或 `extensions/<name>/*.json`
   - 脚本: `extensions/<name>/scripts/`（通过 symlink 到 `scripts/` 供外部发现）
   - 状态: `extensions/<name>/.<name>-*.json`（运行时数据）

2. **禁止散落**: 扩展文件不得出现在 `agent/` 根目录或 `scripts/` 根目录
   - 例外: `agent/settings.json`、`agent/modes.json`、`agent/models.json`、`agent/auth.json` 等共用配置
   - 例外: `agent/AGENTS.md`、`agent/APPEND_SYSTEM.md` 等共用文档

3. **向后兼容**: 移动文件后必须在旧路径保留 symlink，过渡期结束后清理

4. **路径引用**: 代码和文档必须引用文件的规范路径（新位置），不得引用 symlink 路径（旧位置）

5. **gitignore 对称**: 新旧路径都应加入 .gitignore（运行时数据不入库）

### 非原生目录处理

| 目录 | 性质 | 处理策略 |
|------|------|----------|
| `packs/` | 外部技能包 | 保留独立格式，不强制迁移到 skills/ |
| `plans/` | 计划快照 | gitignore，定期清理 |
| `deploy/` | 部署配置 | 保留（运维必需） |
| `searxng/` | 搜索服务 | 保留（独立服务） |
| `portable/` | Windows 分发 | 保留（独立用途） |
| `pi-source/` | 源码目录 | 空目录，可删除 |
| `pi-source-cache/` | 编译缓存 | gitignore，可重建 |

## 目标结构

```
.pi/
├── agent/
│   ├── AGENTS.md                    # 共用 - 项目说明
│   ├── APPEND_SYSTEM.md             # 共用 - 系统提示词补充
│   ├── settings.json                # 共用 - 主配置
│   ├── modes.json                   # 共用 - 模式定义
│   ├── models.json                  # 共用 - 模型配置 (gitignored)
│   ├── auth.json                    # 共用 - 认证凭据 (gitignored)
│   ├── package.json                 # 共用 - 依赖声明
│   ├── lib/                         # 共用 - 跨扩展库
│   │   ├── context-budget.ts
│   │   ├── prune.ts
│   │   ├── auto-compact.ts
│   │   ├── usage-diag.ts
│   │   ├── task-record.ts
│   │   ├── note-store.ts
│   │   ├── output-archive.ts
│   │   ├── registry.ts
│   │   ├── config.ts
│   │   ├── hook-registry.ts
│   │   ├── shadow-review.ts
│   │   └── index.ts                 # NEW: 统一导出入口
│   ├── types/
│   │   └── pi-coding-agent.d.ts
│   └── extensions/
│       ├── tsconfig.json
│       ├── tsconfig.local.json
│       ├── tests/                   # 共用测试工具
│       │   ├── cache-guard.mjs
│       │   └── conflict-check.mjs
│       ├── pi-autopilot/
│       │   ├── index.ts, *.ts       # 源码不变
│       │   ├── config/              # NEW: 扩展专用配置
│       │   │   └── (symlink -> agent/ .pi-autopilot-config.json)
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-voice/
│       │   ├── index.ts, *.ts
│       │   ├── config/              # NEW: 扩展专用配置
│       │   │   └── (symlink -> agent/ pi-voice.json)
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   ├── pi-whisper.sh
│       │   │   ├── pi-sherpa.sh
│       │   │   ├── pi-sherpa-server.py
│       │   │   └── whisper-server.py
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-link/
│       │   ├── index.ts, *.ts
│       │   ├── config/              # NEW: 扩展专用配置
│       │   │   ├── pi-link.json     # 从顶层移入
│       │   │   └── (symlinks for runtime files)
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   ├── pi-link-entry.sh
│       │   │   └── pi-link-keys.sh
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-tmux/
│       │   ├── index.ts, *.ts
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   ├── pi-bg.sh
│       │   │   └── tmux-fix.sh
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-web-search/
│       │   ├── index.ts, *.ts
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   └── start-searxng.sh
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-memory/
│       │   ├── index.ts, *.ts
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   └── memory-lifecycle.mjs
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-context/
│       │   ├── index.ts, *.ts
│       │   ├── scripts/             # NEW: 扩展专用脚本 (patches)
│       │   │   ├── patch-compaction-warm-prefix.mjs
│       │   │   ├── patch-footer-cache.mjs
│       │   │   ├── patch-footer-format.mjs
│       │   │   ├── patch-footer-live-context.mjs
│       │   │   ├── patch-footer-restart-hint.mjs
│       │   │   ├── patch-fuzzy-match-type.mjs
│       │   │   ├── patch-tab-arg-completion.mjs
│       │   │   └── patch-truncate-type.mjs
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-browser/
│       │   ├── index.ts, *.ts
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   └── patch-playwright-core.mjs
│       │   ├── tests/
│       │   └── README.md
│       ├── plan-mode/
│       │   ├── index.ts, *.ts
│       │   ├── scripts/             # NEW: 扩展专用脚本
│       │   │   └── patch-plan-tools.mjs
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-intervention/
│       │   ├── index.ts
│       │   ├── tests/
│       │   └── README.md
│       ├── pi-mode/
│       │   ├── index.ts, *.ts
│       │   ├── tests/
│       │   └── README.md
│       └── subagent/
│           ├── index.ts, agents.ts
│           ├── tests/
│           └── README.md
├── scripts/                         # 保留: 核心/基础设施脚本
│   ├── rebuild.sh                   # 核心: 一键重建
│   ├── test-all.sh                  # 核心: 全量测试
│   ├── pi-wrapper.sh                # 核心: 进程管理
│   ├── install-wrapper.sh           # 基础设施
│   ├── install-cron.sh              # 基础设施 (pi-autopilot)
│   ├── install-systemd.sh           # 基础设施 (pi-autopilot)
│   ├── install-tool-sync-hooks.sh   # 基础设施
│   ├── pi-orig.sh                   # 基础设施
│   ├── smoke-test.sh                # 基础设施
│   ├── verify-patches.mjs           # 基础设施
│   ├── docker-rebuild-test.sh       # 基础设施
│   ├── pi-recovery-audit.sh         # 基础设施
│   ├── pi-crash-analyzer.sh         # 基础设施
│   ├── pi-bench.sh                  # 基础设施
│   ├── pi-cron.sh                   # pi-autopilot (保留兼容)
│   ├── ntfy-relay.js                # pi-autopilot (保留兼容)
│   ├── ntfy-relay.sh                # pi-autopilot (保留兼容)
│   ├── pi-notify.sh                 # pi-autopilot (保留兼容)
│   ├── knowledge-fetch.py           # pi-autopilot (保留兼容)
│   ├── tool-stats-sync.mjs          # pi-context (保留兼容)
│   ├── usage-stats.mjs              # pi-context (保留兼容)
│   ├── task-metrics.mjs             # pi-autopilot (保留兼容)
│   ├── task-summarizer.mjs          # pi-context (保留兼容)
│   ├── doc-extract.py               # 工具
│   ├── doc-lint.mjs                 # 工具
│   ├── packs-sync.sh                # 工具
│   ├── lesson-miner.mjs             # 工具
│   ├── patch-autocomplete-startswith.mjs  # pi-context (保留兼容)
│   ├── patch-footer-format.mjs      # pi-context (保留兼容)
│   ├── migrate-tool-events.sh       # 工具
│   ├── termux-prereq.sh             # 基础设施
│   ├── pi-source-build.sh           # 基础设施
│   ├── test-recovery.sh             # 基础设施
│   ├── tmux-fix.sh                  # pi-tmux (保留兼容)
│   ├── .pi-cli-path                 # 内部
│   └── README-pi-bg.md              # 文档
├── docs/                            # 不变
├── memory/                          # 不变 (pi-memory 运行时)
├── logs/                            # 不变 (运行时日志)
├── packs/                           # 不变 (技能包)
├── searxng/                         # 不变 (pi-web-search 运行时)
├── deploy/                          # 不变 (部署配置)
├── portable/                        # 不变 (Windows 移植)
├── .backup-baseline/                # 不变
├── README.md                        # 不变
├── CHANGELOG.md                     # 不变
├── .gitignore                       # 更新
├── .gitattributes                   # 不变
├── pi-link.json                     # 移入 pi-link/config/ (保留兼容)
├── pi-link-active.json              # 运行时 (保留兼容)
├── pi-link-outbox.json              # 运行时 (保留兼容)
└── pi-link-state.json               # 运行时 (保留兼容)
```

## 兼容策略

**使用符号链接保持向后兼容**:
- 移动文件后，在原位置创建 symlink 指向新位置
- `pi-wrapper.sh`、`rebuild.sh` 等脚本通过原路径仍可访问
- 给出 1 个版本的过渡期，之后删除 symlink

**不移动的文件**:
- `agent/lib/*` — 19+ 个 import 路径依赖相对路径，移动成本高收益低
- `agent/extensions/tsconfig.json` — 所有扩展共用
- `agent/extensions/tests/` — 跨扩展共用测试工具
- `memory/`, `logs/`, `searxng/`, `deploy/` — 运行时目录

## 迁移阶段

### Phase 1: 扩展专用配置文件归入扩展目录

| 文件 | 当前位置 | 目标位置 | 引用者 |
|------|----------|----------|--------|
| `pi-link.json` | `.pi/pi-link.json` | `extensions/pi-link/config/pi-link.json` | pi-link/config.ts |
| `.pi-autopilot-config.json` | `agent/` | `extensions/pi-autopilot/config/` (symlink) | pi-autopilot/config.ts, pi-wrapper.sh |
| `pi-voice.json` | `agent/` | `extensions/pi-voice/config/` (symlink) | pi-voice/config.ts |
| `notify.json` | `agent/` | `extensions/pi-autopilot/config/` (symlink) | pi-autopilot/notifications.ts |

### Phase 2: 扩展专用脚本归入扩展目录

在每个扩展内创建 `scripts/` 子目录，移动对应的 patch/脚本，原位置留 symlink。

| 脚本 | 目标扩展 |
|------|----------|
| `patch-compaction-warm-prefix.mjs` | pi-context |
| `patch-footer-*.mjs` (4个) | pi-context |
| `patch-fuzzy-match-type.mjs` | pi-context |
| `patch-tab-arg-completion.mjs` | pi-context |
| `patch-truncate-type.mjs` | pi-context |
| `patch-autocomplete-startswith.mjs` | pi-context |
| `patch-voice-enter.mjs` | pi-voice |
| `patch-playwright-core.mjs` | pi-browser |
| `patch-plan-tools.mjs` | plan-mode |
| `pi-whisper.sh`, `pi-sherpa*.py`, `whisper-server.py` | pi-voice |
| `pi-link-entry.sh`, `pi-link-keys.sh` | pi-link |
| `pi-bg.sh`, `tmux-fix.sh` | pi-tmux |
| `start-searxng.sh` | pi-web-search |
| `memory-lifecycle.mjs` | pi-memory |
| `knowledge-fetch.py` | pi-autopilot |
| `ntfy-relay.*`, `pi-notify.sh` | pi-autopilot |

### Phase 3: 运行时状态文件归入扩展目录

| 文件 | 当前位置 | 目标位置 |
|------|----------|----------|
| `.pi-autopilot-telemetry.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `.pi-autopilot-crash.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `.pi-autopilot-lastgood.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `.pi-admin-state.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `.notify-state.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `.pi-tmux-registry.json` | agent/ | extensions/pi-tmux/ (symlink) |
| `.usage-diag.jsonl` | agent/ | extensions/pi-context/ (symlink) |
| `pi-crash.log` | agent/ | 保留原位 (pi 核心) |
| `scheduled-seeds.json` | agent/ | 保留原位 (跨设备共用) |
| `scheduled-tasks.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `ntfy-relay.json` | agent/ | extensions/pi-autopilot/config/ (symlink) |
| `.ntfy-relay-state.json` | agent/ | extensions/pi-autopilot/ (symlink) |
| `.ntfy-relay.pid` | agent/ | extensions/pi-autopilot/ (symlink) |

### Phase 4: 整理 lib/ 共享模块

创建 `agent/lib/index.ts` 统一导出入口，方便后续扩展使用：
```ts
export * from './context-budget.ts'
export * from './prune.ts'
export * from './auto-compact.ts'
// ... 其余模块
```

### Phase 5: 更新所有引用路径

**需要更新的文件** (Phase 1-3 移动后):
- `pi-link/config.ts`: `pi-link.json` 路径
- `pi-voice/config.ts`: `pi-voice.json` 路径
- `pi-autopilot/config.ts`: `.pi-autopilot-config.json` 路径
- `pi-autopilot/notifications.ts`: `notify.json` 路径
- `pi-autopilot/state.ts`: 状态文件路径
- `pi-tmux/core.ts`: `.pi-tmux-registry.json` 路径
- `pi-context/index.ts`: `.usage-diag.jsonl` 路径
- `scripts/rebuild.sh`: 扩展路径引用
- `scripts/test-all.sh`: 扩展路径引用
- `scripts/pi-wrapper.sh`: 扩展路径引用

**Phase 2 脚本移动后**:
- `scripts/rebuild.sh`: patch 脚本路径
- `scripts/verify-patches.mjs`: patch 脚本路径
- 各扩展的 `rebuild.sh` 调用路径

### Phase 6: 验证

```bash
# 1. 全量测试
cd /root/.pi && bash scripts/test-all.sh

# 2. 类型检查
cd /root/.pi/agent/extensions && npx tsc --noEmit

# 3. 功能验证
pi /mode        # pi-mode
pi /schedule list  # pi-autopilot
pi /memory status  # pi-memory
pi /voice status   # pi-voice
```

### Phase 7: 更新文档

- 更新 `README.md` 目录结构图
- 更新 `AGENTS.md` 扩展说明
- 更新各扩展 `README.md` 中的路径引用

## 回滚机制

每个 Phase 完成后:
1. 运行测试验证
2. 如失败，执行回滚:
   ```bash
   cd /root/.pi
   git checkout -- .
   # 删除本 Phase 创建的 symlink
   ```
3. 回滚后继续修复，再重新执行

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| symlink 断裂 | 扩展加载失败 | Phase 内逐步验证 |
| 路径更新遗漏 | 运行时报错 | grep 全量扫描 + 测试 |
| pi-wrapper 找不到扩展 | 启动崩溃 | 保留原路径 symlink |
| lib/ 相对路径断裂 | 编译失败 | 不移动 lib/ 目录 |
| 脚本找不到 patch 文件 | 重建失败 | 原路径留 symlink |
