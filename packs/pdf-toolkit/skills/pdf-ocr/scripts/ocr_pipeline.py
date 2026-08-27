#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ocr_pipeline —— 扫描版 PDF OCR：逐页渲染 → 文本识别 → 输出可搜索 PDF + Markdown 文本
用法: ocr_pipeline.py <pdf> [-o outdir] [-lang chi_sim+eng] [-dpi 300]
依赖: tesseract 二进制 + 对应语言包（Debian: apt install tesseract-ocr tesseract-ocr-chi-sim
       Termux: pkg install tesseract；macOS: brew install tesseract tesseract-lang）
输出: <基名>_ocr.pdf（带隐藏文本层，可搜索复制） + <基名>_text.md（每页文本）
"""
import argparse, shutil, subprocess, sys
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("-o", default=None)
    ap.add_argument("-lang", default="chi_sim+eng", help="tesseract 语言，默认 chi_sim+eng（中文简体+英文）")
    ap.add_argument("-dpi", type=int, default=300, help="渲染分辨率，默认 300（低清晰扫描件可提到 400）")
    args = ap.parse_args()

    tesseract = shutil.which("tesseract")
    if not tesseract:
        sys.exit("[ocr_pipeline] 未找到 tesseract 二进制。安装指引：\n"
                 "  Debian/WSL2: sudo apt install tesseract-ocr tesseract-ocr-chi-sim\n"
                 "  Termux:      pkg install tesseract\n"
                 "  验证:        tesseract --list-langs 应含 chi_sim")

    base = Path(args.pdf).stem
    d = Path(args.o) if args.o else Path(f"./pdf_ocr_{base}")
    d.mkdir(parents=True, exist_ok=True)
    out_pdf = d / f"{base}_ocr.pdf"
    out_md = d / f"{base}_text.md"

    # 校验语言包
    langs = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True).stdout.split()
    for lg in args.lang.split("+"):
        if lg not in langs:
            sys.exit(f"[ocr_pipeline] 缺少语言包 {lg}（已装: {langs}）。安装 chi_sim: apt install tesseract-ocr-chi-sim")

    import pymupdf
    md_parts = [f"# {base}（OCR 识别）", ""]
    out_doc = pymupdf.open()
    with pymupdf.open(args.pdf) as doc:
        if doc.needs_pass:
            sys.exit("[ocr_pipeline] 文件加密，先 pdf_core decrypt")
        for i, page in enumerate(doc):
            print(f"  OCR 第 {i+1}/{doc.page_count} 页 ...", flush=True)
            # 渲染 → pdfocr_tobytes 生成带隐藏文本层的页（视觉保持 + 可搜索）
            pix = page.get_pixmap(dpi=args.dpi)
            ocr_pdf = pymupdf.open(stream=pix.pdfocr_tobytes(language=args.lang, compress=False))
            text = ocr_pdf[0].get_text() or ""
            md_parts.append(f"## 第 {i+1} 页\n\n{text}\n")
            out_doc.insert_pdf(ocr_pdf)
    out_doc.save(out_pdf, garbage=3, deflate=True)
    out_doc.close()
    out_md.write_text("\n".join(md_parts), encoding="utf-8")
    print(f"完成：可搜索 PDF → {out_pdf}；文本 → {out_md}")

if __name__ == "__main__":
    main()