# video-basics — 通用视频处理

处理：转码/剪辑/拼接/抽帧/音频/GIF/字幕烧录。工具：ffmpeg 6.1。全部经 `bin/media_core video ...`。

## 常见操作

```bash
# 信息（时长/分辨率/编码/体积）
media_core video info clip.mp4

# 转码 + 缩放（crf 18≈视觉无损，23 均衡，28 小体积）
media_core video transcode clip.mp4 -o out.mp4 --resize 1280x720 --crf 23 --preset medium

# 剪辑（自动关键帧对齐，纯流拷贝优先，失败自动重编码兜底）
media_core video cut clip.mp4 --start 0:10 --end 0:20 -o cut.mp4

# 拼接（编码/参数一致用流拷贝；不一致用 --reencode 重编码统一）
media_core video concat a.mp4 b.mp4 -o merged.mp4
media_core video concat a.mp4 b.mp4 -o merged.mp4 --reencode

# 抽帧（--fps 1 = 每秒 1 帧，用于视频理解/封面/预览）
media_core video frames clip.mp4 --fps 1 --outdir frames/

# 提取音频（默认 mp3，可 --codec aac / libopus）
media_core video audio clip.mp4 -o audio.mp3 --start 0:00 --end 1:00

# 转 GIF（预览/社交媒体；--scale 缩小体积，--fps 5-10 平滑）
media_core video gif clip.mp4 -o preview.gif --fps 10 --scale 480x270

# 烧录字幕（ASS 硬字幕；SRT 先用 ffmpeg 转 ASS 或直接 -vf subtitles=）
media_core video subs clip.mp4 --ass subs.ass -o subbed.mp4
```

## 关键知识

- **流拷贝 vs 重编码**：`cut`/`concat` 默认流拷贝（秒级、无损），但受关键帧限制（GOP）；`cut` 已内置 fallback，`concat` 编码不一致时必须 `--reencode`
- **时间格式**：`1:23` 或 `83` 或 `0:01:23` 均可；`--start` 必填，`--end` 省略=到结尾
- **音轨缺失**：纯视频流提取音频会失败（ffmpeg 报 "does not contain any stream"），先 `video info` 看有无音频流
- **GIF 体积**：缩小分辨率 + 降 fps 是主要手段；彩色照片类内容 GIF 会很大，考虑 webm/mp4 代替
- **ASS 字幕**：支持样式/位置/特效；中文字幕字体与渲染字体有关，缺 CJK 字体时字幕可能方块（系统需 fonts-noto-cjk）

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（标注环境）。≥3 条或用户要求时合并进本文件正文。
