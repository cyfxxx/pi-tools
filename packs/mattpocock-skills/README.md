# mattpocock-skills：外部工程技能包（收纳自 Matt Pocock）

来源：[mattpocock/skills](https://github.com/mattpocock/skills)（MIT License）
克隆基线：`5b15a47`（2026-08-21）。**原文不动**，只做收纳与注记；后续上游更新时对照此基线审查是否有值得吸收的改动。

## 收录清单（8 技能，低频/场景化，需要时按需引用）

| 技能 | 行数 | 一句话 | 使用场景 |
|---|---|---|---|
| `grilling/` | 28 | 设计树逐轮拷问：每轮问整个 frontier（编号+推荐答案），事实自己查、决策交给用户 | 大方案/架构决定打磨，与"先给方案再确认"风格互补 |
| `tdd/` | 38 | 测试驱动开发纪律（红灯→绿灯→重构的工作流细节） | 用户要"test-first"做功能/修 bug 时 |
| `prototype/` | 26 | 一次性原型回答设计问题，验证后丢弃 | 想"先验证一下可行性"时 |
| `research/` | 12 | 高可信一手来源调研 → 沉淀 markdown 记录 | 需要正式调研结论落盘时 |
| `setup-pre-commit/` | 91 | Husky + lint-staged + 类型检查 + 测试的提交门禁配置 | 给仓库加提交门禁（.pi 仓库可参考做轻量版） |
| `writing-for-agents/` | 81 | 为 agent 写文档的规范（信息层级/完成标准/剪枝） | 写/改 SKILL.md、AGENTS.md、扩展 README 时 |
| `resolving-merge-conflicts/` | 14 | git merge/rebase 冲突的分步解决纪律 | .pi 多机同步冲突、任何 merge 冲突 |
| `codebase-design/` | 114 | 深模块设计共享词汇（John Ousterhout 风格） | 讨论模块边界/架构改进时 |

## 未收录（评估结论）

- **diagnosing-bugs** → 已改编为本地技能 `agent/skills/pi-bug-diagnosis`（6 阶段 + pi 环境适配），此处不重复收录
- **code-review** → 双轴法（Standards/Spec）已合并进本地技能 `agent/skills/pi-code-review`
- 不适用：to-spec/to-tickets/wayfinder/triage（依赖 issue 工作流）、wizard/teach/to-questionnaire/scaffold-exercises/migrate-to-shoehorn（场景不符）、写作三件套（writing-beats/fragments/shape）、wait-what（一次性指令）、git-guardrails（Claude Code hooks 专有）、in-progress/ 与 deprecated/（未成熟）、ask-matt/setup-*（仓库内部路由）、grill-me（grilling 的跳板）、handoff/claude-handoff（会话交接，pi 有 memory 摘要机制）

## 使用方式

需要某技能时按 packs 约定按需启用：引用 `packs/mattpocock-skills/skills/<name>/SKILL.md` 执行其流程（packs 不注入系统提示词）。