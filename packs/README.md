# packs：统一外部技能仓库

把"成功实现、可复现、有保存价值"的长任务沉淀为可复用技能包。**packs 是唯一的外部技能仓库**（2026-08 起并入原 skill-store）。

## 目录结构

```
packs/
├── drafts/     # 草稿（scripts/task-summarizer.mjs 自动生成，待人工确认）
├── <name>/     # 已确认技能包：SKILL.md 入口 + bin/lib/references/workflows 等资源
└── README.md   # 本说明
```

约定：
- **不再有 active/ 中间态**：草稿确认后直接在 `packs/` 下建 `<name>/` 包（含 SKILL.md）；未确认的留在 `drafts/`
- **同类型合并**：确认草稿时若 packs 已有同类型技能 → 合并/优化进现有包，不另立新包（例：colab-cli 草稿并入 colab-bridge；comfyui-agent 旧稿并入 comfyui-agent 包），合并后删草稿
- drafts 草稿文件名 `<短名>.SKILL.md`，YAML frontmatter：name/description（1-2 句、不带时间戳，缓存友好）

## 流程

1. **生成**：`scripts/task-summarizer.mjs` 批量总结任务，识别"成功实现+可复现+有保存价值"的长任务 → 写 SKILL.md 草稿到 `packs/drafts/`
2. **确认**：人工审阅草稿（name/description/步骤准确、可复现、无时间戳），确认后在 `packs/` 建包；不合格删除
3. **激活**：packs 不入 `agent/skills/`（防系统提示词膨胀），需要时按需启用（/skill 或手动引用 SKILL.md）
4. **清理**：长期未激活的包定期归档删除

## 防膨胀守则

- 草稿进 drafts 前由脚本标注"建议"，未确认不建包
- description 控制 1-2 句、不含时间戳（缓存友好）
- 同时激活的外部技能保持少量（≤3），其余按需临时启用

## 当前包

| 包 | 用途 |
|---|---|
| `comfyui-agent/` | ComfyUI 出图/工作流管理（CLI `bin/comfyui`，9 个内置 API 模板，`references/WORKFLOWS.md` 实例实测文档） |
| `colab-bridge/` | Colab（免费 GPU）远程执行：自研桥 `bin/colab_exec`（备胎）+ 官方 google-colab-cli 方案（首选，`references/colab-cli.md`） |
| `gamedev/` | 游戏开发技能组（skills/design、web、workflow） |
| `reverse-skill/` | 逆向/CTF 技能包（含 burp-mcp 等） |
| `dg-piagent/` | pi-agent SDK 开发助手（教程同步维护，API 基线 v0.83.0，含 sdk_doc/场景 references） |
| `mattpocock-skills/` | 外部工程技能包（收纳 mattpocock/skills @5b15a47，MIT）：8 技能（grilling/tdd/prototype/research/setup-pre-commit/writing-for-agents/resolving-merge-conflicts/codebase-design），原文不动按需引用 |
| `novel-writing/` | 长篇网文工程化写作系统：六大协议（大纲/规划目录/草案/正文/体检/存档）+ 一致性/叙事/输出条例 + 文风溯源/去AI指纹 + 50章分批/事实锁/状态回证/伏笔追踪/双重审查。整合 tianming-skill 等 3 个开源仓库并优化（CC BY-NC-SA 4.0，来源见包内 README） |
| `embedded-dev/` | 嵌入式/MCU 开发 AI 技能入口：构建/烧录/调试/串口/协议领域路由 + 开源工具链命令速查 + 执行闭环（证据驱动）。整合 embeddedskills(MIT) 与 embed-ai-tool(无LICENSE仅引用) 的通用能力；专用工具（llm-pid-tuner/garycli/on-MCU agent 等）记录在 references/specialized-tools.md |
| `pcb-design/` | PCB/硬件设计 AI 技能入口：KiCad 工具链路由 + 设计审查契约（最小清单/证据分级）+ ERC/DRC/Gerber/SPICE/EMC 命令速查。提炼 kicad-happy(MIT)/skidl-skills(MIT)/hardware-agency-agents(MIT)；MCP server 与 ML 布局记录在 references/specialized-tools.md |

## 与 pi-backup 的关系

packs 入库 Git（/root/.pi 仓库），随 pi-backup 同步，不依赖本机单独备份。