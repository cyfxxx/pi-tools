# specialized-tools — 繁重/专业场景记录

media-toolkit 覆盖日常；以下场景超出常规 CLI，按需启用（先与用户确认规模/安装代价）。

## 图片

1. **GIMP / Krita**（专业修图/绘画）：复杂合成、蒙版、笔刷修复。proot 环境难装（X11 依赖），安卓可用宿主版。
2. **Inkscape**（矢量）：SVG 编辑/导出。proot 可 apt 装但重。
3. **TexturePacker**（商业，图集打包行业标准）：异尺寸最优装箱、九宫格、精灵表导出、Godot 插件直出。替代：自写装箱（media_core sprite-pack 已含简版）。
4. **Aseprite**（像素画专用）：像素动画、调色板工作流。proot 可下载 linux 版（需 GUI）。
5. **upscayl / Real-ESRGAN**（放大）：AI 超分 2-4x，游戏资产放大保细节。GPU 环境（Colab T4 + comfyui-agent）跑更现实。
6. **抠图**：rembg（U2Net，本地 python，~200MB 模型，CPU 可跑 5-10s/张）；复杂毛发用 GIMP 手动。

## 视频

7. **ffmpeg 高级**（超出 media_core 覆盖）：滤镜链（`-vf` 组合：scale+fps+eq）、硬编 h264_vaapi/nvenc（GPU）、逐行 interlaced 处理、`-map` 多流操作、章节/元数据。参考 `ffmpeg -filters`。
8. **whisper**（ASR 转写/字幕生成）：openai-whisper python 包或 faster-whisper，CPU small 模型可跑；生成 SRT 后 media_core video subs 烧录。Android proot 可用但慢（5-10x 实时）。
9. **youtube-dl/yt-dlp**（下载）：视频素材获取。
10. **GPU 编码**：proot 无 GPU 直通；重编码走 Colab（ffmpeg 或 comfyui）再取回。

## 视频理解（可选扩展）

11. **watch-skill 思路**（GitHub: oxbshw/watch-skill, MIT）：ffmpeg 抽帧 + OCR/ASR → 时间戳索引检索。轻量本地实现：`media_core video frames` + tesseract（已有 chi_sim）+ whisper。适用：录屏检索、会议回看、游戏回放分析。

## 调研记录（2026-08-27，环境 termux-ubuntu proot aarch64）

- 官方 anthropics/skills 无 image/video 处理技能；第三方候选 OpenMontage（AGPL 重编排）、pexo-skills（云生成）、qiaomu-cut（云生态导演）均不适合收编，watch-skill（MIT）思路可参考
- 本地工具链评估：ImageMagick 6（convert，无 v7 magick）+ ffmpeg 6.1 + Pillow 12 覆盖 95% 日常；GIMP/Inkscape 在 proot 安装成本高，记入本文件按需启用
