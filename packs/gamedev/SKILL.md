---
name: gamedev
description: >
  游戏开发技能包（不注册、手动加载）。用户说"做游戏""写 Phaser/PixiJS/Three.js 游戏""Godot/GDScript 游戏""游戏技能"时读取本文件定位子技能；先读 README.md 了解清单与上游来源，再 read 对应 skills/<分组>/<技能>/SKILL.md 执行。
---

# gamedev 技能包索引

上游: `gamedev-skills/awesome-gamedev-agent-skills`（MIT），清单与更新方法见同目录 README.md。
39 个技能，四个分组（+godot 引擎组）；按任务阶段路由：

## 选型（先读 README.md）

- **简单网页游戏起步**：Phaser 4（2D 平台/俯视/弹幕最顺，内置 Arcade 物理）→ `skills/web/phaser-core` + `skills/web/phaser-arcade-physics`
- 2D 高强度渲染（粒子/图集/交互界面）→ `skills/web/pixijs-rendering`
- 3D 场景/模型 → `skills/web/threejs-*`（三个配套）
- **完整引擎（桌面/移动/复杂 2D3D，可导出 Web）**：Godot → `skills/godot/*`（15 个：GDScript/场景/物理/UI/动画/Shader/多人/导出等，先读该组 README）
- 只想验证玩法 → `skills/workflow/prototype-fast`（1 小时灰盒原型）

## 开发流程路由

| 阶段 | 技能 |
|---|---|
| 立项/玩法 | workflows/prototype-fast、game-jam（限定时间出 Demo） |
| 核心实现 | web/*（浏览器引擎）、godot/*（Godot 引擎）、design/game-feel（手感）、design/physics-tuning、design/game-ai、design/input-systems、design/camera-systems |
| 内容/界面 | design/game-ui-ux、design/dialogue-systems、design/level-design、design/save-systems、design/procedural-gen（程序生成关卡/内容）、design/create-game-assets（美术资产管线，含脚本） |
| 打磨/性能 | design/performance-optimization、design/audio-design、design/shader-programming |
| 发布 | workflows/itch-publish（网页游戏首选免费渠道）、steam-publish（商业）；Godot 项目另见 godot-export（presets/CI/Web） |

## 本机开发闭环约定

- 运行环境：Node 22 + Vite；无显示器 → 用 chromium-browser headless 截图/录屏做"亲眼验证"（godogen 的 proof-over-claims 思路）
- Godot 项目：本机未装 Godot 4.x（apt 仅 godot3、官方 arm64 下载被网络阻断），脚本验证/导出需在装有 Godot 的环境执行；详见 skills/godot/README.md 环境备注
- 美术资产缺口：走 Colab T4 + comfyui-agent 生成精灵/背景（见 packs/comfyui-agent）
- 交付形态：静态站/PWA，手机浏览器直接玩；Godot 项目导出 Web 见 godot-export