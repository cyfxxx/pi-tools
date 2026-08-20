#!/usr/bin/env node
// ntfy-relay.js —— 手机 → pi 实时通道
// 链路: 手机 ntfy app 发 "pi: <指令>" → 主题 → 本守护（轮询订阅）→ 校验前缀
//        → 注入（injectMode=rpc 本地独立调用 / tmux 注入当前会话）→ ack 回手机。
// 安全: 主题即密钥（随机 hex，勿泄露）；仅接受 "<prefix> " 前缀消息；不注入自身回执。
// 用法: node scripts/ntfy-relay.js            # 守护（断线自动重连）
//       node scripts/ntfy-relay.js --check    # 预览将执行的动作，不注入
//       node scripts/ntfy-relay.js --once     # 拉取历史一条并处理（除 --check 外会注入）
// 配置: agent/ntfy-relay.json（可空 {}；topic 缺省从 notify.json 的通道 template 自动解析）
const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { createInterface } = require('readline')

const HOME = process.env.HOME || '.'
const AGENT = path.join(HOME, '.pi', 'agent')
const LOGF = path.join(HOME, '.pi', 'logs', 'ntfy-relay.log')
const RELAY_CFG = path.join(AGENT, 'ntfy-relay.json')
const NOTIFY_CFG = path.join(AGENT, 'notify.json')
const LINK_STATE = path.join(HOME, '.pi', 'pi-link-state.json')
const INBOX = path.join(AGENT, 'ntfy-inbox.json')
const STATE = path.join(AGENT, '.ntfy-relay-state.json')

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const ONCE = args.includes('--once')
const now = () => new Date().toISOString()
function log(line) { try { fs.appendFileSync(LOGF, `${now()} ${line}\n`) } catch { /* */ } }

// ── 配置 ├──────────────
function loadCfg() {
  let c = {}
  try { c = JSON.parse(fs.readFileSync(RELAY_CFG, 'utf8')) } catch { /* 可空 */ }
  let topic = c.topic
  if (!topic) {
    try {
      const n = JSON.parse(fs.readFileSync(NOTIFY_CFG, 'utf8'))
      for (const ch of (n.channels || [])) {
        const tpl = ch?.template || ''
        const mBody = /"topic"\s*:\s*"([\w-]+)"/.exec(tpl) // body 带 topic 形态
        const mUrl = /ntfy\.sh\/([\w-]+)/.exec(tpl) // URL 路径形态
        const t = mBody ? mBody[1] : (mUrl && mUrl[1])
        if (t) { topic = t; break }
      }
    } catch { /* */ }
  }
  return {
    topic: c.topic || topic || '',
    server: c.server || 'https://ntfy.sh',
    prefix: c.prefix || 'pi:',
    tmuxSession: c.tmuxSession || '',
    stateFile: c.stateFile || LINK_STATE,
    injectMode: c.injectMode || 'rpc', // rpc=本地独立调用（tmux 故障兜底）；tmux=注入当前会话
  }
}
const cfg = loadCfg()
if (!cfg.topic) { console.error('未解析到 ntfy 主题（通知 notify.json 或配置 agent/ntfy-relay.json.topic）'); process.exit(2) }

// ── 持久状态（去重）──
let st = { lastId: '', seen: {}, n: 0 }
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { /* 首次 */ }
const remember = id => { st.seen[id] = Date.now(); st.lastId = id; st.n++; const k = Object.keys(st.seen); if (k.length > 2000) delete st.seen[k[0]]; try { fs.writeFileSync(STATE, JSON.stringify(st)) } catch { /* */ } }
const seen = id => Boolean(st.seen[id])

// ── tmux 注入（复刻 pi-link link.ts:586-610，本机执行）────
function tmuxSessionName() {
  if (cfg.tmuxSession) return cfg.tmuxSession
  try { const d = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); if (d.tmuxSession) return String(d.tmuxSession) } catch { /* */ }
  try {
    const out = execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 3000 })
    const list = out.split('\n').map(s => s.trim()).filter(Boolean)
    // 偏好含 pi 或数值会话名（pi 通常跑在单会话）；取最后一个
    return list.find(s => /pi/i.test(s)) || list[list.length - 1] || ''
  } catch { return '' }
}
function inputBoxBusy(sess) {
  // 输入框非空（非 ~ / 非状态栏）→ 正在生成/打字，拒绝注入
  try {
    const cap = execFileSync('tmux', ['capture-pane', '-p', '-t', sess], { encoding: 'utf8', timeout: 4000 })
    const lines = cap.split('\n').filter(l => l.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (/──/.test(l) || /[•·]/.test(l) && /token|模型/.test(l)) continue // 分隔线/状态栏
      if (l.trim().startsWith('~')) return false // 空输入框
      return true // 输入框有内容
    }
    return false
  } catch { return false }
}
function inject(sess, text) {
  const s = `'${String(sess).replace(/'/g, `'\\''`)}'`
  const b64 = Buffer.from(text, 'utf-8').toString('base64')
  const buf = 'pi-relay-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const tmp = `${HOME}/.pi-relay-msg.tmp-${Date.now().toString(36)}`
  const cat = `printf %s ${b64} | base64 -d > ${tmp} && ` +
    `tmux load-buffer -b ${buf} ${tmp} && ` +
    `tmux paste-buffer -b ${buf} -t ${s} && ` +
    `sleep 0.5 && tmux send-keys -t ${s} Enter; rm -f ${tmp}`
  execFileSync('bash', ['-c', cat], { timeout: 6000, stdio: 'ignore' })
}

// 回复/ack：curl POST 根 URL + body 带 topic（官方推荐形态，title/message 正确解析、手机显示美观）；
// 不经 pi-notify 去重；消息不含 prefix → 不会被自身轮询注入
function ntfypost(obj) {
  try {
    const body = JSON.stringify({ topic: cfg.topic, ...obj })
    execFileSync('curl', ['-fsS', '--max-time', '8', '-H', 'Content-Type: application/json', '-d', body, cfg.server.replace(/\/$/, '') + '/'], { timeout: 10000, stdio: 'ignore' })
  } catch { /* 静默 */ }
}
function ack(line) { ntfypost({ title: 'pi 控制通道', message: line, tags: ['robot_face'] }); log(`ack: ${line}`) }

// ── 消息解析（兼容 pi-notify 的 JSON 形态与用户纯文本）──
// ── RPC 注入（本地独立 pi 调用；tmux 故障时的免依赖通道）──
let inflight = false
function resolveCli() {
  try {
    const out = execFileSync('bash', ['-c',
      `JS=$(readlink -f "$(command -v pi-original 2>/dev/null || command -v pi 2>/dev/null || echo "$HOME/.local/share/pi-node/current/bin/pi-original")" 2>/dev/null); NODE_BIN="$(command -v node 2>/dev/null || echo "$HOME/.local/share/pi-node/current/bin/node")"; echo "$NODE_BIN|$JS"`
    ], { encoding: 'utf8', timeout: 8000 })
    const [nb, js] = out.trim().split('|')
    return { node: nb?.trim(), cli: js?.trim() }
  } catch { return { node: 'node', cli: '' } }
}
const CLI = resolveCli()
function extractReply(events) {
  let text = ''
  let model
  for (const ev of events) {
    if (ev.type !== 'message_end') continue
    const m = ev.message || {}
    if (m.role !== 'assistant') continue
    model = m.model ?? model
    if (Array.isArray(m.content)) text = m.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')
    else if (typeof m.content === 'string' && m.content) text = m.content
  }
  return { text, model }
}
function rpcReply(text, timeoutMs = 90000) {
  return new Promise((resolve) => {
    if (!CLI.cli) return resolve({ ok: false, text: '', error: '未解析到 pi cli 路径' })
    const sdir = path.join(AGENT, 'sessions', 'pi-relay')
    const proc = spawn(CLI.node || 'node', [CLI.cli, '--mode', 'rpc', '--session-dir', JSON.stringify(sdir)], { stdio: ['pipe', 'pipe', 'pipe'] })
    const events = []
    let settled = false
    let stderr = ''
    const rl = createInterface({ input: proc.stdout })
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-600) })
    const finish = (r) => { try { proc.stdin.end() } catch { } try { proc.kill() } catch { } clearTimeout(timer); rl.close(); resolve(r) }
    const timer = setTimeout(() => finish({ ok: false, text: '', error: `RPC 超时(${Math.round(timeoutMs / 1000)}s)` }), timeoutMs)
    rl.on('line', (line) => {
      let ev; try { ev = JSON.parse(line) } catch { return }
      events.push(ev)
      if (ev.type === 'agent_settled' && !settled) {
        settled = true
        const { text: t, model } = extractReply(events)
        finish(t ? { ok: true, text: t, model } : { ok: false, text: '', error: '无回复: ' + stderr.trim().slice(0, 120) })
      }
    })
    rl.on('close', () => { if (!settled) finish({ ok: false, text: '', error: '进程结束未收到完成确认' }) })
    proc.on('error', (e) => finish({ ok: false, text: '', error: '启动失败: ' + e.message }))
    proc.stdin.on('error', () => { /* 已退出 */ })
    // 等实例就绪片刻再发 prompt（避免 switch/prompt 竞态）
    setTimeout(() => { try { proc.stdin.write(JSON.stringify({ type: 'prompt', message: text, id: 'pi-relay-1' }) + '\n') } catch { } }, 400)
  })
}

function parseText(raw) {
  let t = String(raw || '')
  const m = t.trim().match(/^\{[\s\S]*\}$/)
  if (m) { try { const j = JSON.parse(t); return { title: j.title || '', msg: j.message || j.body || '' } } catch { /* */ } }
  return { title: '', msg: t }
}
async function handleMessage(msg, verbose = true) {
  const id = msg.id
  if (!id || seen(id)) return false
  // CHECK 预览模式零副作用：不 remember（否则会抢走真实 daemon 对同一条消息的处理权）
  if (!CHECK) remember(id)
  const { title, msg: text } = parseText(msg.message)
  const raw = text.trim()
  // 前缀容错：兼容全角冒号（手机输入法常输出 iot"pi："）
  const norm = raw.replace(/：/g, ':')
  if (!norm.startsWith(cfg.prefix)) { if (verbose) log(`ignore(id=${id}): 无前缀`); return false }
  const cmd = norm.slice(cfg.prefix.length).trim()
  if (!cmd) { if (verbose) log(`ignore(id=${id}): 空指令`); return false }

  const sess = tmuxSessionName()
  if (verbose) log(`match(id=${id} title=${title} cmd=${cmd.slice(0, 80)} session=${sess})`)
  if (CHECK) { console.log(`[check] 将${cfg.injectMode === 'rpc' ? 'RPC 调用' : '注入会话 ' + (sess || '?')}: ${cmd}`); return true }

  // RPC 模式（tmux 故障兜底）：后台独立 pi 调用处理，结果回手机；仅防并发重入，不排队
  if (cfg.injectMode === 'rpc') {
    if (inflight) {
      log(`rpc-queued(id=${id}): 上一条处理中，排队`)
      ack(`pi 正在处理上一条指令，本条已排队: ${cmd.slice(0, 40)}`)
      return true
    }
    inflight = true
    try {
      const r = await rpcReply(cmd)
      inflight = false
      if (r.ok) {
        ack(`指令完成（${r.model || ''}）: ${r.text.slice(0, 300)}`)
        log(`rpc-ok(id=${id}): ${r.text.slice(0, 150)}`)
      } else {
        ack(`指令失败: ${r.error}`)
        log(`rpc-fail(id=${id}): ${r.error}`)
      }
      return true
    } catch (e) {
      inflight = false
      ack(`内部错误: ${e.message}`)
      log(`rpc-err(id=${id}): ${e.message}`)
      return true
    }
  }

  let busy = false
  let why = ''
  // 以输入框探测为准（state 仅当回合处理中才 busy，不适合做唯一判据）：输入框有内容 → 排队。
  if (sess && inputBoxBusy(sess)) { busy = true; why = '输入框占用' }
  else {
    try { const d = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); if (d.status === 'busy') why = `pi busy(${d.currentTask || ''})` } catch { /* */ }
    if (why) log(`override: ${why} 但输入框空闲，放行`)
  }

  if (busy) {
    try {
      const ib = fs.existsSync(INBOX) ? JSON.parse(fs.readFileSync(INBOX, 'utf8')) : { list: [] }
      ib.list = ib.list || []; ib.list.push({ id, ts: Date.now(), from: title || 'phone', text: cmd });
      while (ib.list.length > 200) ib.list.shift()
      fs.writeFileSync(INBOX, JSON.stringify(ib, null, 2))
    } catch { /* */ }
    log(`queued(id=${id}): ${why}`)
    ack(`pi 正忙（${why}），指令已排队，稍后处理: ${cmd.slice(0, 40)}`)
    return true
  }
  if (!sess) { ack('未找到 pi 的 tmux 会话，无法注入'); log(`no-session(id=${id})`); return true }
  try {
    inject(sess, cmd)
    ack(`已注入本地 pi 会话: ${cmd.slice(0, 40)}`)
    log(`injected(id=${id}): ${cmd.slice(0, 80)}`)
    return true
  } catch (e) {
    ack(`注入失败: ${e.message}`)
    log(`inject-fail(id=${id}): ${e.message}`)
    return true
  }
}

// 数据获取：短请求（轮询基础），返回 body 文本；限时销毁防挂起
function get(urlPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath)
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.get(u, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      let b = ''
      res.on('data', d => b += d)
      res.on('end', () => resolve(b))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
  })
}
// 快照：用 curl 子进程拉 JSON 流（node 原生 https 出站在本机被阻断 ETIMEDOUT，curl 可用）
// 并按 message 事件逐条处理；返回处理条数
async function snapshot(q) {
  let out = ''
  try {
    out = execFileSync('curl', ['-fsS', '--max-time', '10', `${cfg.server.replace(/\/$/, '')}/${cfg.topic}/json?${q}`], { encoding: 'utf8', timeout: 12000 })
  } catch (e) { out = e.stdout || '' }
  let n = 0
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    if (j.event === 'message') { try { if (await handleMessage(j, false)) n++ } catch { /* */ } }
  }
  return n
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 主流程（轮询架构：短连接抗网络断连，默认 5s 一拉）──
async function main() {
  console.log(`[relay] topic=${cfg.topic} prefix=${cfg.prefix} session=${cfg.tmuxSession || 'auto'} mode=${CHECK ? 'check' : ONCE ? 'once' : 'daemon'} poll=${(process.env.NTFY_RELAY_POLL_MS || '5000')}`)
  log(`start mode=${CHECK ? 'check' : ONCE ? 'once' : 'daemon'}`)
  // 启动快照 last=5：处理最近 5 条（含最新一条，避免被当起点跳过），末条自然更新 lastId
  try { const n = await snapshot('last=5&poll=1'); log(`bootstrap snapshot: ${n} 条处理`) } catch (e) { log(`bootstrap fail: ${e.message}`) }
  if (CHECK || ONCE) { console.log(`[relay] ${CHECK ? 'check' : 'once'} 完成`); return }

  const POLL_MS = parseInt(process.env.NTFY_RELAY_POLL_MS || '5000', 10)
  let fail = 0
  for (;;) {
    await sleep(POLL_MS)
    try {
      const q = st.lastId ? `since=${st.lastId}&poll=1` : 'last=5&poll=1'
      const n = await snapshot(q)
      if (n) log(`poll handled ${n}`)
      fail = 0
    } catch (e) {
      fail++
      log(`poll fail(${fail}): ${e.message}`)
      await sleep(Math.min(1000 * fail, 10000)) // 连续失败指数退避
    }
  }
}
main()
