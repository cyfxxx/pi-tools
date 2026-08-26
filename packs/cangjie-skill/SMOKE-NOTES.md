# 冒烟验证结果（阶段 1 提取 → 阶段 1.5 三重验证）

候选池：3 条（framework×2、principle×1）

## f01 双轨记录法（事实轨/判断轨分离） — 通过
V1_cross_domain:
  passed: true
  evidence:
    - 第 3 章：个人复盘场景（防后见之明污染）
    - 第 5 章：团队复盘场景（主持人沉默规则+分收事实）
    - 第 9 章：反例场景（混写日记三个月后不可辨）
V2_predictive_power:
  passed: true
  novel_question: "AI agent 会话审计如何防止事后总结美化当时误判？"
  derived_answer: "先只读原始工具调用流水（事实轨）形成独立时间线，再隔离读取当时的推理文本（判断轨），对比两者偏差量化自欺程度"
V3_exclusivity:
  passed: true
  why_not_common: "常识是'回顾要客观'；本单元给出的是可操作隔离机制——物理分离两类记录+收集完成前禁止评价的流程约束"
→ 进入阶段 2

## r01 "要及时复盘" — 拒绝
V3_exclusivity: failed
reason: 任何聪明人都会说的常识，无 skill 承载价值

## r02 "主持人先不评价"（单语境金句） — 拒绝降级 example
V1_cross_domain: failed
reason: 仅第 5 章出现一次，无书内独立佐证；作为 f01 团队场景的操作细节并入，不独立成 skill

统计：通过率 1/3 ≈ 33%，落在文档预期区间（25-50%）

## 冒烟结论（2026-08-26，pi 环境实测）

- 阶段 1 提取 + 阶段 1.5 三重验证在短样本（9 章 3 段模拟讲义）上自洽可跑：3 候选 → 1 通过 / 2 拒绝（V3 常识淘汰、V1 单语境降级），通过率 33% 落在文档预期 25-50% 区间
- templates/SKILL.md.template 渲染校验：frontmatter 六键齐备（name/description/source_book/source_chapter/tags/related_skills），R/I/A1/A2/E/B 六维段落完整
- 宿主差异：阶段 5 安装路径 ~/.claude/skills/ 在 pi 下按包内 README 的产物落点约定执行
