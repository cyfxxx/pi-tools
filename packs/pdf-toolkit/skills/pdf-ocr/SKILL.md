---
name: pdf-ocr
description: 扫描版/图片型 PDF 的 OCR 识别：渲染 + tesseract 文本层，输出可搜索 PDF 与 Markdown 文本。用户说"扫描件""图片型 PDF""不能复制文字的 PDF""OCR"时使用。整本翻译/竖排古籍/EPUB 导出等重场景见 references/specialized-tools.md。
---

# 扫描版 PDF OCR

## 判定入口

先跑 `pdf_core extract`；若提示"无可提取文本/疑似扫描图"，或 `pdf_core info` 显示页正常但文本层为空 → 走本流程。

## 单文件 OCR（常规场景）

```bash
python3 scripts/ocr_pipeline.py <扫描件.pdf> -o 输出目录
```

默认 `chi_sim+eng`（中文简体+英文混排）。可选参数：
- `-lang eng` 纯英文（更快）
- `-dpi 400` 低清晰度扫描件提分辨率（更慢但更准）
- 繁体/日文：`-lang chi_tra` / `-lang jpn`（需先装语言包）

输出：
- `<名>_ocr.pdf` —— 带隐藏文本层，可搜索/复制/再次提取（此后 `pdf_core extract` 可直接出文本）
- `<名>_text.md` —— 每页段落整理的 Markdown

## 质量与清理

- 手写区域、印章遮挡、低对比度页：识别结果必交叉核对，用 `pdf_core render -dpi 200` 渲染原图对照
- 识别文本常见错字（形近字/断行粘连）：交付前按上下文校正章节标题与数字
- 扫描方向颠倒 → 先 `pdf_core rotate` 校正再 OCR

## 繁重场景（先记录，按需启用，见 references/specialized-tools.md）

- **整本书 OCR→翻译→EPUB**：逐章处理（先 `pdf_core split` 分章），参考 KyoSakuyo/pdf-set 的管线设计（OCR→Markdown→标题层级整理→排版→翻译/EPUB）
- **超大文件（数百页）**：tesseract 单线程较慢，建议拆章并行
- **竖排古籍/复杂版面**：专用解析器（MinerU/Marker，GPU 加速）比 tesseract 更优

## 边界

- 纯图片 PDF（无内嵌文本且逐页为整图）：流程适用
- 加密 PDF：先 `pdf_core decrypt`
- OCR 对扫描质量的容忍度：dpi<150 或严重倾斜的页面识别率显著下降，先渲染检查