# 实测验证记录

本目录样本为 2026-06 建包时全流程实测素材，保留供回归复测：

| 样本 | 用途 |
|---|---|
| `a.pdf` | 中文文本 2 页（pymupdf china-s 生成） |
| `form.pdf` | 表单：2 个 fillable 文本框（name/date）+ 1 个空白备注区 |
| `scan.pdf` | 扫描件：a.pdf 第 1 页渲染成图后重组，无文本层 |

## 实测结果（全部通过）

| 功能 | 命令 | 结果 |
|---|---|---|
| info/extract | `pdf_core info a.pdf` / `extract a.pdf` | 2 页元数据 + 中文文本（布局保留） |
| tables | `pdf_core tables t1.pdf` | 2x2 表格正确还原 CSV（中文） |
| images | `pdf_core images img.pdf` | 提取图片 + manifest.json |
| render | `pdf_core render a.pdf -p 1 -dpi 100` | 827x1170 PNG |
| merge+书签 | `pdf_core merge a.pdf b.pdf --bookmarks` | 3 页 |
| split | `pdf_core split m.pdf 1-2` | 连续段合并单文件 |
| rotate | `pdf_core rotate a.pdf 90` | 595x842 → 842x595 |
| encrypt/decrypt | 口令 secret | needs_pass 0→1→0，解密文本完整 |
| watermark | 中文水印"机密 CONFIDENTIAL" | 文本层可检索（CJK 自动切 china-s 字体） |
| report | `pdf_core report a.pdf` | 元数据+全文+表格目录 |
| 表单四步 | extract_form → fields.json → fill_form → verify_form | 2 fillable 字段 + 1 坐标插入全部命中 |
| OCR | `ocr_pipeline.py scan.pdf -lang chi_sim+eng` | 中文识别正确，可搜索 PDF 文本层可检索 |

## 修过的问题（防回退）

1. `out_path` 未为显式 `-o` 创建父目录 → `mkdir(parents=True)`
2. pypdf 表单填充需 `PdfWriter(clone_from=...)` 保留 AcroForm，`add_page` 会丢字段结构
3. 水印中文乱码：helv 无 CJK 字形，按字符集自动切 `china-s`
4. pymupdf 1.28 无 `Page.get_text_length`，用模块级 `pymupdf.get_text_length`
5. 可搜索 PDF 必须走 `pix.pdfocr_tobytes()` 路线；`get_textpage_ocr` 只生成临时 TextPage，不会写入文件

## 环境

- Python 3.12（Debian，PEP 668），依赖以 `pip install --break-system-packages` 安装（先例 reverse-skill）
- tesseract 5 + chi_sim/eng 语言包