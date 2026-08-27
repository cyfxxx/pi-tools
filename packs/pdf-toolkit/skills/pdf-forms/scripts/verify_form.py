#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_form —— 填写结果验证：渲染页面 PNG + 提取文本核对
用法: verify_form.py <pdf> [pages(如 1,2)] [-o outdir]
检查: 1) 每页文本是否出现期望关键词  2) 渲染 PNG 供人工/视觉复核
"""
import argparse, sys
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("pages", nargs="?", default=None)
    ap.add_argument("-o", default=None); ap.add_argument("--expect", action="append", default=[])
    args = ap.parse_args()
    base = Path(args.pdf).stem
    d = Path(args.o) if args.o else Path(f"./form_check_{base}")
    d.mkdir(parents=True, exist_ok=True)

    import pymupdf
    with pymupdf.open(args.pdf) as doc:
        targets = []
        if args.pages:
            for part in args.pages.split(","):
                if "-" in part:
                    a, b = map(int, part.split("-")); targets += range(a, b + 1)
                else: targets.append(int(part))
        else:
            targets = range(1, doc.page_count + 1)
        ok = True
        for i in targets:
            page = doc[i - 1]
            text = page.get_text("text")
            pix = page.get_pixmap(dpi=150)
            png = d / f"p{i:03d}.png"; pix.save(png)
            for kw in args.expect:
                hit = kw in text
                ok = ok and hit
                print(f"  p{i} 含 '{kw}': {'✓' if hit else '✗ 未找到'}")
            print(f"  p{i} 文本 {len(text)} 字符 → {png}")
        print(f"验证完成 → {d}（{'全部命中' if ok else '存在未命中项，检查 PNG 或坐标'}）")

if __name__ == "__main__":
    main()