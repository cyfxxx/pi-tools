# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。

## 目录结构

```
agent/
  core/           Layer 0 基础层（config, registry, hook-registry, secrets）
  services/       Layer 1 服务层（token-budget, diagnostics, shadow-review, note-store）
  extensions/     Layer 2 扩展层（12 个独立扩展）
  skills/         Layer 3 技能层（6 个内置技能）
  agents/         Layer 4 Agent 编排层（scout, worker, reviewer）
  prompts/        Layer 4 Prompt 模板
  lib/            兼容层（2026-09-23 清理）
packs/            外部技能包
scripts/          核心基础设施脚本
data/             运行时数据（memory/logs/plans）
docs/             文档（design/development/operations/maintenance）
deploy/           部署配置
searxng/          自托管搜索
```

## 分层架构

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

**依赖规则**：单向（下层不能依赖上层）+ 同层独立（扩展之间禁止相互依赖）

## 多环境

本仓库在 Termux/Android、WSL2、Linux 等环境间同步。**配置层每环境独立**，不跨机覆盖。

| 规则 | 说明 |
|------|------|
| 配置隔离 | settings.json/models.json/auth.json 每环境独立 |
| 共享配置 | .pi-autopilot-config.json 入库共享（无密钥） |
| 记忆过滤 | entries.json 带 environments 字段，注入/检索按当前环境过滤 |
| 运行时隔离 | notes/summaries/checkpoints/sessions/logs 不入库 |

环境差异详情：`docs/operations/ENVIRONMENTS.md`

## 关键约定

### 扩展注册
pi 0.83+ 自动发现 `extensions/` 下含 index.ts 的子目录。settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制包含 / `-` 强制排除）。

新扩展须同步：目录 index.ts、extensions/tsconfig.json include、conflict-check.mjs 监听者清单、extensions.test.ts

### 缓存友好（跨扩展）
- system prompt 注入禁止时间戳/精确数值
- 压力提示按档位（<75% 不注入、≥75%/≥90% 固定文案）
- 估算统一用 `services/token-budget/` 的 estimateTokens

缓存治理详情：`docs/development/AGENTS-DETAILS.md` → 缓存治理

### 后台任务（禁止阻塞前台）
tmux_run 启动后**立即结束回合**。同轮内禁止 tmux_wait；确需等待只用 pattern= 匹配且 timeout≤60s。

后台任务详情：`scripts/README-pi-bg.md`

### git push
remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL。勿提交 auth.json/settings.json/models.json。

## 验证

```bash
bash scripts/test-all.sh          # 全量回归
bash scripts/test-all.sh --only=<ext1>,<ext2>  # 分层快检
bash scripts/test-all.sh --fast   # 快速模式
```

回归细节：`docs/development/AGENTS-DETAILS.md` → 回归验证细节

## 深度文档

| 主题 | 文档 |
|------|------|
| 扩展清单与目录详情 | `docs/development/AGENTS-DETAILS.md` |
| 扩展开发规范 | `docs/development/PI-EXT-DEV-NOTES.md` |
| SDK 扩展开发 | `docs/development/PI-SDK-EXTENSION.md` |
| 多环境差异 | `docs/operations/ENVIRONMENTS.md` |
| Termux 开发 | `docs/operations/TERMUX-DEV-NOTES.md` |
| 项目愿景与进化 | `docs/design/VISION.md` |
| 执行跟踪 | `docs/design/SELF-OPTIMIZING-ROADMAP.md` |
| 模块化方案 | `docs/maintenance/MODULARIZATION-PLAN.md` |
| Pi 官方文档 | https://pi.dev/docs/latest |
| 扩展开发经验 | `extensions/pi-mode/LESSONS-LEARNED.md` |
| 自动修复系统 | `scripts/README-recovery.md`（wrapper 只分类/启动，修复由 pi 自身完成） |

## 已知噪音

pi-voice 回车键冲突警告属设计行为，无需处理。详见 `docs/development/AGENTS-DETAILS.md` → 已知噪音

## 旧名称（禁止引用）

旧扩展名：pi-web-toolkit / pi-router / pi-admin / pi-scheduler
旧命令名：/tts、/planclear、/planresume、/planview、/todos、/auto:*、/admin:restart
