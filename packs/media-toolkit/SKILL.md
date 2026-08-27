---
name: media-toolkit
description: 图片/视频/游戏美术处理技能包。用户要处理图片（缩放/裁剪/压缩/格式/水印/批量）、视频（转码/剪辑/拼接/抽帧/音频/GIF/字幕）、游戏美术资产（精灵表拆分/图集打包/透明底/优化压缩）时触发。依赖本机 ImageMagick+ffmpeg+Pillow，无云端 API。
---

# media-toolkit — 图片 / 视频 / 游戏美术处理

通用媒体处理 + 游戏美术资产管线。全部本地执行（ImageMagick 6 / ffmpeg / Pillow），无云端依赖。

## 入口路由

| 场景 | 子技能 | 核心工具 |
|---|---|---|
| 通用图片处理（缩放/裁剪/转换/压缩/水印/批量/PDF→图） | `skills/image-basics` | convert / Pillow |
| 通用视频处理（转码/剪辑/拼接/抽帧/音频/GIF/字幕） | `skills/video-basics` | ffmpeg |
| 游戏美术资产（精灵表/图集/透明底/优化/九宫格/调色） | `skills/game-art` | Pillow / convert |
| 繁重或专业场景（图集批量工具/专业编辑器/GPU 编码） | `references/specialized-tools.md` | 按需启用 |

## 统一 CLI（bin/media_core）

所有常规操作走 `bin/media_core`（对齐 pdf-toolkit 的 pdf_core 模式）：

```bash
media_core image info <f>                      # 尺寸/格式/体积
media_core image convert <f> -o out.webp [--resize WxH] [--format] [--trim] [--quality]
media_core image compress <f> -o out --target-kb 200   # 压到目标体积下（webp/jpg/png 自动选）
media_core image watermark <f> -t "文字" -o out [--pos br|tl|tr|bl|c] [--size] [--color] [--font]
media_core image batch <src> --outdir out [--resize] [--format] [--quality]   # 批量（含子目录）

media_core game sprite-split <sheet> --cols N --rows N --outdir dir   # 精灵表等格拆分
media_core game sprite-pack <files...> -o atlas.png [--json meta.json] [--cols]  # 图集打包
media_core game opt <src> [--outdir] [--webp] [--quality]             # 资产目录批量无损优化

media_core video info <f>
media_core video transcode <f> -o out.mp4 [--resize WxH] [--crf N] [--preset] [--codec]
media_core video cut <f> --start 1:00 --end 1:30 -o out.mp4           # 自动关键帧对齐+fallback
media_core video concat <files...> -o out.mp4 [--reencode]            # 拼接（编码不一致用 --reencode）
media_core video frames <f> --fps 1 --outdir dir                      # 抽帧
media_core video audio <f> -o out.mp3 [--start] [--end] [--codec]     # 提取音频
media_core video gif <f> -o out.gif [--fps] [--scale]                 # 转 GIF（预览/宣传）
media_core video subs <f> --ass x.ass -o out.mp4                      # 烧录 ASS 字幕
```

## 本机环境（环境：termux-ubuntu proot aarch64；其他设备以自身环境为准）

- ffmpeg 6.1.1（/usr/bin/ffmpeg）、ImageMagick 6.9（convert/identify，**无 magick v7**）、Pillow 12.3.0（python3）
- 中文水印自动用 DroidSansFallbackFull.ttf（本机已含 CJK）
- 安装：`apt install imagemagick ffmpeg`；Python 侧 `pip install --break-system-packages pillow`

## 执行纪律

1. 图片/视频处理后必须验证产物：图片重跑 `image info`（尺寸/格式/体积），视频跑 `video info`（时长/分辨率/有流）；字幕/水印渲染后抽帧抽查
2. 游戏美术输出优先无损（PNG optimize / WebP quality≥85）；有损压缩只用于最终发布资产
3. 图集打包后必须核对 JSON 元数据与源文件对应（防错位）
4. 重型任务（4K 视频、千张批量、GPU 编码）先与用户确认规模再启用 specialized-tools 条目

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件正文对应章节并清条目。
