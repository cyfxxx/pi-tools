import { describe, expect, it } from 'vitest'
import {
  isValidIpv4,
  selectLanIPv4,
  looksLikeWsl,
  parseIpconfig,
  type IfaceInfo,
} from '../lanip.ts'

const nic = (name: string, address: string): IfaceInfo => ({ name, address })

describe('pi-link lanip: isValidIpv4', () => {
  it('合法 IPv4 通过', () => {
    expect(isValidIpv4('192.168.1.1')).toBe(true)
    expect(isValidIpv4('0.0.0.0')).toBe(true)
    expect(isValidIpv4('255.255.255.255')).toBe(true)
  })
  it('拒绝越界/缺段/杂字符', () => {
    expect(isValidIpv4('256.1.1.1')).toBe(false)
    expect(isValidIpv4('1.2.3')).toBe(false)
    expect(isValidIpv4('1.2.3.4.5')).toBe(false)
    expect(isValidIpv4('a.b.c.d')).toBe(false)
    expect(isValidIpv4('')).toBe(false)
    expect(isValidIpv4('01.02.03.04')).toBe(true) // 数字段允许前导零写法
  })
})

describe('pi-link lanip: selectLanIPv4 打分选卡', () => {
  it('RFC1918 私网优先于公网地址', () => {
    expect(selectLanIPv4([nic('eth0', '92.168.1.5'), nic('eth0', '8.8.8.8')])).toBe('92.168.1.5')
  })
  it('物理网卡名加分压过 VPN/虚拟网卡', () => {
    // dsh-pocket 场景：Windows 枚举把 vEthernet (WSL)/Tailscale 排在 WLAN 前
    const list = [nic('vEthernet (WSL)', '172.20.0.1'), nic('WLAN', '192.168.1.100')]
    expect(selectLanIPv4(list)).toBe('192.168.1.100')
  })
  it('tailscale/tun 等虚拟网卡名被降权', () => {
    const list = [nic('tailscale0', '100.64.0.1'), nic('wlan0', '10.0.0.5')]
    expect(selectLanIPv4(list)).toBe('10.0.0.5')
  })
  it('排除回环与 link-local，过滤非法段', () => {
    const list = [
      nic('lo', '127.0.0.1'),
      nic('docker0', '169.254.9.9'),
      nic('bad', '999.1.1.1'),
      nic('en0', '192.168.0.7'),
    ]
    expect(selectLanIPv4(list)).toBe('192.168.0.7')
  })
  it('纯公网环境仍返回兜底地址', () => {
    expect(selectLanIPv4([nic('eth0', '8.8.8.8')])).toBe('8.8.8.8')
  })
  it('同分保持枚举序（稳定）', () => {
    const list = [nic('eth0', '10.0.0.1'), nic('enp3s0', '10.0.0.2')]
    expect(selectLanIPv4(list)).toBe('10.0.0.1')
  })
  it('空列表返回 undefined', () => {
    expect(selectLanIPv4([])).toBeUndefined()
  })
})

describe('pi-link lanip: looksLikeWsl', () => {
  it('/proc/version 含 microsoft/wsl 命中', () => {
    expect(looksLikeWsl('Linux version 5.15.153.1-microsoft-standard-WSL2', {})).toBe(true)
    expect(looksLikeWsl('Linux version 4.4.0-19041-Microsoft (WSL1)', {})).toBe(true)
  })
  it('普通 Linux 内核串不命中', () => {
    expect(looksLikeWsl('Linux version 6.8.0-45-generic', {})).toBe(false)
  })
  it('WSL_DISTRO_NAME/WSL_INTEROP 兜底命中', () => {
    expect(looksLikeWsl(undefined, { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true)
    expect(looksLikeWsl(undefined, { WSL_INTEROP: '/run/WSL/interop' })).toBe(true)
  })
  it('明确不用 WSLENV 判断（Windows Terminal 在原生 Windows 也设它，会误判）', () => {
    expect(looksLikeWsl(undefined, { WSLENV: 'some/var' })).toBe(false)
  })
})

describe('pi-link lanip: parseIpconfig', () => {
  const ZH = [
    '',
    'Windows IP 配置',
    '',
    '无线局域网适配器 WLAN:',
    '',
    '   连接特定的 DNS 后缀 . . . . . . . . . . : ',
    '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100',
    '   子网掩码  . . . . . . . . . . . . : 255.255.255.0',
    '',
    '以太网适配器 vEthernet (WSL):',
    '',
    '   连接特定的 DNS 后缀 . . . . . . . . . . : ',
    '   IPv4 地址 . . . . . . . . . . . . : 172.20.0.1',
    '',
  ].join('\r\n')

  it('中文输出：解析物理网卡、跳过 WSL 虚拟块', () => {
    const r = parseIpconfig(ZH)
    expect(r).toEqual([{ name: '无线局域网适配器 WLAN:', address: '192.168.1.100' }])
    expect(selectLanIPv4(r)).toBe('192.168.1.100')
  })

  it('英文输出：宽容匹配 "(Preferred)" 尾注', () => {
    const EN = [
      'Ethernet adapter Ethernet:',
      '   IPv4 Address. . . . . . . . . . . : 10.1.2.3(Preferred)',
      '',
      'Ethernet adapter Tailscale:',
      '   IPv4 Address. . . . . . . . . . . : 100.64.0.2(Preferred)',
    ].join('\r\n')
    const r = parseIpconfig(EN)
    expect(r).toEqual([{ name: 'Ethernet adapter Ethernet:', address: '10.1.2.3' }])
  })

  it('空文本与无 IPv4 文本返回空数组', () => {
    expect(parseIpconfig('')).toEqual([])
    expect(parseIpconfig('Windows IP 配置\r\n没有可用连接')).toEqual([])
  })
})
