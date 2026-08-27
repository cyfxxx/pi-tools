# media-toolkit — 图片 / 视频 / 游戏美术处理

通用媒体处理 + 游戏美术资产管线，全部本地执行（ImageMagick + ffmpeg + Pillow），无云端 API。

- **入口**：`SKILL.md`（路由 + `bin/media_core` 14 子命令速查）
- **结构**：`skills/`（image-basics / video-basics / game-art）+ `references/specialized-tools.md`（TexturePacker/GIMP/whisper 等繁重能力）+ `examples/`（实测记录）
- **依赖**：ImageMagick 6（convert）、ffmpeg ≥6、Pillow（python3）；安装见 SKILL.md
- **维护**：使用后偏差按仓库级 `docs/SKILLS-MAINTENANCE.md` 机制沉淀；经验已建 `EXPERIENCE.md`（建包期 6 条）
- **环境备注**：本环境为 termux-ubuntu（proot-Distro aarch64，Android 宿主 proot 容器）；ffmpeg 6.1.1 / ImageMagick 6.9 / Pillow 12.3 已装；中文水印自动用 DroidSansFallbackFull（CJK）
