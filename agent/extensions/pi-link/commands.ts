/**
 * pi-link commands — /link command handler
 */
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { LinkConfig } from './config.ts'
import { getDevice, describeDevice, saveDevice } from './config.ts'
import { probeDevice, sendToDevice, watchRemote, readRemoteOutbox, attachToRemote } from './link.ts'
import { readActive, isActive, isUnattendedEnv } from './active.ts'
import { buildCard, validateCard, cardToDevice } from './card.ts'
import { fmtResult, ok, listDevices, helpText, cfgPathOf } from './helpers.ts'
import { OUTBOX_MAX } from './outbox.ts'

export function registerLinkCommand(pi: ExtensionAPI, getCfg: () => LinkConfig, refreshCfg: () => void, me: string): void {
  pi.registerCommand('link', {
    description: '多设备互联: /link send <设备> <消息> | status | help（pi-link 扩展）',
    getArgumentCompletions: (prefix) => {
      const cfg = getCfg()
      const p = prefix ?? ''
      const parts = p.trim().split(/\s+/)
      const first = parts[0] ?? ''
      if (!p.includes(' ')) {
        const base = ['send', 'status', 'watch', 'inbox', 'export-card', 'import-card', 'attach', 'help']
          .filter(c => c.startsWith(first))
        return base.map(c => ({
          value: c + ' ',
          label: c,
          description: c === 'send' ? '向设备发消息' :
                   c === 'status' ? '设备清单与连通性' :
                   c === 'watch' ? '观察远程会话' :
                   c === 'inbox' ? '读取远程信箱' :
                   c === 'export-card' ? '生成设备卡片' :
                   c === 'import-card' ? '导入设备卡片' :
                   c === 'attach' ? '介入远程输入' :
                   '用法'
        }))
      }
      if (first === 'send' && parts.length === 2) {
        const sub = parts[1] ?? ''
        return Object.keys(cfg.devices).filter(d => d.startsWith(sub)).map(d => ({
          value: d + ' ',
          label: d,
          description: describeDevice(d, cfg.devices[d]),
        }))
      }
      if (first === 'watch' && parts.length === 2) {
        const sub = parts[1] ?? ''
        return Object.keys(cfg.devices).filter(d => d.startsWith(sub)).map(d => ({
          value: d + ' ',
          label: d,
          description: describeDevice(d, cfg.devices[d]),
        }))
      }
      return []
    },
    handler: async (args: string, ctx) => {
      refreshCfg()
      const cfg = getCfg()
      const parts = (args ?? '').trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'help'
      const output = async (text: string) => {
        pi.sendMessage({ customType: 'pi-link', content: text, display: true }, { triggerTurn: false })
      }
      if (sub === 'help' || sub === '-h' || sub === '--help') {
        await output(helpText())
        return
      }
      if (sub === 'status') {
        const names = Object.keys(cfg.devices)
        if (names.length === 0) {
          ctx.ui.notify('未配置任何设备。编辑 ~/.pi/pi-link.json 添加（见 /link help）。', 'info')
          return
        }
        const lines = [`已配置 ${names.length} 台设备:`]
        const results = await Promise.allSettled(names.map((n) => probeDevice(cfg.devices[n])))
        names.forEach((n, i) => {
          const d = cfg.devices[n]
          const r = results[i].status === 'fulfilled'
            ? results[i].value
            : { ok: false, latencyMs: 0, detail: String((results[i] as PromiseRejectedResult).reason) }
          lines.push(`  ${r.ok ? '●' : '○'} ${describeDevice(n, d)} — ${r.ok ? `可达 ${r.latencyMs}ms` : `不可达: ${r.detail ?? ''}`}`)
        })
        await output(lines.join('\n'))
        return
      }
      if (sub === 'send') {
        const device = parts[1]
        const message = parts.slice(2).join(' ')
        if (!device || !message) {
          ctx.ui.notify('用法: /link send <设备> <消息>', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        const active = readActive()
        if ((isUnattendedEnv() || !isActive(active)) && !(cfg.allowUnattended ?? false)) {
          ctx.ui.notify('无人值守环境或本机长时间无交互，跨设备指令已拒绝（allowUnattended 可配置）', 'warning')
          return
        }
        const r = await sendToDevice(dev, message, { fromName: me }, cfg.defaultTimeoutSec)
        await output(fmtResult(r))
        return
      }
      if (sub === 'watch') {
        const device = parts[1]
        const rawLines = parts.includes('--lines') ? parseInt(parts[parts.indexOf('--lines') + 1] ?? '30', 10) : 30
        const lines = Number.isNaN(rawLines) || rawLines < 1 ? 30 : Math.min(rawLines, 200)
        if (!device) {
          ctx.ui.notify('用法: /link watch <设备> [--lines N]', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        const r = await watchRemote(dev, lines)
        await output(r.ok ? `远程 ${device} 会话尾部（${lines} 行）:\n\n${r.text}` : `观察失败: ${r.error}`)
        return
      }
      if (sub === 'inbox') {
        const device = parts[1]
        if (!device) {
          ctx.ui.notify('用法: /link inbox <设备>', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        const r = await readRemoteOutbox(dev)
        if (!r.ok) {
          await output(`读取失败: ${r.detail}`)
          return
        }
        const body = r.entries.length === 0
          ? '（空）'
          : r.entries.map((en, i) => `[${new Date(en.ts).toLocaleTimeString()}] ${en.text.slice(0, 300)}`).join('\n\n')
        await output(`远程 ${device} 信箱（${r.entries.length}/${OUTBOX_MAX} 条）：\n${body}`)
        return
      }
      if (sub === 'export-card') {
        const card = buildCard(cfg)
        await output('本机设备卡片（复制给其他设备 import-card）：\n' + JSON.stringify(card, null, 2))
        return
      }
      if (sub === 'import-card') {
        const raw = (args ?? '').trim().slice(sub.length).trim()
        if (!raw) {
          ctx.ui.notify('用法: /link import-card <卡片JSON>（可用 /link export-card 生成）', 'warning')
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          ctx.ui.notify('卡片不是合法 JSON', 'warning')
          return
        }
        const v = validateCard(parsed)
        if (!v.ok || !v.card) {
          ctx.ui.notify(`卡片无效: ${v.detail}`, 'warning')
          return
        }
        const r = saveDevice(cfgPathOf(), v.card.name, cardToDevice(v.card))
        await output(r.detail)
        return
      }
      if (sub === 'attach') {
        const force = parts.includes('--force')
        const rest = parts.filter((x) => x !== '--force')
        const device = rest[1]
        const text = rest.slice(2).join(' ')
        if (!device || !text) {
          ctx.ui.notify('用法: /link attach <设备> [--force] <要输入的文本>', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        const r = await attachToRemote(dev, text, undefined, force, me)
        await output(r.ok ? r.detail : `介入失败: ${r.detail}`)
        return
      }
      ctx.ui.notify(`未知子命令 "${sub}"。用法见 /link help`, 'warning')
    },
  })
}
