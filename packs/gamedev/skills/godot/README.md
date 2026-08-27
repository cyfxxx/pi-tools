# Godot 技能组（skills/godot）

Godot 4.x 引擎开发技能，15 个，覆盖 GDScript/C#、场景节点、物理、2D/3D、UI、动画、Shader、音频、多人、资源、TileMap、导出管线。

## 来源与更新

- 上游：`gamedev-skills/awesome-gamedev-agent-skills`（MIT）的 `skills/godot/` 目录
- 基线：Godot 4.7（VERSION-SUPPORT.md 每季度复核；已有项目按 project.godot 声明的版本，不强制升级）
- 更新方法：同包顶层 README.md（增量重拉 tarball 后 `cp -r awesome-gds/skills/godot/* skills/godot/`）
- 版本纪律（上游规则，沿用）：先读 project `project.godot` 的 config_version 与 features 确定大版本；禁止混用 3.x/4.x API 片段；迁移先读官方迁移指南

## 路由速查

| 任务 | 技能 |
|---|---|
| 写/改 GDScript（类型标注/节点生命周期/信号/await） | godot-gdscript |
| 场景树/节点组织/实例化 | godot-nodes-scenes |
| 信号与分组（解耦通信） | godot-signals-groups |
| 2D 角色移动（物理与输入） | godot-2d-movement |
| 3D 基础（相机/灯光/碰撞） | godot-3d-essentials |
| 物理（刚体/面积/关节/CCD） | godot-physics |
| TileMap 关卡搭建 | godot-tilemap |
| UI（Control/容器/主题） | godot-ui-control |
| 动画（AnimationPlayer/Tween） | godot-animation |
| 音频（Bus/流/3D 定位） | godot-audio |
| 着色器（VisualShader/GDShader） | godot-shaders |
| 资源（class_name/@export/.tres 保存加载） | godot-resources |
| C#（.NET 项目） | godot-csharp |
| 多人/网络同步 | godot-multiplayer |
| 导出（presets/CI/Web COOP/COEP/headless） | godot-export |

## 与包内其他组的关系

- design/**（game-feel、physics-tuning、input-systems、save-systems 等）：引擎无关学科，Godot 项目同样适用
- workflow/**（prototype-fast、game-jam）：流程通用
- web/** 是浏览器引擎（Phaser/Pixi/Three），Godot 是完整引擎（可导出 Web/WASM）；两类项目路由按用户明确的技术栈选择

## 本机环境备注（2026-06 实测更新）

- Godot 4.7.2 stable 官方 arm64 已装于本机：`/opt/godot-4.7.2/`，`godot` 命令可用（proot-Ubuntu aarch64 实测通过 `--version`/`--headless --script` 冒烟）
- 获取途径：Godot 官网 CDN（Hetzner ObjectStorage）可达；GitHub release/TuxFamily 被阻断。下载模板：`https://godot-releases.nbg1.your-objectstorage.com/<版本>-stable/<文件名>`（listing 页见 downloads.godotengine.org）
- 验证约定：`godot --headless --script <test.gd>`（SceneTree 脚本冒烟）/ `godot --headless --check-only <项目>`（脚本语法检查）；渲染类需要 `--headless` 配合 dummy 显示驱动或截图验证
- 导出验证：导出模板（export templates）需从官网 CDN 另下；桌面导出需系统依赖（构建工具链），Web 导出需 Web 模板（下载后放 `~/.local/share/godot/export_templates/<版本>/`）