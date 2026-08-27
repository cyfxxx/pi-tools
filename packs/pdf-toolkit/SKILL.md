---
name: pdf-toolkit
description: PDF 全场景处理入口：文本/表格/图片提取、合并拆分旋转加密、生成、水印、扫描件 OCR、表单填写。用户提到 .pdf 文件或要求产出 PDF 时使用。通用操作走 bin/pdf_core；表单走 pdf-forms 子技能；扫描件 OCR 走 pdf-ocr 子技能；重型/不常用能力见 references/specialized-tools.md。
---

# PDF 处理工具包（pdf-toolkit）

## 路由速查

| 用户诉求 | 走哪里 |
|---|---|
| 提取文本/表格/图片/元数据 | `pdf_core extract/tables/images/meta` |
| 合并/拆分/旋转/加密/解密 | `pdf_core merge/split/rotate/encrypt/decrypt` |
| 生成 PDF（Markdown→PDF） | references/specialized-tools.md §8（pandoc） |
| 加水印 | `pdf_core watermark`（文本或水印 PDF 叠加） |
| 扫描件/文字不可复制 | pdf-ocr 子技能（`pdf_core extract` 空文本时先确认此项） |
| 填写表单（合同/申请表） | pdf-forms 子技能（四步流程） |
| 去水印/签名/压缩/整书解析/EPUB | references/specialized-tools.md（按需临时启用） |
| 网页 → PDF | pi-browser 的 `browser_pdf`（不属本包） |

## 通用操作（bin/pdf_core）

```bash
PY=/root/.pi/packs/pdf-toolkit
python3 $PY/bin/pdf_core info 文件.pdf        # 页数/加密/元数据
python3 $PY/bin/pdf_core extract 文件.pdf -o out.md    # 文本（布局保留）
python3 $PY/bin/pdf_core tables 文件.pdf     # 表格 → 每页 CSV
python3 $PY/bin/pdf_core images 文件.pdf     # 内嵌图片 → 目录 + manifest.json（sha256 去重）
python3 $PY/bin/pdf_core render 文件.pdf -p 1-3 -dpi 200   # 页面 PNG（检查/喂模型）
python3 $PY/bin/pdf_core merge a.pdf b.pdf -o m.pdf --bookmarks   # 合并+书签
python3 $PY/bin/pdf_core split 文件.pdf 1-3,5,7-   # 拆分（连续段合并成文件）
python3 $PY/bin/pdf_core rotate 文件.pdf 90 -p 2-4
python3 $PY/bin/pdf_core encrypt 文件.pdf 密码 -o 加密.pdf
python3 $PY/bin/pdf_core decrypt 加密.pdf 密码
python3 $PY/bin/pdf_core watermark 文件.pdf "机密" -o wm.pdf   # 或叠加 水印.pdf
python3 $PY/bin/pdf_core report 文件.pdf      # 综合报告（元数据+全文+表格+图片）
```

说明：
- 坐标均为 pymupdf 左上原点（渲染 PNG 量图即所得）；唯一例外是 PDF 生成的上下文明确用左下原点的 API
- 输出默认落在 `./pdf_<动作>_<文件名>/`；合并/拆分/水印等无默认输出目录的子命令，-o 建议显式给出
- 加密文件统一先 `pdf_core decrypt`

## 依赖

`requirements.txt`（pypdf / pdfplumber / pymupdf / reportlab；poppler-utils 系统包（pdftotext/pdfinfo）为可选增强）。
OCR 需 tesseract 二进制 + 语言包，安装命令见 pdf-ocr/SKILL.md 与 specialized-tools.md §9。

## 执行纪律

1. 交互式文档（表单、带超链接的目录）操作后必须验证：forms 走 verify_form；通用操作重跑 `info`/`extract` 抽查
2. 扫描件优先走 OCR 而非盲目猜文本；OCR 结果交付前渲染对照抽查
3. 重型任务（整本书、GPU 解析、批处理）先与用户确认规模再启用 specialized-tools 条目

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加本包根 `EXPERIENCE.md`（工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件正文对应章节并清条目。