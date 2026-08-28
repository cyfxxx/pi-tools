---
name: pcb-design
description: PCB/硬件设计的 AI 辅助技能入口：KiCad 工具链路由、设计审查闭环契约、ERC/DRC/Gerber/EMC 检查命令速查，含上游技能包与 MCP server 目录。做原理图审查、PCB Layout 检查、制造交付、EMC 预合规时使用。
---

# pcb-design：PCB 硬件设计 AI 技能整合包

整合自 kicad-happy(MIT) 等上游的设计思想与公开文档描述，本文档为原创提炼。本包是**知识层**（路由 + 审查契约 + 命令速查），完整脚本级能力按需从上游获取（见 `references/upstream-catalog.md`）。

## 何时使用

- 审查 KiCad 工程：原理图/PCB/Gerber 分析、net 追踪、热分析
- 设计评审：需要"能下厂制造吗"的完整结论时
- EMC 预合规自查（FCC Part 15 / CISPR 32/25 / MIL-STD-461G 视角）
- BOM 与供应链：JLCPCB/PCBWay 下单检查、LCSC/Mouser/DigiKey 数据手册核验
- SPICE 验证模拟子电路（滤波器截止/分压比/运放增益/晶振负载电容）
- 选择 EDA 工具接入方式（CLI vs MCP）时

## 工具链路由

| 任务 | 首选 | 说明 |
|---|---|---|
| 工程解析 | KiCad 文件格式直接解析（.kicad_sch/.kicad_pcb 是 s-expression） | 不开 GUI 即可全量分析 |
| ERC/DRC 导出 | `kicad-cli sch erc` / `pcb drc` | 见 core-workflows |
| 制造输出检查 | Gerber+钻孔文件解析 | Fabrication outputs 存在才可查 |
| 实时驱动 EDA | MCP server（Altium 用 eda-agent，KiCad 用 IPC-API 类） | 见 specialized-tools |
| 电路编写 | SKiDL（Python 描述电路 → 生成网表/KiCad） | 适合版本化管理 |

## 设计审查契约（Design Review Contract）

**一次合格的设计审查 ≠ 跑一两个分析器后总结**。最低标准：

1. 对工程中存在的每一类文件，运行全部适用的分析器，并在报告中明确列出哪些跑了、哪些没跑
2. 声称"verified"前必须完成原始文件 + 数据手册交叉验证；只有一致性推断时明确标注 **consistency only**，禁用 "verified/confirmed/per datasheet"
3. 先甄别分析器误报（预期布局伪影），再升级为 blocker
4. 无法完成的步骤写成 review gap，不许静默跳过
5. 报告必备区块：verdict、blockers 表、验证依据、误报说明、未执行项及原因

### 最小审查清单

- [ ] 数据手册已同步或明确声明验证缺口（无 datasheet 时所有引脚级/电气结论降级为 consistency only）
- [ ] 原理图分析（连接性/取值/极性/去耦；时序/复位/时钟/端接/保护细分项 → design-review-checklists）
- [ ] PCB 全量分析（DRC + 连接图 + 走线宽度/间距 + 布局/布线量化约束 → design-review-checklists）
- [ ] 原理图↔PCB 交叉引用
- [ ] EMC 风险扫描（有 PCB 时）
- [ ] SPICE 子电路仿真（装了 ngspice/LTspice/Xyce 时）
- [ ] 热点估算（原理图+PCB JSON 齐备时）
- [ ] Gerber/钻孔分析（制造输出存在时；层集完整性对照 design-review-checklists §Gerber）
- [ ] DFM 生产/装配友好检查（Mark 点/测试点/元件方向/阴影效应，下单前适用 → design-review-checklists）
- [ ] 元件生命周期与温度审计（有网络且 MPN 覆盖允许时）
- [ ] 相对上次 review 的 delta 检查
- [ ] 关键器件原始文件抽查升级为完全验证

## 关键设计原则（提炼自上游精华）

1. **证据分级硬约束**：代码级(网表一致) ≠ 构建级(DRC 通过) ≠ 运行级(SPICE/实测)。数据手册缺失时整体降级并显式声明。
2. **风险分析器定位清醒**：EMC 检查是 risk analyzer 不是 compliance predictor——捕获约 70% 常见设计错误，把首板失效率从 ~50% 压到 ~20-30%，但不能替代实验室认证。汇报措辞要与此匹配。
3. **先同步 datasheet 再深审**：引脚级验证、去耦校验都依赖厂商规格；有 API key（DIGIKEY_CLIENT_ID 等）先抓手册。
4. **delta 审查**：每次 review 记录 findings 快照，下次对比增量而非全量重述。
5. **Flatpak 安装的 KiCad**：`kicad-cli` 不在 PATH，用 `flatpak run --command=kicad-cli org.kicad.KiCad <args>`。

## 快速命令速查

```bash
# ERC / DRC（KiCad 8+ CLI）
kicad-cli sch erc project.kicad_sch --severity-error --output erc.rpt
kicad-cli pcb drc project.kicad_pcb --severity-all --output drc.rpt

# 制造导出与自检
kicad-cli pcb export gerbers project.kicad_pcb -o fab/ --drill --glue
python3 -c "from gerbonara import LayerStack; ls=LayerStack.open('fab'); print(ls.graphic_boards())"  # gerbonara 解析

# 网表比对（原理图 ↔ PCB 一致性）
kicad-cli sch export netlist project.kicad_sch -o ref.net   # 再用 python 工具对比 .kicad_pcb 内网表

# SPICE 子电路快验（ngspice 批模式）
ngspice -b testbench.cir -o sim.log && grep -iE "fail|error" sim.log

# BOM 导出
kicad-cli sch export bom project.kicad_sch -o bom.csv --fields "Reference,Value,Footprint,MPN"
```

## 完整能力启用

```bash
# kicad-happy：11 个 skill（MIT），含全套分析脚本与 review 流水线
git clone https://github.com/aklofas/kicad-happy.git ~/.pi/packs/upstream/kicad-happy
```

详细目录：`references/upstream-catalog.md`
MCP 接入与 ML 布局等专用工具：`references/specialized-tools.md`
命令速查详解：`references/core-workflows.md`
布局/布线/数据手册/DFM 审查清单：`references/design-review-checklists.md`

## 许可与来源

提炼基于 [aklofas/kicad-happy](https://github.com/aklofas/kicad-happy)（MIT）、[nickkraakman/skidl-skills](https://github.com/nickkraakman/skidl-skills)（MIT）、[Seahan1/hardware-agency-agents](https://github.com/Seahan1/hardware-agency-agents)（MIT）的公开文档描述与设计思想，未复制受版权保护的代码或文本原文。

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（无则建；工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件正文并清条目。
