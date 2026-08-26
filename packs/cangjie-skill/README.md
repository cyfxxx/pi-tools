# cangjie-skill（外部收纳）

把书籍/长视频转写/播客/课程/访谈等长内容蒸馏成一组原子化、可执行 Agent Skills 的**元技能**。

- **来源**: [kangarooking/cangjie-skill](https://github.com/kangarooking/cangjie-skill) @ 5f03a4c（v2.0.0）
- **许可**: MIT（见 LICENSE，原文收纳）
- **收纳范围**: SKILL.md + methodology/（8 阶段）+ extractors/（5 提取器）+ templates/（5 模板）。排除上游 assets/、.github/、star-history 脚本（与技能功能无关）

## 在 pi 中使用

- **触发**: 用户要求"拆书 / 蒸馏一本书 / 把 XX 书(视频/播客)做成 skill"时，读本 SKILL.md 按 RIA-TV++ 管线执行
- **产物落点**: 上游默认装到 `~/.claude/skills/`；pi 下建议蒸馏产物先落 `packs/drafts/` 走确认流程，确认后按 packs 防膨胀守则决定是否入 `agent/skills/`（同时激活的外部技能 ≤3）
- **原文不动**: methodology/extractors/templates 未做修改；安装路径等宿主差异以上一条为准

## 与 pi 升格通道的关系

本包的三重验证门槛（≥2 独立出处 / 能答新问题 / 非常识独特性）与压力测试（诱饵题+跨技能混淆题）已提炼进 `drafts/external-skill-pack-integration.SKILL.md` 的验收规范，作为会话产出→SKILL 草稿→packs 单向升格通道的准入标准。
