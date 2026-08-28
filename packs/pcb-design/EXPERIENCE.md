# pcb-design 经验沉淀（EXPERIENCE.md）

按 packs/README.md「经验沉淀机制」追加；条目 ≥3 条或用户要求时合并进 SKILL.md 正文后清档。环境必须标注，防跨设备误会。

## 2026-08-28 审查知识增量吸收（环境：无关，纯知识层变更）

- 来源：微信文章《从原理图到 PCB，硬件设计完整工作流程》（mp.weixin.qq.com/s/osE3qTAsBy_VcChHyLKaGw），八阶段工作流 + 量化检查项，与包内"工具路由+审查契约"定位互补
- 落地：新增 `references/design-review-checklists.md`（布局四步法/布线三步法+量化表/datasheet 六章节提取框架/原理图细分项/DFM 生产+装配两类/Gerber 层命名/BOM 字段）；SKILL.md 最小清单挂接 4 处
- 未纳入及理由：需求分析阶段（skidl-skills requirements-interviewer 已覆盖）、样板调试改版流程（越过包边界，归 embedded-dev）、商业仿真工具表 HyperLynx/Sigrity/CST/Icepak（本环境不可用，与 ngspice 快验定位不符）、术语中英对照表（对 AI 无增益）
- 许可纪律：公众号内容非 MIT，仅提炼事实性数值与检查项名称并重写表述，未复制原文文字与图示，与 SKILL.md"未复制原文"声明一致
