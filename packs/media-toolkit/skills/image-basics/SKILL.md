# image-basics — 通用图片处理

处理：缩放/裁剪/格式转换/压缩/水印/批量/透明/PDF→图。工具：ImageMagick 6（convert）+ Pillow。全部经 `bin/media_core image ...`。

## 常见操作

```bash
# 单图信息（尺寸/格式/体积）
media_core image info photo.png

# 转换 + 缩放（WebP 是 web 最佳选择；PNG 保透明）
media_core image convert photo.png -o out.webp --resize 800x600 --quality 85

# 自动裁边（去空白）
media_core image convert photo.png -o out.png --trim

# 压缩到目标体积（自动选 webp/jpg/png，适合发消息/上传限制）
media_core image compress big.png -o small --target-kb 200

# 水印（中文自动 CJK 字体）
media_core image watermark photo.png -t "© 2026" -o out.png --pos br --size 32

# 批量（递归子目录，保持相对结构）
media_core image batch assets/ --outdir out/ --format webp --resize 1024x1024 --quality 85
```

## 决策指南（哪个工具赢）

| 任务 | 首选 | 说明 |
|---|---|---|
| 缩放/裁剪/转换 | convert | 快、批处理强 |
| 精确压缩控制 | Pillow（compress 子命令） | 目标体积循环 |
| 透明/Alpha 处理 | convert/Pillow | RGBA 全保真 |
| 矢量→PNG | convert（rsvg） | 需 librsvg |
| PDF→图片 | `pdftoppm`（poppler-utils） | 多页自动编号 |
| 批量重命名/目录整理 | bash + Pillow | 组合场景 |

## 关键参数速记

- `--resize 800x600` 等比缩放到盒内（LANCZOS）
- `--trim` 自动裁掉边缘透明/空白
- PNG 用 quality 无效（无损）；webp/jpg 才有效
- 透明图转 jpg 会丢透明（转 jpg 前先确认无透明需求）
- 中文水印需 CJK 字体（本机 DroidSansFallbackFull，自动探测）

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（标注环境）。≥3 条或用户要求时合并进本文件正文。
