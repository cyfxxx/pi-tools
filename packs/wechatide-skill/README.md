# wechatide-skill — 微信开发者工具 agent 技能包

通过官方 `wechatide` CLI 驱动微信开发者工具：安装/编译/预览/上传/自动化调试/云开发。外部收纳自 skillhub（v0.3.9）。

- **入口**：`SKILL.md`（9 个 scene 子技能路由 + 工具索引）
- **结构**：`skills/`（automator/compiler/debugger/previewer 等 9 子技能）+ `wechatide-tools/references/`（tools.yaml 注册表 + 错误指南）+ `skill.yaml`
- **依赖**：`wechatide` CLI 需 Windows/macOS 侧运行（WSL 走 interop）；本机实测笔记见 `LOCAL-NOTES.md`
- **维护**：使用后偏差按仓库级 `docs/SKILLS-MAINTENANCE.md` 机制沉淀；经验追加包根 `EXPERIENCE.md`
- **环境备注**：本环境为 termux-ubuntu（proot-Distro aarch64，Android 宿主 proot 容器）——**无法直接运行 wechatide CLI**（需 Windows/macOS/WSL），仅作技能文档与远程协作参考
