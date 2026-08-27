# game-art — 游戏美术资产处理

面向游戏项目（Godot/Unity/Web）的资产管线：精灵表、图集、透明底、优化压缩、九宫格。工具：Pillow + ImageMagick。经 `bin/media_core game ...`。

## 使用场景

### 1. 精灵表拆分（sprite sheet → 单帧）

```bash
# 等格拆分：2x2 表 → 4 帧 PNG（命名 <sheet>_行_列.png）
media_core game sprite-split sheet.png --cols 2 --rows 2 --outdir frames/
```
非等格（动画帧大小不一）→ 见 specialized-tools.md（Grid 探测/人工标注），或 Pillow 手写按 y 坐标切行。

### 2. 图集打包（单帧 → atlas）

```bash
# 等尺寸帧：自动网格排布 + JSON 元数据（供引擎加载）
media_core game sprite-pack frames/*.png -o atlas.png --json atlas.json
# 异尺寸帧：高度优先装箱（同一列对齐，适合 UI 图标）
media_core game sprite-pack icons/*.png -o icons.png --json icons.json --max-h 2048
```

### 3. 资产目录优化（发布前压缩）

```bash
# 无损 PNG 优化（保留全部细节）
media_core game opt assets/ --outdir assets_opt/
# 转 WebP（体积大幅下降；Godot 4 原生支持 webp 纹理导入）
media_core game opt assets/ --webp --quality 90 --outdir assets_webp/
```

### 4. 手工/专项操作（convert 直接）

```bash
# 透明底处理：白底抠透明（简单纯色可用 -fuzz；复杂图见 specialized-tools 抠图条目）
convert input.png -fuzz 10% -transparent white out.png
# 九宫格切片（3x3 分割，供 Godot NinePatch 用）
convert ui.png -crop 3x3@ +repage out_%d.png
# 调色板量化（像素风/复古，降体积）
convert photo.png -colors 64 -depth 8 out.png
# 对比度/伽马调整（贴图观感统一）
convert tex.png -gamma 0.9 -contrast-stretch 2%x2% out.png
```

## 游戏引擎落地要点

| 需求 | 推荐 | 说明 |
|---|---|---|
| Godot 纹理导入 | PNG/WebP | 默认无损压缩；webp 省内存 |
| 图集加载 | JSON + atlas | 引擎按 cell/坐标切片 |
| 像素风 | 关滤波 + 8-bit | Godot import 设 nearest |
| 动画帧 | 精灵表→AnimatedSprite2D | 拆分后用 SpriteFrames 导入 |
| 体积敏感（Web 导出） | WebP 全量 | 可达 PNG 30-50% |

## 决策指南

- 等格表 → `sprite-split`；异格帧 → 手动标注/专门工具（TexturePacker 等，见 specialized-tools）
- 等尺寸打包 → `sprite-pack`（cols 网格）；异尺寸 → 装箱模式（--max-h 控制高度）
- 无损优先：PNG optimize / WebP q≥85；最终发布包再考虑有损
- 透明需求一律 PNG/WebP，禁止 jpg

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（标注环境）。≥3 条或用户要求时合并进本文件正文。
