---
name: pi-full-audit
description: 项目全面检查（模块化）：代码审查 / 仓库优化 / 确定性检查 / 运行态巡检 / 深度并行审查，可全部执行或按需单选。用户说"全面检查""深度审计""审查""review""仓库优化""结构优化""仓库卫生""运行检查""体检""audit"时触发。
version: v2.0
更新日期: 2026-09-14
经验基线: 见 references/EXPERIENCE-BASELINE.md
---

# pi-full-audit 项目全面检查

对项目做完整检查，产出可信的分级报告。**审查报告不可全信，建议清单必须经复核子代理逐条核实、主会话终审后才可执行**。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v2.0 |
| 适用场景 | 全面检查、深度审计、代码审查、仓库优化、运行检查 |
| 依赖 | review.sh 脚本、subagent 扩展 |

---

## 模块化路由

根据用户意图选择执行范围：

| 用户说 | 跑哪些模块 | 说明 |
|--------|-----------|------|
| "全面检查""深度审计""体检" | A+B+C+D+E | 完整 6 步流程 |
| "审查""review""看下改动""PR 审查" | A+C | 代码审查 + 确定性检查 |
| "仓库优化""结构优化""仓库卫生""存储清理" | B | 仓库优化摸底+执行 |
| "运行检查""会话检查""健康巡检" | D | 运行态健康巡检 |
| "快速检查""查一下" | C+A | 确定性检查 + 代码审查（跳过深度并行） |

### 模块说明

| 模块 | 内容 | 详细步骤 |
|------|------|----------|
| **A. 代码审查** | 审查 git 变更：diff/HEAD/未跟踪，确定性检查 + 清单核对 + 分级报告 | [MODULES.md §A](MODULES.md#a-代码审查) |
| **B. 仓库优化** | 目录结构、文件存储、架构层面摸底分析与分级优化执行 | [MODULES.md §B](MODULES.md#b-仓库优化) |
| **C. 确定性检查** | review.sh 自动化：git 卫生、语法检查、可疑模式 | [MODULES.md §C](MODULES.md#c-确定性检查) |
| **D. 运行态巡检** | 提示词注入/缓存命中/token 消耗/自动执行功能 | [references/RUNTIME-CHECK.md](references/RUNTIME-CHECK.md) |
| **E. 深度并行审查** | subagent 并行委派 scout 分组审查 + 复核核实 | [MODULES.md §E](MODULES.md#e-深度并行审查) |

---

## 完整流程（A+B+C+D+E）

```
准备 → 确定性检查(C) → 基线测试 → 并行深度审查(E) → 复核核实 → 终审报告 → 修复闭环
```

### 快速开始

```bash
# 1. 准备
git status -sb
bash ~/.pi/agent/skills/pi-full-audit/../pi-code-review/review.sh --selfcheck

# 2. 确定性检查
bash ~/.pi/agent/skills/pi-full-audit/review.sh --all ~/.pi

# 3. 基线测试
bash scripts/test/test-all.sh > /tmp/test.log 2>&1

# 4. 并行深度审查（subagent 委派 4 组 scout）

# 5. 复核核实（subagent 并行委派复核子代理）

# 6. 终审报告（主会话消费复核结论，产出分级报告）

# 7. 修复闭环（用户要求时：先列计划，批准后动手）
```

---

## 文档结构

| 文件 | 内容 |
|------|------|
| [MODULES.md](MODULES.md) | 各模块详细步骤（代码审查/仓库优化/确定性检查/深度并行审查） |
| [WORKFLOW.md](WORKFLOW.md) | 完整 6 步流程详细说明 |
| [CHECKLIST.md](CHECKLIST.md) | 代码审查人工清单 + 仓库优化清单 |
| [REPORT.md](REPORT.md) | 分级报告模板 |
| [references/RUNTIME-CHECK.md](references/RUNTIME-CHECK.md) | 运行态巡检清单（按需加载） |
| [references/ERROR-CHECKLIST.md](references/ERROR-CHECKLIST.md) | 20 条误报判别规则 |
| [references/EXPERIENCE-BASELINE.md](references/EXPERIENCE-BASELINE.md) | 历次审计经验沉淀 |

---

## 约定

- **只读**：审计全程不改文件。用户要求修复时先列计划（第 6 步）。
- **复核必做**：任何建议清单进入修复前，必须经复核子代理逐条核实。
- **敏感信息脱敏**：报告密钥只报位置。
- **报告与验证分离**：每个 HIGH 明确标注"主会话已验证/复核核实/待验证"。

---

## 误报判别清单（外置）

> 20 条实战判别规则见 `references/ERROR-CHECKLIST.md`。遇到误报疑问先查该清单再定性。

---

## 会话运行检查 / 每日巡检（已外置）

> 运行态健康巡检与每日快速巡检的完整清单见 `references/RUNTIME-CHECK.md`（按需加载）。

---

## 使用后改进（必做）

任务收尾时清点：执行过程与本文步骤/路径/结论的偏差。有 → 追加一条到 `improvements.md`（证据导向：命令、路径、现象，不直接改正文）。未合并条目 ≥3 条或用户要求时，合并进正文并清日志。机制全文见 `docs/SKILLS-MAINTENANCE.md`。
