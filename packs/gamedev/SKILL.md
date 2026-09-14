---
name: gamedev
description: >
  游戏开发技能包（不注册、手动加载）。用户说"做游戏""写 Phaser/PixiJS/Three.js 游戏""Godot/GDScript 游戏""游戏技能"时读取本文件定位子技能；先读本文件了解清单与上游来源，再 read 对应 skills/<分组>/<技能>/SKILL.md 执行。
---

# gamedev 技能包索引

从上游仓库整合的 Agent Skills 子集，按"网页游戏优先、通用技能保留、其他以后再说"原则收编。
**未注册 settings.json**（提示词零膨胀），需要时 read 本文件按需加载。

## 上游（保存，便于更新）

- 仓库: `gamedev-skills/awesome-gamedev-agent-skills`
- 地址: https://github.com/gamedev-skills/awesome-gamedev-agent-skills （MIT）
- 下载: https://codeload.github.com/gamedev-skills/awesome-gamedev-agent-skills/tar.gz/refs/heads/main

**更新方法**（增量重拉，然后按本期清单重新复制对应目录即可）：

```bash
cd /tmp && rm -rf awesome-gds gds.tgz
curl -sL -m 60 "https://codeload.github.com/gamedev-skills/awesome-gamedev-agent-skills/tar.gz/refs/heads/main" -o gds.tgz
tar xzf gds.tgz -C /tmp --strip-components=1 --one-top-level=awesome-gds
# 对照下方"收编清单"复制：cp -r awesome-gds/skills/<目录>/* /root/.pi/packs/gamedev/skills/<分组>/
```

## 收编清单（39 个技能）

| 分组 | 技能 | 用途 |
|---|---|---|
| **web/** 网页引擎 (6) | phaser-core、phaser-arcade-physics | Phaser 4 游戏配置/场景/资源加载 + 街机物理 |
| | pixijs-rendering | PixiJS 渲染管线（2D 精灵/图集） |
| | threejs-scene-setup、threejs-materials-lighting、threejs-gltf-loading | Three.js 场景/材质光照/glTF 模型 |
| **design/** 通用学科 (14) | game-feel、game-ui-ux、input-systems、camera-systems、physics-tuning、game-ai、dialogue-systems、level-design、save-systems、procedural-gen、shader-programming、performance-optimization、audio-design、create-game-assets | 引擎无关的开发学科（含资产生成管线附脚本） |
| **workflow/** 流程 (4) | prototype-fast、game-jam、itch-publish、steam-publish | 快速原型/Game Jam/发布渠道 |
| **godot/** 完整引擎 (15) | godot-gdscript、godot-csharp、godot-nodes-scenes、godot-signals-groups、godot-2d-movement、godot-3d-essentials、godot-physics、godot-tilemap、godot-ui-control、godot-animation、godot-audio、godot-shaders、godot-resources、godot-multiplayer、godot-export | Godot 4.x（基线 4.7）：GDScript/C#、2D/3D、UI、导出管线 |

## 未收编（上游另有，以后需要时按目录增量拉取）

- `unity/`(8)、`unreal/`(6)、`other-engines/`(4: bevy/love2d/pygame/roblox) — 其他引擎
- `genres/`(9: platformer/puzzle/roguelike/rpg/card-game 等) — 玩法类型模板

## 选型

- **简单网页游戏起步**：Phaser 4（2D 平台/俯视/弹幕最顺，内置 Arcade 物理）→ `skills/web/phaser-core` + `skills/web/phaser-arcade-physics`
- 2D 高强度渲染（粒子/图集/交互界面）→ `skills/web/pixijs-rendering`
- 3D 场景/模型 → `skills/web/threejs-*`（三个配套）
- **完整引擎（桌面/移动/复杂 2D3D，可导出 Web）**：Godot → `skills/godot/*`（15 个）
- 只想验证玩法 → `skills/workflow/prototype-fast`（1 小时灰盒原型）

## 开发流程路由

| 阶段 | 技能 |
|---|---|
| 立项/玩法 | workflows/prototype-fast、game-jam |
| 核心实现 | web/*、godot/*、design/game-feel、design/physics-tuning、design/game-ai、design/input-systems、design/camera-systems |
| 内容/界面 | design/game-ui-ux、design/dialogue-systems、design/level-design、design/save-systems、design/procedural-gen、design/create-game-assets |
| 打磨/性能 | design/performance-optimization、design/audio-design、design/shader-programming |
| 发布 | workflows/itch-publish、steam-publish；Godot 项目另见 godot-export |

## 本机开发闭环约定

- 运行环境：Node 22 + Vite；无显示器 → 用 chromium-browser headless 截图/录屏做"亲眼验证"
- Godot 项目：本环境（termux-ubuntu proot）已装 Godot 4.7.2 arm64（`godot` 可用）
- 美术资产缺口：走 Colab T4 + comfyui-agent 生成精灵/背景（见 packs/comfyui-agent）
- 交付形态：静态站/PWA，手机浏览器直接玩；Godot 项目导出 Web 见 godot-export

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件/对应子技能正文并清条目。
