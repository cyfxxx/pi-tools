# media-toolkit 实测记录（2026-08-27，环境：termux-ubuntu proot aarch64）

全链路实测通过（CLI 14 个子命令 + 子技能要点）：

## 实测清单

| 命令 | 结果 | 备注 |
|---|---|---|
| image info / convert / compress / watermark | ✅ | webp 转换、resize、压缩到目标体积、中文水印（DroidSansFallback） |
| image batch | ✅ | 递归批量转 webp+resize |
| game sprite-split | ✅ | 2x2=4 帧拆分命名 `<stem>_行_列.png` |
| game sprite-pack | ✅ | 等尺寸网格打包 + JSON 元数据（cols/rows/cell/frames） |
| game opt | ✅ | 目录无损优化 |
| video info / transcode / frames / gif / subs | ✅ | testsrc 3s 素材；ASS 中文烧录 OK |
| video cut | ✅ | 流拷贝 + 空产物自动重编码 fallback |
| video concat | ✅ | 流拷贝 2 段拼接 |
| video audio | ✅ | 带音轨素材提取 mp3 |

## 修过的坑

1. **convert 命令名**：ImageMagick 6 无 `magick`（v7 才改名），本机用 `convert`/`identify`；脚本已按 v6 语法
2. **字体路径**：dejavu 不存在，自动探测 DroidSansFallbackFull（含 CJK）→ 中文水印可用
3. **video cut 关键帧**：`-ss` 放 `-i` 前做快速 seek；流拷贝产物空/无流时自动重编码兜底（纯视频短区间曾空输出）
4. **video audio 无音轨**：testsrc 纯视频提取音频报 "does not contain any stream"——先 `video info` 确认有音频流
5. **concat 编码不一致**：流拷贝要求各段同编码/参数，不一致需 `--reencode`

## 测试素材生成（可复用）

```bash
ffmpeg -y -f lavfi -i testsrc=duration=3:size=320x240:rate=15 -pix_fmt yuv420p test.mp4
ffmpeg -y -f lavfi -i testsrc=duration=3:size=320x240:rate=15 -f lavfi -i sine=frequency=440:duration=3 -pix_fmt yuv420p -c:a aac test_av.mp4
```
