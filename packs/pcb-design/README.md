# pcb-design — PCB/硬件设计 AI 技能包

PCB 设计领域地图：KiCad 工具链路由、设计审查闭环契约、ERC/DRC/Gerber/EMC 检查命令速查。

- **入口**：`SKILL.md`（路由 + 审查契约 + 命令速查）
- **性质**：知识层原创提炼包（整合 kicad-happy(MIT)/skidl-skills(MIT)/hardware-agency-agents(MIT) 设计思想）；完整脚本级能力按需从上游获取（`references/upstream-catalog.md`）；MCP server 与 ML 布局记录在 `references/specialized-tools.md`
- **维护**：使用后偏差按仓库级 `docs/SKILLS-MAINTENANCE.md` 机制沉淀；经验追加包根 `EXPERIENCE.md`
- **环境备注**：本环境为 termux-ubuntu（proot-Distro aarch64，Android 宿主 proot 容器）；KiCad 需 GUI/重型依赖，按需启用，见 SKILL.md 执行纪律
