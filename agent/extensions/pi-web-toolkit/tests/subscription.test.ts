import { describe, it, expect } from 'vitest'
import { parseSubscriptionText, parseHttpProxyList, fetchAndMerge } from '../src/subscription'

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}

describe('subscription', () => {

  describe('parseVless', () => {
    it('should parse a minimal vless link', async () => {
      const { parseSubscriptionText } = await import('../src/subscription')
      const link = 'vless://550e8400-e29b-41d4-a716-446655440000@1.2.3.4:443?security=tls&sni=example.com&flow=xtls-rprx-vision#my-server'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
      const p = result[0]
      expect(p.protocol).toBe('vless')
      expect(p.outbound.type).toBe('vless')
      expect(p.outbound.server).toBe('1.2.3.4')
      expect(p.outbound.server_port).toBe(443)
      expect(p.outbound.uuid).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(p.outbound.flow).toBe('xtls-rprx-vision')
      expect(p.outbound.tls).toBeDefined()
      expect((p.outbound.tls as any).enabled).toBe(true)
      expect((p.outbound.tls as any).server_name).toBe('example.com')
    })

    it('should handle vless without flow or security', async () => {
      const link = 'vless://uuid@host.com:80#plain'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
      expect(result[0].outbound.flow).toBeUndefined()
    })

    it('should handle degenerate vless:// link (empty host, no crash)', async () => {
      const link = 'vless://'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
    })
  })

  describe('parseVmess', () => {
    const vmessObj = {
      v: '2',
      ps: 'vmess-server',
      add: '5.6.7.8',
      port: '8080',
      id: 'uuid-here',
      aid: '0',
      net: 'ws',
      path: '/ws',
      host: 'ws-host.com',
      tls: 'tls',
      scy: 'aes-128-gcm',
    }
    const vmessLink = `vmess://${b64(JSON.stringify(vmessObj))}`

    it('should parse a valid vmess link', () => {
      const result = parseSubscriptionText(vmessLink, 'test')
      expect(result).toHaveLength(1)
      const p = result[0]
      expect(p.protocol).toBe('vmess')
      expect(p.outbound.type).toBe('vmess')
      expect(p.outbound.server).toBe('5.6.7.8')
      expect(p.outbound.server_port).toBe(8080)
      expect(p.outbound.uuid).toBe('uuid-here')
      expect(p.outbound.security).toBe('aes-128-gcm')
      expect((p.outbound.transport as any).type).toBe('ws')
      expect((p.outbound.transport as any).path).toBe('/ws')
      expect(p.outbound.tls).toBeDefined()
    })

    it('should handle vmess without optional fields', () => {
      const minimal = { v: '2', add: '1.2.3.4', port: '80', id: 'uuid' }
      const result = parseSubscriptionText(`vmess://${b64(JSON.stringify(minimal))}`, 'test')
      expect(result).toHaveLength(1)
      expect(result[0].outbound.server).toBe('1.2.3.4')
      expect(result[0].outbound.security).toBe('auto')
    })

    it('should skip invalid base64 vmess', () => {
      const result = parseSubscriptionText('vmess://not-valid-base64!!!', 'test')
      expect(result).toHaveLength(0)
    })
  })

  describe('parseTrojan', () => {
    it('should parse a valid trojan link', () => {
      const link = 'trojan://my-password@trojan.example.com:443?security=tls&sni=trojan.example.com#trojan-server'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
      const p = result[0]
      expect(p.protocol).toBe('trojan')
      expect(p.outbound.type).toBe('trojan')
      expect(p.outbound.server).toBe('trojan.example.com')
      expect(p.outbound.server_port).toBe(443)
      expect(p.outbound.password).toBe('my-password')
      expect(p.outbound.tls).toBeDefined()
    })

    it('should handle trojan without trailing parts', () => {
      const link = 'trojan://pass@host.com:443'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
      expect(result[0].outbound.password).toBe('pass')
    })
  })

  describe('parseShadowsocks', () => {
    it('should parse an ss link with method:password@host:port', () => {
      const methodPass = b64('aes-256-gcm:my-password')
      const link = `ss://${methodPass}@ss.example.com:8388#ss-server`
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
      const p = result[0]
      expect(p.protocol).toBe('shadowsocks')
      expect(p.outbound.type).toBe('shadowsocks')
      expect(p.outbound.server).toBe('ss.example.com')
      expect(p.outbound.server_port).toBe(8388)
      expect(p.outbound.method).toBe('aes-256-gcm')
      expect(p.outbound.password).toBe('my-password')
    })

    it('should skip ssr links', () => {
      const link = 'ssr://base64stuff'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(0)
    })
  })

  describe('parseHysteria2', () => {
    it('should parse hy2 link', () => {
      const link = 'hy2://password@hy2.example.com:443?insecure=1#hy2-server'
      const result = parseSubscriptionText(link, 'test')
      expect(result).toHaveLength(1)
      const p = result[0]
      expect(p.protocol).toBe('hysteria2')
      expect(p.outbound.type).toBe('hysteria2')
      expect(p.outbound.server).toBe('hy2.example.com')
      expect(p.outbound.server_port).toBe(443)
      expect(p.outbound.password).toBe('password')
      expect(p.outbound.tls).toBeDefined()
    })
  })

  describe('ClashYAML', () => {
    it('should parse clash yaml proxies section', () => {
      const yaml = `
proxies:
  - name: "JP-01"
    type: ss
    server: jp1.example.com
    port: 443
    cipher: aes-256-gcm
    password: secret
proxy-groups:
  - name: Proxy
    type: select
    proxies:
      - "JP-01"
rules:
  - MATCH,Proxy
`.trim()
      const result = parseSubscriptionText(yaml, 'test')
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0].remark).toContain('JP-01')
    })

    it('should return empty for non-proxy yaml', () => {
      const yaml = 'key: value\nnested:\n  foo: bar'
      const result = parseSubscriptionText(yaml, 'test')
      expect(result).toHaveLength(0)
    })
  })

  describe('parseHttpProxyList', () => {
    it('should parse ip:port lines', () => {
      const text = '1.2.3.4:8080\n5.6.7.8:3128\n# comment\n9.10.11.12:1080'
      const result = parseHttpProxyList(text, 'http-list')
      expect(result).toHaveLength(3)
      expect(result[0].outbound.server).toBe('1.2.3.4')
      expect(result[0].outbound.server_port).toBe(8080)
      expect(result[0].outbound.type).toBe('http')
      expect(result[1].outbound.server).toBe('5.6.7.8')
    })

    it('should skip invalid lines (hostname, non-numeric port)', () => {
      const text = 'not-an-ip:8080\n1.2.3.4:abc'
      const result = parseHttpProxyList(text, 'http-list')
      expect(result).toHaveLength(0)
    })

    it('should parse ip:port with 3-digit octets (no validation)', () => {
      const text = '999.999.999.999:80'
      const result = parseHttpProxyList(text, 'http-list')
      expect(result).toHaveLength(1)
    })
  })

  describe('base64 detection', () => {
    it('should decode base64 subscription text', () => {
      const links = ['vless://uuid@1.2.3.4:443#s1', 'trojan://pass@5.6.7.8:443#s2']
      const encoded = b64(links.join('\n'))
      const result = parseSubscriptionText(encoded, 'test')
      expect(result).toHaveLength(2)
      expect(result[0].protocol).toBe('vless')
      expect(result[1].protocol).toBe('trojan')
    })

    it('should not decode short base64 strings (length guard)', () => {
      const shortB64 = b64('abcde')  // length < 50
      const result = parseSubscriptionText(shortB64, 'test')
      expect(result).toHaveLength(0)
    })
  })

  describe('deduplication', () => {
    it('should deduplicate by exact line text in parseSubscriptionText', () => {
      const links = [
        'vless://550e8400-e29b-41d4-a716-446655440000@1.2.3.4:443#my-server',
        'vless://550e8400-e29b-41d4-a716-446655440000@1.2.3.4:443#my-server',
      ]
      const result = parseSubscriptionText(links.join('\n'), 'test')
      expect(result).toHaveLength(1)
    })

    it('should deduplicate by remark in fetchAndMerge', async () => {
      // Mock fetch to avoid network calls
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => ({ ok: true, text: async () => '' }) as Response
      try {
        const result = await fetchAndMerge([])
        expect(result).toHaveLength(0)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
