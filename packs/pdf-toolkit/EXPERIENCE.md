# pdf-toolkit 经验沉淀（EXPERIENCE.md）

按 packs/README.md「经验沉淀机制」追加；条目 ≥3 条或用户要求时合并进 SKILL.md 正文后清档。环境必须标注，防跨设备误会。

## 2026-06 建包期（环境：termux-ubuntu proot aarch64）

- **pypdf 表单填充必须 clone_from**：`PdfWriter(clone_from=src)` 才带 AcroForm 字典；`add_page` 组装会丢字段结构报 `No /AcroForm dictionary`
- **field 跨页**：`update_page_form_field_values` 按字段名匹配，逐页调用即可命中，不用解析 /P 页引用
- **可搜索 PDF 必须走 pdfocr_tobytes**：`page.get_textpage_ocr()` 只生成临时 TextPage 不写入文件（pymupdf 1.28 实测）；正确路线是渲染 pixmap → `pix.pdfocr_tobytes(language=...)` → 生成页插入新文档
- **pymupdf 1.28 API 变化**：`Page.get_text_length` 已移除，用模块级 `pymupdf.get_text_length(text, fontname, fontsize)`；`import pymupdf` 替代 deprecated 的 `import fitz`
- **水印中文乱码**：helv 无 CJK 字形；文本含 >0x2E80 字符时自动切 `china-s`（内置 CJK 字体），西文仍用 helv
- **out_path 父目录**：显式 `-o out/a.md` 时须 `mkdir(parents=True)`，否则 FileNotFoundError
- **安装限制**：PEP 668 环境需 `pip install --break-system-packages`（先例 reverse-skill）；tesseract 需额外 `apt install tesseract-ocr tesseract-ocr-chi-sim`（chi_sim 默认不含，`--list-langs` 校验不可省）