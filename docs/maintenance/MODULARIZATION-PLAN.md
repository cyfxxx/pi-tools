# 模块化整合方案

**日期**: 2026-09-07  
**更新**: 2026-09-09 分层架构重构  
**基线提交**: `17d3a99` (remove pi-webui extension)  
**状态**: 已完成 — Phase 1-7 已执行（2026-09-08/09-09）  
**目标**: 将 .pi 目录从"扁平散落"重构为"分层架构 + 功能内聚"

---

## 已完成项（2026-09-08/09-09）

### 第一阶段：扩展内聚（2026-09-08）

- ✅ Phase 1: 配置文件移入扩展目录（pi-link/config/、pi-voice/config/、pi-autopilot/config/）
- ✅ Phase 2: 脚本移入扩展目录（26个脚本 → extension/scripts/，symlink 到 scripts/）
- ✅ Phase 3: 运行时状态文件移入扩展目录（.notify-state.json、.pi-tmux-registry.json 等）
- ✅ Phase 4: lib/index.ts 统一导出
- ✅ Phase 5: 代码和文档中的路径引用更新
- ✅ symlink 修复：scripts/ 下25个断裂 symlink 相对路径修正
- ✅ pi-webui 移除、pi-source-cache 加入 .gitignore

### 第二阶段：分层架构重构（2026-09-09）

- ✅ Phase 1: 拆分 agent/lib/ → core/ + services/
  - core/ (Layer 0): config.ts, registry.ts, hook-registry.ts, secrets.ts, index.ts
  - services/ (Layer 1): token-budget/, diagnostics/, shadow-review.ts, note-store.ts
  - lib/ 保留为兼容层，重导出 core/ 和 services/
- ✅ Phase 2: 剩余脚本移入扩展目录（pi-cron.sh, task-metrics.mjs 等）
- ✅ Phase 3: 文档分类（docs/ → design/, development/, operations/, maintenance/）
- ✅ Phase 4: 运行时数据归组（memory/, logs/, plans/ → data/）
- ✅ Phase 5: .gitignore 更新 + 导入验证测试通过

---

## 分层架构设计（2026-09-09 确立）

### 五层单向依赖架构

```
Layer 4 ─ Agent 编排层 ─────── agent/agents/ agent/prompts/
    ↑
Layer 3 ─ 技能层 ───────────── agent/skills/ packs/
    ↑
Layer 2 ─ 扩展层 ───────────── agent/extensions/ (每个扩展独立)
    ↑
Layer 1 ─ 服务层 ───────────── agent/services/ (token-budget, diagnostics)
    ↑
Layer 0 ─ 基础层 ───────────── agent/core/ (config, registry, secrets)
```

### 依赖规则

1. **单向依赖**: Layer N 只能依赖 Layer N-1 及以下，底层不能依赖上层
2. **同层独立**: 同层模块之间禁止相互依赖
3. **扩展独立**: 12 个扩展之间禁止相互依赖

### 分层职责

| 层 | 目录 | 职责 | 包含模块 |
|----|------|------|----------|
| L0 基础层 | `agent/core/` | 零依赖的基础工具 | config, registry, hook-registry, secrets |
| L1 服务层 | `agent/services/` | 核心服务（仅依赖 L0） | token-budget, diagnostics, shadow-review, note-store |
| L2 扩展层 | `agent/extensions/` | 功能模块（依赖 L0+L1） | 12 个独立扩展 |
| L3 技能层 | `agent/skills/` + `packs/` | 用户技能（依赖 L0-L2） | 6 个内置技能 + 外部技能包 |
| L4 编排层 | `agent/agents/` + `agent/prompts/` | Agent 定义（依赖全部） | scout, worker, reviewer |

### 目录结构

```
.pi/
├── agent/
│   ├── core/                        # Layer 0: 基础层
│   │   ├── config.ts               # 配置加载/合并
│   │   ├── registry.ts             # 注册/清理统一封装
│   │   ├── hook-registry.ts        # 扩展钩子注册表
│   │   ├── secrets.ts              # 密钥脱敏工具
│   │   └── index.ts                # 统一导出
│   │
│   ├── services/                    # Layer 1: 服务层
│   │   ├── token-budget/           # Token 预算管理
│   │   │   ├── context-budget.ts
│   │   │   ├── prune.ts
│   │   │   ├── auto-compact.ts
│   │   │   ├── output-archive.ts
│   │   │   └── index.ts
│   │   ├── diagnostics/            # 诊断服务
│   │   │   ├── usage-diag.ts
│   │   │   ├── task-record.ts
│   │   │   └── index.ts
│   │   ├── shadow-review.ts        # 影子审查
│   │   ├── note-store.ts           # 笔记持久化
│   │   └── index.ts                # 统一导出
│   │
│   ├── extensions/                  # Layer 2: 扩展层
│   │   ├── pi-autopilot/           # 自主运行（定时任务+自管理+失败自愈）
│   │   ├── pi-browser/             # 浏览器自动化
│   │   ├── pi-context/             # Token 优化中枢
│   │   ├── pi-intervention/        # 干预捕获
│   │   ├── pi-link/                # 多设备互联
│   │   ├── pi-memory/              # 跨会话记忆
│   │   ├── pi-mode/                # 模式切换
│   │   ├── pi-tmux/                # tmux 会话管理
│   │   ├── pi-voice/               # 语音交流
│   │   ├── pi-web-search/          # 网络搜索
│   │   ├── plan-mode/              # 计划模式
│   │   └── subagent/               # 子代理
│   │
│   ├── skills/                      # Layer 3: 技能层
│   │   ├── pi-backup/
│   │   ├── pi-bug-diagnosis/
│   │   ├── pi-code-review/
│   │   ├── pi-full-audit/
│   │   ├── pi-repo-optimize/
│   │   └── pi-translate-zh/
│   │
│   ├── agents/                      # Layer 4: Agent 编排层
│   │   ├── scout.md
│   │   ├── worker.md
│   │   └── reviewer.md
│   │
│   ├── prompts/                     # Layer 4: Prompt 模板
│   ├── lib/                         # 兼容层（保留 2 周，2026-09-23 清理）
│   ├── sessions/                    # 运行时：会话
│   ├── stats/                       # 运行时：统计
│   └── node_modules/                # 依赖
│
├── packs/                           # 外部技能包
├── scripts/                         # 核心基础设施脚本
│   ├── rebuild.sh                   # 核心：一键重建
│   ├── test-all.sh                  # 核心：全量回归
│   ├── install/                     # 安装脚本
│   └── utils/                       # 工具脚本
│
├── data/                            # 运行时数据
│   ├── memory/                      # 记忆数据
│   ├── logs/                        # 日志
│   └── plans/                       # 计划存档
│
├── docs/                            # 文档
│   ├── design/                      # 设计文档
│   ├── development/                 # 开发文档
│   ├── operations/                  # 运维文档
│   └── maintenance/                 # 维护文档
│
├── deploy/                          # 部署配置
├── searxng/                         # SearXNG
├── portable/                        # Windows 便携
└── README.md
```

---

## 兼容策略

### 保留的兼容层

| 兼容层 | 位置 | 清理日期 | 说明 |
|--------|------|----------|------|
| lib/ 兼容层 | `agent/lib/index.ts` | 2026-09-23 | 重导出 core/ + services/ |
| scripts/ symlink | `scripts/patch-*.mjs` | 2026-09-23 | 指向扩展 scripts/ |
| scripts/ symlink | `scripts/pi-cron.sh` 等 | 2026-09-23 | 指向扩展 scripts/ |
| data/ symlink | `memory/` → `data/memory/` | 2026-09-23 | 保持旧路径可访问 |
| data/ symlink | `logs/` → `data/logs/` | 2026-09-23 | 保持旧路径可访问 |
| data/ symlink | `plans/` → `data/plans/` | 2026-09-23 | 保持旧路径可访问 |

### 清理计划

2026-09-23（2 周过渡期后）：
1. 删除 `agent/lib/` 兼容层目录
2. 删除 `scripts/` 中指向扩展 scripts/ 的 symlink
3. 确认所有代码引用新路径后，删除 data/ 顶层 symlink

---

## 模块化要求

1. **扩展自包含**: 每个扩展的配置、脚本、状态文件必须在 `extensions/<name>/` 下
   - 配置: `extensions/<name>/config/` 或 `extensions/<name>/*.json`
   - 脚本: `extensions/<name>/scripts/`
   - 状态: `extensions/<name>/.<name>-*.json`
   - 测试: `extensions/<name>/tests/`
   - 文档: `extensions/<name>/README.md`

2. **禁止散落**: 扩展文件不得出现在 `agent/` 根目录或 `scripts/` 根目录
   - 例外: `agent/settings.json`、`agent/modes.json` 等共用配置
   - 例外: `agent/AGENTS.md`、`agent/APPEND_SYSTEM.md` 等共用文档

3. **依赖方向**: 严格自下而上
   - core/ → services/ → extensions/ → skills/ → agents/
   - 同层模块之间禁止相互依赖

4. **导入规范**: 新代码应从 core/ 或 services/ 导入，不从 lib/ 导入

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| symlink 断裂 | 扩展加载失败 | 逐步验证，保留 2 周过渡期 |
| 路径更新遗漏 | 运行时报错 | grep 全量扫描 + 测试 |
| lib/ 兼容层清理过早 | 旧代码 import 失败 | 严格按日期清理 |
| rebuild.sh 路径断裂 | 重建失败 | symlink 保持兼容 |
| 扩展自动发现失败 | 扩展不加载 | 保持 extensions/ 结构不变 |

---

## 验证命令

```bash
# 1. 导入验证
cd /root/.pi && node --experimental-strip-types -e "
import { mergeLayers, scrubSecrets } from './agent/core/index.ts'
import { estimateTokens } from './agent/services/index.ts'
console.log('All imports OK')
"

# 2. 全量测试
bash scripts/test-all.sh

# 3. 类型检查
cd agent/extensions && npx tsc --noEmit

# 4. 功能验证
pi /mode
pi /schedule list
pi /memory status
pi /voice status
```
