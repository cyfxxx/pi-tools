import urllib.request
import json
import time
import threading
import socket
import ssl
import sys
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

RESULTS_FILE = "/root/.pi/proxy_test_results.json"
ALIVE_FILE = "/root/.pi/searxng/proxy_list.txt"
SOURCE_URL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt"

ALIVE_PROXIES = []
lock = threading.Lock()
proxies_tested = 0
total_proxies = 0

def fetch_proxy_list(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    resp = urllib.request.urlopen(req, timeout=15)
    text = resp.read().decode()
    proxies = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith('#')]
    return proxies

def categorize(proxies):
    http, https, socks4, socks5 = [], [], [], []
    for p in proxies:
        if p.startswith('http://'): http.append(p)
        elif p.startswith('https://'): https.append(p)
        elif p.startswith('socks4://'): socks4.append(p)
        elif p.startswith('socks5://'): socks5.append(p)
    return http, https, socks4, socks5

def test_http_proxy_http(proxy, timeout=8):
    try:
        proxy_handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
        opener = urllib.request.build_opener(proxy_handler)
        start = time.time()
        resp = opener.open('http://httpbin.org/ip', timeout=timeout)
        lat = time.time() - start
        data = json.loads(resp.read())
        ip = data.get('origin', '?')
        return True, lat, ip
    except Exception as e:
        return False, 0, str(e)[:60]

def test_http_proxy_https(proxy, timeout=10):
    try:
        proxy_handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
        opener = urllib.request.build_opener(proxy_handler)
        start = time.time()
        resp = opener.open('https://www.bing.com/search?q=test&count=1', timeout=timeout)
        lat = time.time() - start
        return True, lat, resp.status
    except Exception as e:
        err = str(e)[:60]
        if 'Tunnel' in err or 'CONNECT' in err:
            return False, 0, 'NO_HTTPS_TUNNEL'
        return False, 0, err

def test_socks5_proxy(proxy, timeout=10):
    try:
        import socks as sockslib
        parsed = proxy.replace('socks5://', '')
        host, port_str = parsed.split(':')
        port = int(port_str)
        
        start = time.time()
        s = sockslib.socksocket()
        s.set_proxy(sockslib.SOCKS5, host, port)
        s.settimeout(timeout)
        s.connect(('httpbin.org', 80))
        s.sendall(b'GET /ip HTTP/1.0\r\nHost: httpbin.org\r\n\r\n')
        data = b''
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            data += chunk
        s.close()
        lat = time.time() - start
        if b'200 OK' in data or b'"origin"' in data:
            return True, lat, 'HTTP_OK'
        return False, lat, 'BAD_RESP'
    except Exception as e:
        return False, 0, str(e)[:60]

def test_socks4_proxy(proxy, timeout=10):
    try:
        import socks as sockslib
        parsed = proxy.replace('socks4://', '')
        host, port_str = parsed.split(':')
        port = int(port_str)
        
        start = time.time()
        s = sockslib.socksocket()
        s.set_proxy(sockslib.SOCKS4, host, port)
        s.settimeout(timeout)
        s.connect(('httpbin.org', 80))
        s.sendall(b'GET /ip HTTP/1.0\r\nHost: httpbin.org\r\n\r\n')
        data = b''
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            data += chunk
        s.close()
        lat = time.time() - start
        if b'200 OK' in data or b'"origin"' in data:
            return True, lat, 'HTTP_OK'
        return False, lat, 'BAD_RESP'
    except Exception as e:
        return False, 0, str(e)[:60]

def worker_http(p, results):
    global proxies_tested
    alive_http, lat_http, info_http = test_http_proxy_http(p)
    if alive_http:
        alive_https, lat_https, info_https = test_http_proxy_https(p)
        if alive_https:
            with lock:
                results['http_both'] += 1
                ALIVE_PROXIES.append((p, lat_https, 'HTTP+HTTPS'))
                results['alive'].append({'proxy': p, 'type': 'HTTP', 'lat_http': round(lat_http,2), 'lat_https': round(lat_https,2), 'https': True, 'ip': info_http})
        else:
            with lock:
                results['http_http_only'] += 1
                ALIVE_PROXIES.append((p, lat_http, 'HTTP_only'))
                results['alive'].append({'proxy': p, 'type': 'HTTP', 'lat_http': round(lat_http,2), 'https': False, 'ip': info_http})
    else:
        with lock:
            results['http_dead'] += 1
    with lock:
        proxies_tested += 1
        sys.stdout.write(f'\r  HTTP: {proxies_tested}/{total_proxies} tested, alive: {results["http_both"]+results["http_http_only"]}')
        sys.stdout.flush()

socks_tested_counter = 0
socks_total_counter = 0

def worker_socks(p, proxy_type, results):
    global socks_tested_counter
    test_fn = test_socks5_proxy if proxy_type == 'SOCKS5' else test_socks4_proxy
    alive, lat, info = test_fn(p)
    with lock:
        socks_tested_counter += 1
        if alive:
            ALIVE_PROXIES.append((p, lat, proxy_type))
            results['alive'].append({'proxy': p, 'type': proxy_type, 'lat': round(lat,2)})
            results[f'{proxy_type.lower()}_alive'] += 1
        else:
            results[f'{proxy_type.lower()}_dead'] += 1
        sys.stdout.write(f'\r  {proxy_type}: {socks_tested_counter}/{socks_total_counter} tested, alive: {results.get(proxy_type.lower()+"_alive",0)}')
        sys.stdout.flush()

def main():
    global total_proxies, proxies_tested

    print('=== 全量代理测试 ===')
    print(f'源: {SOURCE_URL}')
    print()

    # 1. 获取代理列表
    print('[1/3] 获取代理列表...')
    proxies = fetch_proxy_list(SOURCE_URL)
    http, https, socks4, socks5 = categorize(proxies)
    total_proxies = len(proxies)
    print(f'  总计: {len(proxies)}')
    print(f'  HTTP: {len(http)}, HTTPS: {len(https)}, SOCKS4: {len(socks4)}, SOCKS5: {len(socks5)}')
    print()

    results = {
        'alive': [],
        'http_both': 0, 'http_http_only': 0, 'http_dead': 0,
        'socks5_alive': 0, 'socks5_dead': 0,
        'socks4_alive': 0, 'socks4_dead': 0,
    }

    # 2. 并行测试 HTTP 代理
    print('[2/3] 测试 HTTP 代理 (HTTP + HTTPS CONNECT)...')
    proxies_tested = 0
    with ThreadPoolExecutor(max_workers=50) as executor:
        futures = [executor.submit(worker_http, p, results) for p in http]
        for f in as_completed(futures):
            pass
    print()
    http_dead = len(http) - results['http_both'] - results['http_http_only']
    print(f'  HTTP+HTTPS: {results["http_both"]}, HTTP only: {results["http_http_only"]}, Dead: {http_dead}')
    print()

    # 3. 测试 SOCKS5
    if socks5:
        global socks_tested_counter, socks_total_counter
        socks_tested_counter = 0
        socks_total_counter = len(socks5)
        print(f'[3/3] 测试 SOCKS5 代理 ({len(socks5)} 个)...')
        with ThreadPoolExecutor(max_workers=30) as executor:
            futures = [executor.submit(worker_socks, p, 'SOCKS5', results) for p in socks5]
            for f in as_completed(futures):
                pass
        print()
        print(f'  SOCKS5 alive: {results["socks5_alive"]}, dead: {results.get("socks5_dead",0)}')
    else:
        print('[3/3] 无 SOCKS5 代理')
    print()

    # 4. 测试 SOCKS4
    if socks4:
        socks_tested_counter = 0
        socks_total_counter = len(socks4)
        print(f'  测试 SOCKS4 代理 ({len(socks4)} 个)...')
        with ThreadPoolExecutor(max_workers=30) as executor:
            futures = [executor.submit(worker_socks, p, 'SOCKS4', results) for p in socks4]
            for f in as_completed(futures):
                pass
        print()
        print(f'  SOCKS4 alive: {results["socks4_alive"]}, dead: {results.get("socks4_dead",0)}')
    else:
        print('  无 SOCKS4 代理')
    print()

    # 5. 输出结果
    print('=== 测试完成 ===')
    ALIVE_PROXIES.sort(key=lambda x: x[1])
    
    print(f'\n存活代理: {len(ALIVE_PROXIES)}')
    print(f'  HTTP+HTTPS: {results["http_both"]}')
    for p, lat, ptype in ALIVE_PROXIES:
        print(f'  [{ptype}] {p} (延迟: {lat*1000:.0f}ms)')

    # 6. 保存测试结果
    with open(RESULTS_FILE, 'w') as f:
        json.dump({
            'timestamp': time.time(),
            'total_tested': len(proxies),
            'http_total': len(http),
            'socks4_total': len(socks4),
            'socks5_total': len(socks5),
            'alive': results['alive'],
            'summary': {
                'http_https': results['http_both'],
                'http_only': results['http_http_only'],
                'socks5_alive': results['socks5_alive'],
                'socks4_alive': results['socks4_alive'],
            }
        }, f, indent=2, ensure_ascii=False)
    print(f'\n详细结果已保存: {RESULTS_FILE}')

    # 7. 写入存活代理列表文件（供 proxy_source_url 或手工使用）
    with open(ALIVE_FILE, 'w') as f:
        for p, lat, ptype in ALIVE_PROXIES:
            f.write(f'{p}\n')
    print(f'存活代理列表已保存: {ALIVE_FILE} ({len(ALIVE_PROXIES)} 个)')

if __name__ == '__main__':
    main()
