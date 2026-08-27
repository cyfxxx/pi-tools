#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_form —— 表单结构提取：列出可填写字段 + 渲染页面 PNG 供坐标定位
用法: extract_form.py <pdf> [-o outdir]
输出: fields.txt（fillable 字段清单） + p001.png...（每页渲染图，供视觉定位非 fillable 字段坐标）
"""
import argparse, json, sys
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("-o", default=None)
    args = ap.parse_args()
    base = Path(args.pdf).stem
    d = Path(args.o) if args.o else Path(f"./form_struct_{base}")
    d.mkdir(parents=True, exist_ok=True)

    import pypdf
    from pypdf import PdfReader
    reader = PdfReader(args.pdf)
    if reader.is_encrypted:
        print("[extract_form] 文件加密，先解密再处理", file=sys.stderr); sys.exit(1)

    # 1) fillable 字段
    fields = reader.get_fields() or {}
    lines = []
    for name, f in fields.items():
        ft = f.get("/FT", "")
        lines.append(f"{name}\ttype={ft}\tvalue={f.get('/V', '')}")
    (d / "fillable_fields.txt").write_text(
        f"共 {len(fields)} 个可填写字段（/FT: Tx=文本框 Ch=选择 Btn=按钮）:\n" + "\n".join(lines) + "\n",
        encoding="utf-8")
    print(f"fillable 字段 {len(fields)} 个 → {d}/fillable_fields.txt")

    # 2) 渲染每页 PNG（坐标用 pymupdf 左上原点，可直接填入 fields.json）
    import pymupdf
    with pymupdf.open(args.pdf) as doc:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=150)
            f = d / f"p{i+1:03d}.png"
            pix.save(f)
            print(f"  {f} ({pix.width}x{pix.height})   ← 视觉定位坐标用")
    print(f"结构输出 → {d}\n下一步: 非 fillable 字段在 PNG 上量坐标（左上原点），写 fields.json 后 fill_form.py")

if __name__ == "__main__":
    main()