import urllib.request
import json
import time
import sys
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

RESULTS_FILE = "/root/.pi/proxy_test_results_v2.json"
ALIVE_PROXIES = []
lock = __import__('threading').Lock()
proxies_tested = 0
total_proxies = 0

def test_proxy(proxy_url, timeout=10):
    result = {'proxy': proxy_url, 'http': False, 'https': False, 'google': False,
              'lat_http': 0, 'lat_https': 0, 'lat_google': 0, 'ip': '', 'error': ''}
    # 1. HTTP test
    try:
        proxy_handler = urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})
        opener = urllib.request.build_opener(proxy_handler)
        start = time.time()
        resp = opener.open('http://httpbin.org/ip', timeout=timeout)
        result['lat_http'] = time.time() - start
        result['http'] = True
        data = json.loads(resp.read())
        result['ip'] = data.get('origin', '?')
    except Exception as e:
        result['error'] = str(e)[:60]
        return result

    # 2. HTTPS test (Bing)
    try:
        start = time.time()
        resp = opener.open('https://www.bing.com/search?q=test&count=1', timeout=timeout)
        result['lat_https'] = time.time() - start
        result['https'] = True
    except Exception as e:
        pass

    # 3. Google test (GFW check)
    try:
        start = time.time()
        resp = opener.open('https://www.google.com/search?q=test&num=1', timeout=8)
        result['lat_google'] = time.time() - start
        result['google'] = True
    except Exception as e:
        pass

    return result

def main():
    global total_proxies, proxies_tested

    # Load all sources
    print('[1/4] 加载代理源...')

    # Source 1: Proxifly non-CN
    non_cn = []
    try:
        url = 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.json'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, timeout=30)
        data = json.loads(resp.read())
        for p in data:
            country = p.get('geolocation', {}).get('country', '')
            proto = p.get('protocol', '')
            proxy_str = p.get('proxy', '')
            if country != 'CN' and proto == 'http' and proxy_str:
                non_cn.append({'proxy': f'http://{proxy_str}', 'source': 'proxifly', 'country': country})
        print(f'  Proxifly non-CN: {len(non_cn)}')
    except Exception as e:
        print(f'  Proxifly FAIL: {e}')

    # Source 2: Geonode
    geonode_proxies = []
    try:
        for page in range(1, 5):
            url = f'https://proxylist.geonode.com/api/proxy-list?limit=100&page={page}&sort_by=lastChecked&sort_type=desc'
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            resp = urllib.request.urlopen(req, timeout=15)
            d = json.loads(resp.read())
            for item in d.get('data', []):
                ip = item.get('ip', '')
                port = item.get('port', '')
                country = item.get('country', '')
                protocols = item.get('protocols', [])
                if ip and port:
                    geonode_proxies.append({
                        'proxy': f'http://{ip}:{port}',
                        'source': 'geonode',
                        'country': country
                    })
            if len(d.get('data', [])) < 100:
                break
        print(f'  Geonode: {len(geonode_proxies)}')
    except Exception as e:
        print(f'  Geonode FAIL: {e}')

    # Source 3: FreeVPNNode
    fvn_proxies = []
    try:
        url = 'https://cn.freevpnnode.com/free-proxy/'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, timeout=15)
        html = resp.read().decode('utf-8', errors='replace')
        # Parse IP:port from HTML tables
        for tr_match in re.finditer(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL):
            cells = re.findall(r'<td[^>]*>(.*?)</td>', tr_match.group(1))
            if len(cells) >= 2:
                ip = re.sub(r'<[^>]+>', '', cells[0]).strip()
                port = re.sub(r'<[^>]+>', '', cells[1]).strip()
                if re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$', ip) and port.isdigit():
                    fvn_proxies.append({
                        'proxy': f'http://{ip}:{port}',
                        'source': 'freevpnnode',
                        'country': '?'
                    })
        print(f'  FreeVPNNode: {len(fvn_proxies)}')
    except Exception as e:
        print(f'  FreeVPNNode FAIL: {e}')

    all_proxies = non_cn + geonode_proxies + fvn_proxies
    total_proxies = len(all_proxies)
    print(f'\n  总计: {total_proxies} 个代理')
    print()

    # Batch test
    print('[2/4] 批量测试 (50 并发 HTTP + HTTPS + Google)...')
    proxies_tested = 0
    results = {'alive': [], 'country_stats': Counter()}

    with ThreadPoolExecutor(max_workers=50) as executor:
        futures = {executor.submit(test_proxy, p['proxy']): p for p in all_proxies}
        for f in as_completed(futures):
            p_info = futures[f]
            r = f.result()
            proxies_tested += 1
            sys.stdout.write(f'\r  进度: {proxies_tested}/{total_proxies} | HTTP={results["country_stats"]["http"]} | HTTPS={results["country_stats"]["https"]} | Google={results["country_stats"]["google"]}')
            sys.stdout.flush()
            if r.get('http'):
                results['country_stats']['http'] += 1
                results['alive'].append({
                    **r,
                    'source': p_info['source'],
                    'country': p_info['country'],
                })
                if r.get('https'):
                    results['country_stats']['https'] += 1
                if r.get('google'):
                    results['country_stats']['google'] += 1

    print()
    print()

    # Results
    print('[3/4] 分析结果...')
    http_alive = [p for p in results['alive'] if p.get('http')]
    https_alive = [p for p in results['alive'] if p.get('https')]
    google_alive = [p for p in results['alive'] if p.get('google')]

    print(f'\n  HTTP 存活:  {len(http_alive)}')
    print(f'  HTTPS 存活: {len(https_alive)}')
    print(f'  Google 可达: {len(google_alive)}')
    print()

    if google_alive:
        print('=== 可访问 Google 的代理 ===')
        google_alive.sort(key=lambda x: x['lat_google'])
        for p in google_alive[:20]:
            print(f'  [{p["country"]}] {p["proxy"]} Google={p["lat_google"]*1000:.0f}ms HTTPS={p.get("lat_https",0)*1000:.0f}ms')

        # Save alive proxies
        with open('/root/.pi/searxng/proxy_list_global.txt', 'w') as f:
            for p in google_alive:
                f.write(f'{p["proxy"]}\n')
        print(f'\n已保存 {len(google_alive)} 个可用代理到 proxy_list_global.txt')
    elif https_alive:
        print('=== 支持 HTTPS 的代理 ===')
        https_alive.sort(key=lambda x: x['lat_https'])
        for p in https_alive[:20]:
            print(f'  [{p["country"]}] {p["proxy"]} HTTPS={p.get("lat_https",0)*1000:.0f}ms')
        
        with open('/root/.pi/searxng/proxy_list_global.txt', 'w') as f:
            for p in https_alive:
                f.write(f'{p["proxy"]}\n')
        print(f'\n已保存 {len(https_alive)} 个 HTTPS 代理到 proxy_list_global.txt')
    
    # Save full results
    with open(RESULTS_FILE, 'w') as f:
        json.dump({
            'timestamp': time.time(),
            'total_tested': total_proxies,
            'http_alive': len(http_alive),
            'https_alive': len(https_alive),
            'google_alive': len(google_alive),
            'proxies': results['alive'],
            'sources': {
                'proxifly_non_cn': len(non_cn),
                'geonode': len(geonode_proxies),
                'freevpnnode': len(fvn_proxies),
            }
        }, f, indent=2, ensure_ascii=False)
    print(f'\n详细结果保存: {RESULTS_FILE}')

    # Country distribution of alive proxies
    country_counts = Counter(p.get('country', '?') for p in results['alive'] if p.get('http'))
    print(f'\n--- 国家分布 (HTTP 存活) ---')
    for c, n in country_counts.most_common(15):
        print(f'  {c}: {n}')

    # Summary
    print(f'\n[4/4] 总结')
    print(f'  HTTP 存活:     {len(http_alive)}/{total_proxies} ({len(http_alive)/max(total_proxies,1)*100:.1f}%)')
    print(f'  HTTPS 存活:    {len(https_alive)}/{total_proxies} ({len(https_alive)/max(total_proxies,1)*100:.1f}%)')
    print(f'  Google 可达:   {len(google_alive)}/{total_proxies} ({len(google_alive)/max(total_proxies,1)*100:.1f}%)')

if __name__ == '__main__':
    main()
