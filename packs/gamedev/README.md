# gamedev — pi 游戏开发技能包（网页优先）

从上游仓库整合的 Agent Skills 子集，按"网页游戏优先、通用技能保留、其他以后再说"原则收编。
**未注册 settings.json**（提示词零膨胀），需要时 read 本目录 SKILL.md 按需加载。

## 上游（保存，便于更新）

- 仓库: `gamedev-skills/awesome-gamedev-agent-skills`
- 地址: https://github.com/gamedev-skills/awesome-gamedev-agent-skills （MIT）
- 下载: https://codeload.github.com/gamedev-skills/awesome-gamedev-agent-skills/tar.gz/refs/heads/main （api/codeload 域名国内可达，github.com 主页被污染勿直连）

**更新方法**（增量重拉，然后按本期清单重新复制对应目录即可）：

```bash
cd /tmp && rm -rf awesome-gds gds.tgz
curl -sL -m 60 "https://codeload.github.com/gamedev-skills/awesome-gamedev-agent-skills/tar.gz/refs/heads/main" -o gds.tgz
tar xzf gds.tgz -C /tmp --strip-components=1 --one-top-level=awesome-gds
# 对照下方"收编清单"复制：cp -r awesome-gds/skills/<目录>/* /root/.pi/packs/gamedev/skills/<分组>/
```

## 收编清单（24 个技能，2026-08-21 拉取）

| 分组 | 技能 | 用途 |
|---|---|---|
| **web/** 网页引擎 (6) | phaser-core、phaser-arcade-physics | Phaser 4 游戏配置/场景/资源加载 + 街机物理 |
| | pixijs-rendering | PixiJS 渲染管线（2D 精灵/图集） |
| | threejs-scene-setup、threejs-materials-lighting、threejs-gltf-loading | Three.js 场景/材质光照/glTF 模型 |
| **design/** 通用学科 (14) | game-feel、game-ui-ux、input-systems、camera-systems、physics-tuning、game-ai、dialogue-systems、level-design、save-systems、procedural-gen、shader-programming、performance-optimization、audio-design、create-game-assets | 引擎无关的开发学科（含资产生成管线附脚本） |
| **workflow/** 流程 (4) | prototype-fast、game-jam、itch-publish、steam-publish | 快速原型/Game Jam/发布渠道 |

## 未收编（上游另有，以后需要时按目录增量拉取）

- `godot/`(16)、`unity/`(8)、`unreal/`(6)、`other-engines/`(4: bevy/love2d/pygame/roblox) — 其他引擎
- `genres/`(9: platformer/puzzle/roguelike/rpg/card-game 等) — 玩法类型模板（与引擎无关，网页游戏也适用，先未收）
- 更新重拉时注意上游可能增删技能，以 `find skills -name SKILL.md` 清单为准

## 用法

- 入口：`/root/.pi/packs/gamedev/SKILL.md`（含索引与路由建议）
- 具体技能：read `skills/<分组>/<技能>/SKILL.md` 后执行（Agent Skills 标准 frontmatter 格式，与 pi 兼容）
- 开发闭环惯例（见主会话结论）：Phaser/PixiJS + Vite，chromium headless 截图验证，Colab T4 生成美术资产