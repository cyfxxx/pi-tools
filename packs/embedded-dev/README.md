# embedded-dev — 嵌入式/MCU 开发 AI 技能包

嵌入式开发领域地图与工具链路由：构建、烧录、调试、串口、协议测试。

- **入口**：`SKILL.md`（领域路由 + 决策原则 + 命令速查）
- **性质**：知识层整合包（整合 embeddedskills(MIT) 与 embed-ai-tool 的通用能力）；完整可执行脚本按需从上游获取，来源与清单见 `references/upstream-catalog.md`；专用工具（llm-pid-tuner/garycli/on-MCU agent 等）记录在 `references/specialized-tools.md`
- **维护**：使用后偏差按仓库级 `docs/SKILLS-MAINTENANCE.md` 机制沉淀；经验追加包根 `EXPERIENCE.md`
- **环境备注**：本环境为 termux-ubuntu（proot-Distro aarch64，Android 宿主 proot 容器）；烧录/串口工具需按目标板与宿主环境确认（proot 内 USB 直通受限，见 SKILL.md 执行纪律）
