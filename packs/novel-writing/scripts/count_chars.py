#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""审查字数统计：净字（不含标点）统计，省略号加权口径。

省略号加权：……=6、…=3（占位感按 6/3 字计）。
用法：
  python3 count_chars.py <文件或目录>...      # 输出每个 md 文件统计
  python3 count_chars.py --report <目录>      # 汇总最多 20 个文件
自包含、无第三方依赖。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 汉字 + 常用全角标点之外的字符视为"非字"，不计数；省略号单独加权
_CN_CHAR = re.compile(r"[\u4e00-\u9fff]")
_ELLIPSIS_FULL = "……"  # 计 6
_ELLIPSIS_HALF = "…"    # 计 3


def count_review_chars(text: str) -> int:
    """省略号加权口径的净字数：汉字数 + 全角省略号加权 + 半角省略号加权。"""
    n_ellipsis_full = text.count(_ELLIPSIS_FULL)
    text = text.replace(_ELLIPSIS_FULL, "")
    n_ellipsis_half = text.count(_ELLIPSIS_HALF)
    text = text.replace(_ELLIPSIS_HALF, "")
    n_han = len(_CN_CHAR.findall(text))
    return n_han + n_ellipsis_full * 6 + n_ellipsis_half * 3


def iter_markdown(paths):
    files = []
    for path in paths:
        p = Path(path)
        if p.is_dir():
            files.extend(sorted(p.glob("*.md")))
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(path)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description="审查字数统计（省略号加权口径）。")
    parser.add_argument("paths", nargs="+", type=Path, help="Markdown 文件或目录")
    parser.add_argument(
        "--report", action="store_true",
        help="按目录汇总模式：取最多 20 个 md 文件，输出每文件字数与合计。",
    )
    args = parser.parse_args()

    if args.report:
        files = iter_markdown(args.paths)
        if not files:
            print("no markdown files found")
            return 1
        rows = []
        for f in files[:20]:
            try:
                n = count_review_chars(f.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, OSError) as e:
                n = 0
                print(f"# WARN {f}: {e}", file=sys.stderr)
            rows.append((f, n))
        total = sum(n for _, n in rows)
        for f, n in rows:
            print(f"{n:>6} {f}")
        print(f"TOTAL {total} chars / {len(rows)} files")
        return 0

    for file_path in iter_markdown(args.paths):
        text = file_path.read_text(encoding="utf-8")
        print(f"{file_path}: {count_review_chars(text)} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
