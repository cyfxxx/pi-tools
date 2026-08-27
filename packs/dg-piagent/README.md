# dg-piagent — pi-agent SDK 开发助手

pi（@earendil-works/pi-coding-agent）SDK 二次开发的辅助技能：编写扩展、修改系统提示词、管理会话、配置模型、处理认证、加载 skills/prompts/context 文件。

- **入口**：`SKILL.md`（基线 API 版本 v0.83.0，本机注记见文件头）
- **结构**：`references/project-structure.md`（源码导航）+ `references/scenarios/`（A01~ 场景文档）+ `references/source-fallback.md`（兜底检索）
- **维护**：使用后偏差按仓库级 `docs/SKILLS-MAINTENANCE.md` 机制记录到 `improvements.md`（本包已有）；升级即更新流程见 SKILL.md 第 3 步
- **环境备注**：本环境为 termux-ubuntu（proot-Distro aarch64，Android 宿主 proot 容器，uname 含 PRoot）；当前 pi 0.84.2 > 基线 0.83.0，涉及本机实际 SDK 使用以本机 dist/**/*.d.ts 为准
