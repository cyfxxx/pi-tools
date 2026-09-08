#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""knowledge-fetch.py —— 知识订阅（v2 官方源直连，零 LLM）
用法: knowledge-fetch.py [--limit K]
不再依赖本地 SearXNG 搜索引擎，直接轮询权威/稳定源（官方 API + RSS + 轻量 HTML 抓取），
按标题 hash 去重（logs/knowledge/.seen.txt），新增追加写 logs/knowledge/<date>.md。
各源独立容错：单个源失败不影响其余。主题分 5 个 section：安全/漏洞、人工智能、
科技数码、生活热点、重要新闻。渠道与频率可在 SOURCES / 调度处调整。
"""
import json, urllib.request, urllib.parse, os, sys, re, html, hashlib
from datetime import datetime

KLOG = os.path.join(os.environ.get('HOME', '/root'), '.pi/logs/knowledge')
SEEN = os.path.join(KLOG, '.seen.txt')
DEFAULT_LIMIT = 6          # 每源条数上限
UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'Accept': '*/*'}

# 低价值标题过滤（教程/百科/广告/行情等）——各源在 entry() 阶段统一过滤
LOW_VALUE = re.compile(
    r'百科|术语|教程|是什么|入门|名词解释|使用指南|快速上手|本科专业|高等教育'
    r'|开奖|走势图|大盘|基金净值|数据中心|下载中心|回放|APP官网|网站首页'
    r'|广告|营销推广|推广软文', re.I)


def clean(s):
    if not s:
        return ''
    s = html.unescape(s or '')
    s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def fetch(url, timeout=20, max_bytes=2 * 1024 * 1024):
    """GET 文本，失败返回 ''（不解 gzip，个别源需 gzip 时走 fetch_bytes+手动解压）。"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA['User-Agent']})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(max_bytes)
            return raw.decode('utf-8', 'ignore')
    except Exception:
        return ''


def fetch_bytes(url, timeout=20, max_bytes=4 * 1024 * 1024):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA['User-Agent']})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(max_bytes)
    except Exception:
        return b''


# ---------------- RSS 通用解析 ----------------
def parse_rss(xml):
    """返回 [(title, url, pubdate, summary)]"""
    items = []
    for m in re.finditer(r'<item>(.*?)</item>', xml, re.S):
        it = m.group(1)
        def g(tag):
            mm = re.search(r'<%s>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</%s>' % (tag, tag), it, re.S)
            return clean(mm.group(1)) if mm else ''
        title, link, pub, desc = g('title'), g('link'), g('pubDate'), g('description')
        if title and link:
            items.append((title, link, pub[:16], desc[:140]))
    return items


# ---------------- 各源抓取器：返回 [(title, url, pubdate, summary)] ----------------
def src_cisa():
    d = json.loads(fetch('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'))
    out = []
    for v in d.get('vulnerabilities', []):
        cve = v.get('cveID', '')
        desc = v.get('shortDescription', '')
        tag = '已遭利用'
        if v.get('knownRansomwareCampaignUse'):  # 依赖下游确认字段，简单叠加标记
            tag += '/勒索'
        out.append((f'{cve} {v.get("vulnerabilityName", "")}'.strip(),
                    f'https://www.cve.org/CVERecord?id={cve}',
                    v.get('dateAdded', '')[:10], f'[{tag}] {desc}'[:140]))
    return out


def src_github():
    d = json.loads(fetch('https://api.github.com/advisories?updated=%3E2026-01-01'))
    out = []
    for a in d:
        cid = a.get('cve_id') or a.get('ghsa_id') or ''
        out.append(((a.get('summary') or '')[:80], a.get('html_url', '#'),
                    (a.get('updated_at') or '')[:10],
                    f'[sev={a.get("severity")}] {cid} {(a.get("description") or "")[:120]}'))
    return out


def src_anquanke():
    d = json.loads(fetch('https://api.anquanke.com/data/v1/posts?page=1&size=20'))
    out = []
    for p in d.get('data', []):
        pid = p.get('id')
        url = f'https://www.anquanke.com/post/id/{pid}' if pid else p.get('url', '')
        if not url:
            continue
        out.append((p.get('title', ''), url, (p.get('date') or '')[:10],
                    (p.get('subtitle') or p.get('summary') or '')[:140]))
    return out


def src_freebuf():
    xml = fetch('https://www.freebuf.com/feed')
    return parse_rss(xml)


def src_arxiv():
    xml = fetch('https://rss.arxiv.org/rss/cs.AI')
    return parse_rss(xml)


def src_techcrunch():
    xml = fetch('https://techcrunch.com/feed/')
    return parse_rss(xml)


def src_ars():
    xml = fetch('https://feeds.arstechnica.com/arstechnica/index')
    return parse_rss(xml)


def src_ithome():
    xml = fetch('https://www.ithome.com/rss/')
    return parse_rss(xml)


def src_sspai():
    xml = fetch('https://sspai.com/feed')
    return parse_rss(xml)


def src_chinanews():
    """中新网滚动要闻（含民生/社会），取条目主体正文标题。"""
    xml = fetch('https://www.chinanews.com.cn/rss/scroll-news.xml')
    return parse_rss(xml)


def src_zhihu():
    d = json.loads(fetch('https://api.zhihu.com/topstory/hot-list'))
    out = []
    for it in d.get('data', []):
        t = it.get('target', {})
        qid = t.get('id')
        if not qid or not t.get('title'):
            continue
        out.append(('(热榜) ' + t.get('title', ''),
                    f'https://www.zhihu.com/question/{qid}',
                    datetime.now().strftime('%Y-%m-%d'),
                    '热度' + (it.get('detail_text') or '') + ' · ' + clean(t.get('excerpt', ''))[:120]))
    return out


def src_xinhua():
    """新华网科技频道 HTML 标题抓取（官方权威要闻）。"""
    h = fetch('https://www.news.cn/tech/', max_bytes=1024 * 1024)
    seen, out = set(), []
    if h:
        for a in re.findall(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', h, re.S):
            href, txt = a
            t = clean(txt)
            if not (12 <= len(t) <= 70) or not re.search(r'news\.cn|/tech/', href):
                continue
            if t in seen:
                continue
            seen.add(t)
            url = href if href.startswith('http') else 'https://www.news.cn' + href
            # 从 URL 提取真实发布日期 /20260824/
            m = re.search(r'/(20\d{6})/', href)
            pub = (m.group(1)[:4] + '-' + m.group(1)[4:6] + '-' + m.group(1)[6:]) if m else \
                datetime.now().strftime('%Y-%m-%d')
            out.append((t, url, pub, ''))
    return out


SOURCES = [
    # (section, source_name, fetcher, is_low_value_filterable)
    ('安全与漏洞', 'CISA官方群', src_cisa, True),
    ('安全与漏洞', 'GitHub安全公告', src_github, True),
    ('安全与漏洞', '安全客', src_anquanke, True),
    ('安全与漏洞', 'FreeBuf', src_freebuf, True),
    ('人工智能', 'arXiv cs.AI', src_arxiv, False),
    ('科技数码', 'TechCrunch', src_techcrunch, False),
    ('科技数码', 'Ars Technica', src_ars, False),
    ('科技数码', 'IT之家', src_ithome, False),
    ('生活热点', '少数派', src_sspai, False),
    ('生活热点', '知乎热榜', src_zhihu, False),
    ('重要新闻', '中新网要闻', src_chinanews, False),
    ('重要新闻', '新华网科技', src_xinhua, False),
]


def main():
    limit = DEFAULT_LIMIT
    if '--limit' in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index('--limit') + 1])
        except (ValueError, IndexError):
            print(f'警告: --limit 参数无效，使用默认 {DEFAULT_LIMIT}', file=sys.stderr)
            limit = DEFAULT_LIMIT
    os.makedirs(KLOG, exist_ok=True)
    seen = set()
    if os.path.exists(SEEN):
        seen = set(l.strip() for l in open(SEEN, encoding='utf-8') if l.strip())

    date = datetime.now().strftime('%Y-%m-%d')
    sections, new_h = {}, []
    for section, sname, fetcher, filt in SOURCES:
        try:
            items = fetcher() or []
        except Exception:
            items = []
        if section not in sections:
            sections[section] = []
        added = 0
        # 审计修复（2026-08-25）：截断条件移入循环尾部——此前 items[:limit] 先截断，
        # 头部全为已见/低价值条目时新内容永不入候选，表现为假性"无新增"
        for (title, url, pub, summary) in items:
            if added >= limit:
                break
            title = clean(title)
            if not title or not url or url == '#':
                continue
            if filt and LOW_VALUE.search(title):
                continue
            h = hashlib.sha1(title.encode('utf-8')).hexdigest()[:16]
            if h in seen:
                continue
            sections[section].append((sname, title, url, pub, summary))
            new_h.append(h)
            added += 1
        if added:
            print(f'[{section}/{sname}] 新增 {added}', file=sys.stderr)
    # 写入 md
    added_total = len(new_h)
    if added_total:
        lines = [f'# 知识订阅 {date}\n']
        for section, items in sections.items():
            if not items:
                continue
            lines.append(f'\n## {section}\n')
            for sname, title, url, pub, summary in items:
                lines.append(f'- [{title}]({url})' + (f' ({pub})' if pub else ''))
                if summary:
                    lines.append(f'  [{sname}] {summary}')
        with open(os.path.join(KLOG, f'{date}.md'), 'a', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
        with open(SEEN, 'a', encoding='utf-8') as f:
            for h in new_h:
                f.write(h + '\n')
        print(f'新增 {added_total} 条 -> logs/knowledge/{date}.md')
    else:
        print('无新增（各源与上次一致）')
    today = os.path.join(KLOG, f'{date}.md')
    if os.path.exists(today):
        print('当日文件:', os.path.getsize(today), 'bytes')


if __name__ == '__main__':
    main()
