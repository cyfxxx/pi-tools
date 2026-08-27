# specialized-tools.md — 专用/繁重 PDF 能力记录

本文件记录**不常用、体量大或需要重型依赖**的 PDF 能力的接入要点，供按需启用。不提供完整脚本；启用时先读对应条目，再临时搭建。

## 1. 去水印 / 内容遮盖（redaction）

- **适用**：去除重复文本角标水印、遮盖敏感字段
- **方案 A（文本规则）**：pymupdf `page.search_for(文本)` 定位 + `page.add_redact_annot(rect)` + `doc.apply_redactions()`。优点是物理删除（非视觉遮挡），文件导出后无法恢复
- **方案 B（启发式）**：统计跨页重复出现的大字号短语（超过页数阈值视为水印）。参考 xiexikang/skill-pdf-content-extractor 的 `watermark_patterns.json` 规则（contains/icontains/regex）+ 启发式（min_font_size、repeat_threshold_percent）
- **局限（作者实测反馈）**：启发式在复杂版面（页眉页脚、装饰元素）误伤率高，规则法只对固定措辞有效。交给用户确认命中范围，使用 dry-run 先统计
- **注意**：`apply_redactions` 伪造文本层（把被遮盖文字变白字塞入）以破坏提取，属设计行为，非 bug

## 2. 数字签名

- pypdf 的签名 API 仅支持受限场景（自签证书、无外观流），复杂场景不推荐
- **实用路线**：OpenSSL 自签证书 + `pdfsig`/`qpdf` 校验链，仅做文档完整性签名（non-visible）；可视化电子签（手写/印章位图）用 pymupdf `insert_image` 贴图 + 防篡改用封面哈希记录
- 正式合规签章（国密/CA 体系）：专用客户端（如 WPS/Adobe/e签宝），非脚本管线范畴，记录即止

## 3. 压缩 / 优化

- **首选**：`gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -o out.pdf in.pdf`（Ghostscript 重压缩，调 `/screen` 更小）
- 轻量：pymupdf `doc.save(out, garbage=3, deflate=True)`（清垃圾对象，去重复字体），无外部依赖
- `qpdf --object-streams=generate` 可进一步整理
- 图片型 PDF 的压缩主战场是内嵌图片（`pdf_core images` 抽出 → 压图 → 重组）

## 4. Stirling-PDF（自托管全家桶）

- 50+ 工具：合并/拆分/签名/redact/压缩/转换/OCR/水印/页面重排，Web UI + API，80k stars
- 场景：需要"不需要写代码的批处理工具箱"、多人共用、模板化流水线
- 接入：Docker 部署（`docker run -d -p 8080:8080 stirlingtools/stirling-pdf:latest`），API 文档见其仓库 `docs/API.md`。本机（Termux/ARM 无 Docker 场景）不适用
- 与 pdf-toolkit 的关系：工具重叠度高，仅当需求超出 pdf_core 覆盖（如批量自动化工作流 UI）时启用

## 5. 高质量文档解析（版面/表格/公式）

- **MinerU**（opendatalab，GPU 加速）：扫描书/论文 → Markdown/JSON，版面分析 + 公式 OCR + 表格还原，中文论文场景强
- **Marker**（datalab，GPU）：PDF → Markdown，速度快
- 场景：整本论文/教材的深度结构化提取、公式保留。CPU 可跑但慢；需要 GPU 环境（本机无 GPU，参考 packs/colab-bridge 借 Colab）
- 对比：pdf_core tables 只能提基础线框表，复杂合并单元格/公式请直接用 MinerU 类工具

## 6. JS 方案（浏览器端 / 复杂表单）

- **pdf-lib**（MIT）：创建/合并/拆分/表单填写，纯 JS，浏览器可跑；复杂 AcroForm（JS 联动、计算字段）比 pypdf 稳
- **pdfjs-dist**（Apache）：渲染/文本坐标提取，Google 系
- 场景：网页内嵌 PDF 处理、acrobat 兼容性要求高的表单。本机无浏览器运行时需求时不必引入

## 7. 整书 OCR→翻译→EPUB 管线（pdf-set 借鉴）

- 参照 KyoSakuyo/skills 的 pdf-set：逐页转图 → OCR 成 Markdown → 整理标题层级 → 排版成书 → 翻译 → EPUB 导出
- 工程要点：先 `pdf_core split` 分章处理（单进程 tesseract 长任务易中断）；每章 OCR 后立即落盘 markdown；章节间用标题层级对齐检查断层
- 中文竖排/古籍：OCR 前先按列旋转切分（pdftoppm + 旋转），识别语言 `chi_tra`；此场景整体建议转 MinerU（见 §5）

## 8. Markdown → PDF（生成方向补充）

- 已装中文环境的快捷路线：`pandoc in.md -o out.pdf --pdf-engine=weasyprint`（CSS 控制样式），或 wkhtmltopdf
- reportlab 直接编程生成适合"表格+固定样式"的票据/报表（pdf_core 未封装，需要时临时写脚本）
- 纯网页类内容：`browser_pdf`（pi-browser 扩展，Chromium 打印）现成可用

## 9. 中文 OCR 语言包（各环境）

| 环境 | 命令 |
|---|---|
| Debian/Ubuntu/WSL2 | `apt install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-chi-tra` |
| Termux | `pkg install tesseract`（含语言数据） |
| macOS | `brew install tesseract tesseract-lang` |

验证：`tesseract --list-langs` 应含 `chi_sim`。

**启用原则**：以上条目按需临时启用；启用后若形成稳定流程，回填为正式子技能（同 type 合并进本包）。