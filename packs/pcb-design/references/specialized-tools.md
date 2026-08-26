# 专用工具索引（specialized tools）

PCB 方向调研中不并入通用技能的项目记录。

## ML/AI 布局布线（研究型）

| 项目 | Stars | 说明 |
|---|---|---|
| assalas/pcb-designer-ai-agent | ★113 | ML 驱动的元件布局与布线优化 |
| Corning-AI/PCBai | ★27 | 对话式工程生成与优化 PCB |
| VortexJer/AISight | ★10 | 面向 AI agent 的 3D CAD/PCB/着色器审查工具 |

不整合原因：自动布局布线尚处研究阶段，产出不可直接交付制造；实际 Layout 仍以人工+规则检查为主。有需求时单独评估。

## EDA 实时驱动 MCP

见 `upstream-catalog.md` §MCP server 类。均为独立 MCP server，按需在 pi 中注册使用，不入技能包：
- Altium 实时操作：salitronic/eda-agent（先备份工程，实验性）
- KiCad 9+ 官方通道：Finerestaurant/kicad-mcp-python（IPC-API）

## 角色提示词素材

Seahan1/hardware-agency-agents 的中文角色定义（SIPI 工程师/射频硬件工程师/DFM 工程师等）可在深度 review 时作为专家视角注入。路径：仓库 `hardware-agency-agents-cn/` 下按方向分目录，每角色一个 md。MIT 许可可自由引用。

## kicad-happy 内的场景专用 skill

依赖外部凭据或服务，按需启用而非默认激活：
- `digikey`/`mouser`/`lcsc`/`element14` — 各需对应 API key
- `jlcpcb`/`pcbway` — 仅下单前制造性检查时用
- GitHub Action 形态 — CI 化设计审查，需要仓库 workflow 权限
