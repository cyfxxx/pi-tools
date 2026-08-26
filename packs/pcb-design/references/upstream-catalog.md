# 上游技能包与 MCP 目录（upstream catalog）

PCB 设计方向调研所得，检索时间：2026-08。

## 技能包类（可直接挂给 AI 助手）

### aklofas/kicad-happy（MIT）⭐ 首选

仓库：<https://github.com/aklofas/kicad-happy> · ★1017 · Python · 11 个 skill · Claude Code/Codex 插件 + GitHub Action 形态

| Skill | 功能 | 本包映射 |
|---|---|---|
| `kicad` | 原理图/PCB/Gerber 解析、net 追踪、交叉分析、热估算、what-if 扫描、深度 review 流水线（schema+prompts+gate 脚本）、OSHWA 认证参考、PDF 原理图提取 | 审查契约 + 最小清单 |
| `emc` | 18 检查类 44 规则：地平面/去耦/I/O 滤波/时钟/差分对/PDN 阻抗/回流路径/串扰/ESD；输出 FCC/CISPR 预合规测试计划 | 设计原则 #2 |
| `spice` | 子电路自动测试台生成（ngspice/LTspice/Xyce 自检测）：滤波频率/分压比/运放增益/LC 谐振/晶振负载电容 | core-workflows §SPICE |
| `bom` / `datasheets` | BOM 管理、数据手册库同步 | 设计原则 #3 |
| `jlcpcb` / `pcbway` | 下单前制造性检查 | 未映射（下单时用） |
| `lcsc` / `mouser` / `digikey` / `element14` | 四渠道数据手册/API 抓取 | 未映射（按库存选） |

脚本资产：sexp_parser（KiCad 文件解析底座）、analyze_schematic/pcb/gerbers/thermal/emc、cross_analysis、deep_review_gate 等 50+ Python 脚本。

### nickkraakman/skidl-skills（MIT）

仓库：<https://github.com/nickkraakman/skidl-skills> · ★17 · SKiDL 多 agent 工作流

9 个 agent 定义：orchestrator / requirements-interviewer（需求访谈）/ circuit-architect（架构）/ datasheet-librarian / part-sourcer（选型）/ skidl-coder ×2 / skidl-assembler / erc-reviewer。附 rules/（SKiDL 语法/封装/工程布局）与 scripts/（设计规则与封装生成校验）。
定位："代码即原理图"，电路可 diff 可 review 可版本化。适合从零起步的新设计；改现有 KiCad 工程不适用。

### Seahan1/hardware-agency-agents（MIT）

仓库：<https://github.com/Seahan1/hardware-agency-agents> · ★10 · 中文角色提示词集（cn/en 双语）

8 方向角色库：PCB 与板级实现（Layout/封装库/SIPI/射频/DFA/DFM/工艺/高速）、可靠性 EMC 安规、电源功率电子、数模混合、嵌入式硬件、测试验证、通信接口、芯片平台协同。每角色一个 md（职责/审查视角/输出格式）。
定位：review 时切换专家视角的提示词素材，无脚本工具。

## MCP server 类（连接 EDA 软件）

| 项目 | Stars | 后端 | 说明 |
|---|---|---|---|
| salitronic/eda-agent | ★161 | Altium(主)/KiCad/EasyEDA | 实时会话驱动 ~400 工具，AI 直接读写打开中的设计；DelphiScript 桥；实验性，可能崩溃 Altium 引擎 |
| Seeed-Studio/kicad-mcp-server | ★86 | KiCad | 系统厂商出品，引脚级连接追踪、设计编辑 |
| oaslananka/kicad-mcp-pro | ★60 | KiCad | ERC/DRC/DFM/BOM/制造审查自动化 |
| Finerestaurant/kicad-mcp-python | ★40 | KiCad 9 | 基于**官方 IPC-API**（最正规通道） |
| circuit-synth/mcp-kicad-sch-api | ★20 | KiCad | 原理图操作专用 |
| mixelpixx/KiCAD-MCP-Server | ★1956 | KiCad | 星数最高的社区实现，质量未甄别 |

选型建议：KiCad 9+ 优先官方 IPC-API 类；Altium 重度用户选 eda-agent（先备份）；其余场景 CLI 解析（kicad-happy 路线）已覆盖大部分需求且更稳。

## 其他同类项目（备查）

| 项目 | Stars | 定位 |
|---|---|---|
| piyushbag/awesome-pcb-workflow | ★13 | PCB 全流程开源工具清单（EDA/SPICE/布局） |
| yymqd/kicad-pcb-agent-skills | ★0 | 中文 KiCad 三管线（kicad-cli/MCP/kcaa）阶段切换工作流 |

## 与 packs/embedded-dev 的边界

本包管"板子造出来之前"（原理图→Layout→审查→制造交付），embedded-dev 管"板子造出来之后"（固件构建烧录调试）。两包在"硬件验证"处衔接：PCB 侧的 Gerber/DFM 结论是 embedded-dev 烧录调试的前置条件。
