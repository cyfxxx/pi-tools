#!/usr/bin/env node
// ⚠ 本文件虽以 .sh 命名，实为 Node.js 脚本（历史命名保留，外部文档/记忆已引用此路径）。
// 请勿用 sh/bash 执行！正确用法：node scripts/pi-notify.sh [--dry-run] <subject> [<body>]
'use strict'
// pi-notify.sh —— 通用通知脚本（roadmap 阶段 3.3）
// 模板命令通道 + 去重 + 静默失败。任意推送服务（Bark/Server酱/Telegram/自定义 webhook）只需一条 curl 模板。
// 用法: pi-notify.sh [--dry-run] <subject> [<body>]
// 配置: ~/.pi/agent/notify.json（模板见 notify.example.json；含 token 不入库，gitignore）
// 行为: 未配置/disabled → 静默记日志退出 0；rateLimitMinutes 内同 subject 只发一次；发送失败不抛错。
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const AGENT = path.join(process.env.HOME || '.', '.pi', 'agent')
const CFG = path.join(AGENT, 'notify.json')
const STATE = path.join(AGENT, '.notify-state.json')
const LOG = path.join(AGENT, '..', 'logs', 'notify.log')

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const rest = args.filter(a => a !== '--dry-run')
const [subject = '', body = ''] = rest

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 日志失败不影响 */ }
}
const summary = s => { s = String(s ?? ''); return s.slice(0, 120) + (s.length > 120 ? '…' : '') }

// 无配置/未启用 → 静默
let cfg = null
try {
  cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'))
} catch (e) {
  if (e.code === 'ENOENT') { log(`skipped(subject=${summary(subject)}) no notify.json`); process.exit(0) }
  log(`skipped(subject=${summary(subject)}) bad config: ${e.message}`); process.exit(0)
}
if (cfg.enabled !== true) { log(`skipped(subject=${summary(subject)}) disabled`); process.exit(0) }

// 去重（防轰炸：先标记再发——失败也计入，避免重试轰炸；dry-run 不写状态）
const now = Date.now()
let state = {}
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { /* 首次 */ }
const rateMs = (cfg.rateLimitMinutes ?? 60) * 60000
const last = state[subject]
if (last && now - last < rateMs) { log(`skipped(subject=${summary(subject)}) rate-limited`); process.exit(0) }
if (!dry) {
  state[subject] = now
  try { fs.writeFileSync(STATE, JSON.stringify(state)) } catch { /* 状态写失败不阻塞 */ }
}

const enc = s => encodeURIComponent(String(s ?? ''))
const json = s => JSON.stringify(String(s ?? ''))
const sent = []

for (const ch of (cfg.channels || [])) {
  if (!ch || ch.enabled === false || !ch.template) continue
  let cmd = ch.template
    .replace(/\{\{subject\}\}/g, enc(subject))
    .replace(/\{\{body\}\}/g, enc(body))
    .replace(/\{\{subject_json\}\}/g, json(subject))
    .replace(/\{\{body_json\}\}/g, json(body))
  if (dry) { console.log(`[dry-run] ${ch.id || 'default'}: ${cmd}`); continue }
  try {
    execSync(cmd, { timeout: 15000, stdio: 'ignore', shell: '/bin/bash' })
    sent.push(ch.id || 'default')
  } catch (e) { log(`fail(channel=${ch.id || 'default'}): ${e.message}`) }
}

if (!dry && sent.length) {
  log(`sent(subject=${summary(subject)} channels=${sent.join(',')})`)
}
