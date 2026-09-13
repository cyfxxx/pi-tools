---
name: pi-full-audit
description: 全项目深度审计（区别于 code-review 的 diff 审查）：全量确定性检查 + 回归测试 + subagent 并行审查与复核 + 分级报告；含会话运行健康巡检（提示词注入/缓存命中/token 消耗/自动执行功能）。用户说"全面检查""深度审计""全项目审查""健康检查""体检""运行检查""会话检查""audit"时触发。不适用：仅审一次 git diff 用 pi-code-review；查询具体文件/单点问题用 grep/read。
version: v1.10
更新日期: 2026-09-12
经验基线: 见 references/EXPERIENCE-BASELINE.md
---

# pi-full-audit 全项目深度审计

对整个仓库（含扩展、脚本、技能）做一次完整审计，产出可信的分级报告。核心信条：**审查报告不可全信，建议清单必须经复核子代理逐条核实、主会话终审后才可执行**。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.10 |
| 更新日期 | 2026-09-12 |
| 适用场景 | 全项目深度审计、全面检查、健康检查 |
| 不适用 | 仅审一次 git diff（用 pi-code-review）；查询具体文件/单点问题（用 grep/read） |
| 依赖 | review.sh 脚本、subagent 扩展 |

---

## 工作流

```
准备 → 确定性检查 → 基线测试 → 并行深度审查 → 复核核实 → 终审报告 → 修复闭环
```

## 文档结构

- [WORKFLOW.md](WORKFLOW.md) — 详细步骤说明
- [REPORT.md](REPORT.md) — 分级报告模板

## 快速开始

```bash
# 1. 准备
git status -sb
bash ~/.pi/agent/skills/pi-code-review/review.sh --selfcheck

# 2. 确定性检查
bash ~/.pi/agent/skills/pi-code-review/review.sh --all ~/.pi

# 3. 基线测试
bash scripts/test/test-all.sh > /tmp/test.log 2>&1

# 4. 并行深度审查
# subagent 并行委派 4 组 scout

# 5. 复核核实
# subagent 并行委派复核子代理

# 6. 终审报告
# 主会话消费复核结论，产出分级报告

# 7. 修复闭环（用户要求时）
# 先列修复计划，用户批准后动手
```

---

## 约定

- **只读**：审计全程不改文件。用户要求修复时先列计划（第 6 步）。
- **复核必做**：任何建议清单（本技能产出或外部审查模型提供）进入修复前，必须经第 4 步复核子代理逐条核实。
- **敏感信息脱敏**：报告密钥只报位置。
- **报告与验证分离**：报告中每个 HIGH 明确标注"主会话已验证/复核核实/待验证"。

---

## 误报判别清单（外置）

> 20 条实战判别规则见 `agent/skills/pi-full-audit/references/ERROR-CHECKLIST.md`。遇到误报疑问（密钥扫描/git 排除/glob/编码等）先查该清单再定性。

---

## 会话运行检查 / 每日巡检（已外置）

> 运行态健康巡检（触发词：运行检查/会话检查/健康巡巡检）与每日快速巡检的完整清单见 `references/RUNTIME-CHECK.md`（按需加载）。

---

## 使用后改进（必做）

任务收尾时清点：执行过程与本文步骤/路径/结论的偏差。有 → 追加一条到 `improvements.md`（证据导向：命令、路径、现象，不直接改正文）。未合并条目 ≥3 条或用户要求时，合并进正文并清日志。机制全文见 `docs/SKILLS-MAINTENANCE.md`。
