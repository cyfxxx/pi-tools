#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""knowledge-fetch.py —— 知识订阅增量抓取（roadmap 3.2，零 LLM）
用法: knowledge-fetch.py [--limit K]
对主题列表调本地 SearXNG(127.0.0.1:8889)，按标题 hash 去重（logs/knowledge/.seen.txt），
新增结果追加写 logs/knowledge/<date>.md。主题与频率在 TOPICS/调度处调整。
"""
import json, urllib.request, urllib.parse, os, sys, re, html, hashlib
from datetime import datetime

TOPICS = ['人工智能', '系统漏洞', '网络病毒', '科技新闻', '重要新闻']
SEARX = 'http://127.0.0.1:8889/search'
KLOG = '/root/.pi/logs/knowledge'
SEEN = os.path.join(KLOG, '.seen.txt')
DEFAULT_LIMIT = 8
# 低价值标题过滤（百科/教程/名词解释/教育类）——减少模型筛选负担
LOW_VALUE = re.compile(r'百科|术语|教程|是什么|入门|本科专业|高等教育|名词解释|使用指南|快速上手')

def clean(s):
    if not s:
        return ''
    s = html.unescape(s)
    s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'\s+', ' ', s).strip()

def fetch(q, limit):
    url = f'{SEARX}?q={urllib.parse.quote(q)}&format=json'
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.loads(r.read().decode('utf-8', 'ignore')).get('results', [])[:limit]
    except Exception:
        return []

def load_seen():
    if os.path.exists(SEEN):
        return set(l.strip() for l in open(SEEN, encoding='utf-8') if l.strip())
    return set()

def main():
    limit = DEFAULT_LIMIT
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])
    os.makedirs(KLOG, exist_ok=True)
    seen = load_seen()
    date = datetime.now().strftime('%Y-%m-%d')
    new_h = []
    sections = []
    for t in TOPICS:
        sections.append(f'\n## {t}\n')
        added = 0
        for x in fetch(t, limit):
            title = clean(x.get('title') or '')
            if not title:
                continue
            h = hashlib.sha1(title.encode('utf-8')).hexdigest()[:16]
            if h in seen:
                continue
            if LOW_VALUE.search(title):
                continue  # 不写 seen：下次仍过滤，低成本
            pd = (x.get('publishedDate') or '')[:10]
            content = clean(x.get('content') or '')[:160]
            url = x.get('url') or ''
            sections.append(f'- [{title}]({url})' + (f' ({pd})' if pd else '') + (f'\n  {content}\n' if content else '\n'))
            new_h.append(h)
            added += 1
        sections.append(f'(新增 {added})\n')
    added_total = len(new_h)
    if added_total:
        with open(os.path.join(KLOG, f'{date}.md'), 'a', encoding='utf-8') as f:
            f.write('\n'.join(sections))
        with open(SEEN, 'a', encoding='utf-8') as f:
            for h in new_h:
                f.write(h + '\n')
        print(f'新增 {added_total} 条 -> logs/knowledge/{date}.md')
    else:
        print('无新增（各主题与上次一致）')
    today = os.path.join(KLOG, f'{date}.md')
    if os.path.exists(today):
        print('当日文件:', os.path.getsize(today), 'bytes')
    else:
        print('当日文件: (未创建)')

if __name__ == '__main__':
    main()
