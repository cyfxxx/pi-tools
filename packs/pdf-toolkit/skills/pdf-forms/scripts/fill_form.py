#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fill_form —— 填写 PDF 表单（fillable 字段 + 非 fillable 坐标插入）
用法: fill_form.py <pdf> <fields.json> [-o out.pdf] [--font FONT]
fields.json 两种条目（可混合）:
  {"name": "字段名", "value": "值"}                      → fillable 字段（pypdf）
  {"page": 1, "x": 100, "y": 780, "text": "值", "fontsize": 12}  → 非 fillable（pymupdf 左上原点坐标，来自 extract_form 渲染图）
中文填充默认用内置 CJK 字体 china-s；西文可 --font helv
"""
import argparse, json, sys
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("fields_json"); ap.add_argument("-o")
    ap.add_argument("--font", default="china-s", help="非 fillable 插入字体（中文默认 china-s，西文 helv）")
    args = ap.parse_args()
    data = json.loads(Path(args.fields_json).read_text(encoding="utf-8"))
    fields = data.get("fields", data if isinstance(data, list) else [])
    out = Path(args.o) if args.o else Path(args.pdf).with_name(Path(args.pdf).stem + "_filled.pdf")

    named = [f for f in fields if "name" in f]
    coords = [f for f in fields if "page" in f]
    if not named and not coords:
        print("[fill_form] fields.json 无有效条目", file=sys.stderr); sys.exit(1)

    # 1) fillable：pypdf 更新字段值（clone_from 保留 AcroForm 结构）
    if named:
        from pypdf import PdfReader, PdfWriter
        reader = PdfReader(args.pdf)
        known = reader.get_fields() or {}
        writer = PdfWriter(clone_from=args.pdf)
        for f in named:
            if f["name"] not in known:
                print(f"[fill_form] 警告: 字段 '{f['name']}' 不存在（fillable 清单见 extract_form 输出），已跳过")
                continue
        for pg in writer.pages:  # pypdf 内部按字段名匹配，逐页更新确保命中
            writer.update_page_form_field_values(pg, {f["name"]: str(f["value"]) for f in named})
        for f in named:
            print(f"  fillable: {f['name']} = {f['value']}")
        tmp = out.with_suffix(".tmp.pdf")
        with open(tmp, "wb") as fh: writer.write(fh)
        pdf_path = tmp
    else:
        pdf_path = Path(args.pdf)

    # 2) 非 fillable：pymupdf 坐标插入
    if coords:
        import pymupdf
        with pymupdf.open(pdf_path) as doc:
            for f in coords:
                page = doc[f["page"] - 1]
                page.insert_text((float(f["x"]), float(f["y"])), str(f["text"]),
                                 fontsize=float(f.get("fontsize", 12)), fontname=args.font)
                print(f"  坐标: p{f['page']} ({f['x']},{f['y']}) '{f['text']}'")
            doc.save(out)
            if pdf_path != Path(args.pdf): pdf_path.unlink()
    else:
        import shutil; shutil.move(str(pdf_path), str(out))
    print(f"填写完成 → {out}")

if __name__ == "__main__":
    main()