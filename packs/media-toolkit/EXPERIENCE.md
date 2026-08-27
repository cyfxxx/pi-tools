# media-toolkit 经验沉淀（EXPERIENCE.md）

按 packs/README.md「经验沉淀机制」追加；条目 ≥3 条或用户要求时合并进 SKILL.md 正文后清档。环境必须标注，防跨设备误会。

## 2026-08-27 建包期（环境：termux-ubuntu proot aarch64）

- **工具链定版**：ImageMagick 6.9（命令是 `convert` 不是 `magick`，v7 才改名）+ ffmpeg 6.1 + Pillow 12.3（`--break-system-packages` 安装）覆盖 95% 日常；GIMP/Inkscape 在 proot 安装成本高，记 specialized-tools 按需启用
- **中文水印**：dejavu 不存在于本机；DroidSansFallbackFull.ttf 含 CJK，脚本自动探测链（用户字体→Droid→Liberation→DejaVu）
- **cut 关键帧坑**：`-ss` 放 `-i` 前快速 seek；流拷贝产物可能空/无流（GOP 对齐），必须验证产物有流，失败自动重编码兜底——验证-兜底模式值得复制到 concat
- **无音轨素材**：提取音频报 "does not contain any stream"，先 video info 确认音频流
- **图集打包两模式**：等尺寸网格（cols 参数）+ 异尺寸装箱（高度优先，--max-h）；JSON 元数据必须带 cell/frames 供引擎定位
- **调研结论**：现成 image/video 技能无完全对口（OpenMontage AGPL 太重、pexo/qiaomu 云依赖），自建轻量 CLI 更符合 pdf-toolkit 模式；watch-skill 视频理解思路（抽帧+OCR/ASR 索引）留作可选扩展