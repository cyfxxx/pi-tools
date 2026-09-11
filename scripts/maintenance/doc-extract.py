#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""doc-extract.py —— 文档文本提取器（roadmap 阶段 3.1）
用法: doc-extract.py <文件> [--limit N行]
支持: txt/md/csv/json | docx/xlsx(零依赖, zipfile+XML) | pdf(检测到 pdftotext) | 图片OCR(检测到 tesseract)
输出: 纯文本到 stdout(默认最大 400 行, 可 --limit 覆盖, 0=不限)。
"""
import sys, os, re, html, zipfile, subprocess, shutil

MAX_LINES_DEFAULT = 400

def run(cmd, **kw):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)
        return r.stdout if r.returncode == 0 else ''
    except Exception:
        return ''

def extract_txt(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

def extract_docx(path):
    z = zipfile.ZipFile(path)
    xml = z.read('word/document.xml').decode('utf-8', 'ignore')
    # 结构边界替换为控制符（顺序敏感：先 cell/row/para 后文本）
    xml = re.sub(r'</w:p>', '\n', xml)
    xml = re.sub(r'<w:p[^>]*>', '', xml)
    xml = re.sub(r'<w:tr[^>]*>', '\n', xml)
    xml = re.sub(r'<w:tc[^>]*>', '\t', xml)
    xml = re.sub(r'<w:tab[^>]*/>', '\t', xml)
    xml = re.sub(r'<w:br[^>]*/>', '\n', xml)
    xml = re.sub(r'<w:t[^>]*>', '', xml)
    xml = re.sub(r'</w:t>', '', xml)
    xml = re.sub(r'<[^>]+>', '', xml)
    xml = html.unescape(xml)
    lines = [re.sub(r'[ \t]+', ' ', l).strip() for l in xml.split('\n')]
    return '\n'.join(l for l in lines if l)

def extract_xlsx(path):
    z = zipfile.ZipFile(path)
    ss = []
    try:
        sx = z.read('xl/sharedStrings.xml').decode('utf-8', 'ignore')
        for si in re.findall(r'<si>.*?</si>', sx, re.S):
            ss.append(html.unescape(''.join(re.findall(r'<t[^>]*>(.*?)</t>', si, re.S))))
    except KeyError:
        pass
    out = []
    sheets = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml', n))
    for name in sheets:
        sx = z.read(name).decode('utf-8', 'ignore')
        out.append(f'# sheet: {name}')
        for row in re.findall(r'<row[^>]*>.*?</row>', sx, re.S):
            cells = []
            for c in re.findall(r'<c[^>]*>.*?</c>', row, re.S):
                typ = re.search(r't="(\w+)"', c)
                v = re.search(r'<v>(.*?)</v>', c, re.S)
                t = re.search(r'<t[^>]*>(.*?)</t>', c, re.S)
                if typ and typ.group(1) == 's' and v:
                    i = int(v.group(1)); cells.append(ss[i] if i < len(ss) else '')
                elif typ and typ.group(1) == 'inlineStr' and t:
                    cells.append(html.unescape(t.group(1)))
                elif v:
                    cells.append(html.unescape(v.group(1)))
                else:
                    cells.append('')
            while cells and cells[-1] == '':
                cells.pop()
            if cells:
                out.append('\t'.join(cells))
    return '\n'.join(out)

def extract_pdf(path):
    if not shutil.which('pdftotext'):
        return '[pdf] 系统未安装 pdftotext（apt install poppler-utils）'
    return run(['pdftotext', '-layout', path, '-'])

def extract_ocr(path):
    if not shutil.which('tesseract'):
        return '[ocr] 系统未安装 tesseract（apt install tesseract-ocr tesseract-ocr-chi-sim）'
    langs = [l for l in ('chi_sim', 'eng') if l in (run(['tesseract', '--list-langs']).split())]
    return run(['tesseract', path, 'stdout', '-l', '+'.join(langs) or 'eng'])

EXT = {
    '.txt': extract_txt, '.md': extract_txt, '.csv': extract_txt, '.json': extract_txt,
    '.log': extract_txt, '.py': extract_txt, '.ts': extract_txt, '.js': extract_txt,
    '.docx': extract_docx, '.xlsx': extract_xlsx,
    '.pdf': extract_pdf,
    '.png': extract_ocr, '.jpg': extract_ocr, '.jpeg': extract_ocr, '.webp': extract_ocr, '.bmp': extract_ocr, '.gif': extract_ocr,
}
IMG = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'}

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    args = sys.argv[1:]
    limit = MAX_LINES_DEFAULT
    if '--limit' in args:
        i = args.index('--limit'); limit = int(args[i + 1]); del args[i:i + 2]
    path = args[0]
    ext = os.path.splitext(path)[1].lower()
    if ext not in EXT:
        print(f'[doc-extract] 不支持类型 {ext}'); sys.exit(2)
    if not os.path.exists(path):
        print(f'[doc-extract] 文件不存在: {path}'); sys.exit(2)
    text = EXT[ext](path)
    lines = text.split('\n')
    if limit and len(lines) > limit:
        text = '\n'.join(lines[:limit]) + f'\n... [截断: 共 {len(lines)} 行, 显示前 {limit} 行]'
    sys.stdout.write(text + ('\n' if text and not text.endswith('\n') else ''))

if __name__ == '__main__':
    main()
