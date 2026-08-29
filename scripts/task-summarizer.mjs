#!/usr/bin/env node
/**
 * 任务完成批量总结层（task #26/27，2026-08-21）
 *
 * 读取 pi-context 即时层落盘的 logs/task-records.jsonl，聚合"上次总结以来"的实质任务，
 * spawn 独立 pi 后台实例做一次性批量总结：
 *   1) 普通任务 → 经验经 memory_store 入库（procedure/solutions）+ 简述
 *   2) 成功、可复现、有保存价值的长任务 → 写 SKILL.md 草稿到
 *      /root/.pi/packs/drafts/（功能 3 半自动机制：drafts=待人工确认，不入
 *      agent/skills/ → 不膨胀系统提示词）
 *
 * 游标：agent/stats/summarize-cursor 记录上次总结的最大 ts，只处理新记录（幂等）。
 * 用法：
 *   node scripts/task-summarizer.mjs            # 总结自游标以来的新任务
 *   node scripts/task-summarizer.mjs --dry-run  # 只看待总结清单，不 spawn
 *   node scripts/task-summarizer.mjs --since=2026-08-20T00:00:00
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const HOME = homedir()
const RECORDS = join(HOME, '.pi', 'logs', 'task-records.jsonl')
const CURSOR = join(HOME, '.pi', 'agent', 'stats', 'summarize-cursor')
const SKILL_STORE = join(HOME, '.pi', 'packs')
const DRAFTS = join(SKILL_STORE, 'drafts')
// 会话边界：两条记录间隔超此视为新会话（对齐 usage-stats 分段）
const SESSION_GAP_MS = 8 * 60 * 1000
// 实质任务阈值：无工具调用且输出很小 → 视为空话/问候轮，不总结
const TOOLS_MIN = 1

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const sinceArg = args.find((a) => a.startsWith('--since='))

function readRecords() {
  if (!existsSync(RECORDS)) return []
  const out = []
  for (const l of readFileSync(RECORDS, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try {
      const r = JSON.parse(l)
      if (r && r.type === 'task') out.push(r)
    } catch { /* 跳过损坏行 */ }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

function loadCursor() {
  try { return parseInt(readFileSync(CURSOR, 'utf8').trim(), 10) || 0 } catch { return 0 }
}

function saveCursor(ts) { mkdirSync(join(HOME, '.pi', 'agent', 'stats'), { recursive: true }); writeFileSync(CURSOR, String(ts)) }

function main() {
  const records = readRecords()
  const cursor = sinceArg
    ? new Date(sinceArg.slice(sinceArg.indexOf('=') + 1)).getTime()
    : loadCursor()
  const fresh = records.filter((r) => r.ts > cursor)
  if (fresh.length === 0) {
    console.log('思考总结: 无新任务记录（游标后）——跳过')
    return
  }

  // 空壳/伪影过滤（2026-08-29，修复“空壳投喂”教训 4+ 次复现烧 token）：
  // ① 空 userRequest 轮 = 失败轮/空转轮（usage 全零，无任何可蒸馏内容）；
  // ② tools=0 且 output=0 = 无产出轮（含 hit=250000 封顶伪影：provider 对 1M 窗口
  //    模型封顶报 cacheRead=250000，实为中断轮，非真实任务，2026-08-29 实测 73 条全是
  //    空 request + 全零产出）；
  // ③ 内部子进程 prompt（pi-memory 提取器 / 本脚本沉淀器）——守门 env
  //    （PI_DISABLE_TASK_RECORD / extract --no-extensions）失效时的兜底，防自指投喂。
  // 源端修复已落地（extract.ts --no-extensions + lib/task-record env 守卫），此为消费端防线。
  const isDistillable = (r) => {
    if (!r.userRequest || !r.userRequest.trim()) return false
    if (/会话记忆提取器|经验沉淀器/.test(r.userRequest)) return false
    if (r.tools === 0 && r.output === 0) return false
    return true
  }
  const distillable = fresh.filter(isDistillable)
  if (distillable.length === 0) {
    console.log(`思考总结: ${fresh.length} 条记录均为空壳/伪影轮，无可总结任务`)
    saveCursor(fresh[fresh.length - 1].ts)
    return
  }

  // 按间隔聚类会话（只聚类可蒸馏记录：空壳轮不再计入轮数/累计K，不再进投喂清单）
  const sessions = []
  let cur = []
  for (const r of distillable) {
    const last = cur[cur.length - 1]
    if (last && r.ts - last.ts > SESSION_GAP_MS) { sessions.push(cur); cur = [] }
    cur.push(r)
  }
  if (cur.length) sessions.push(cur)

  // 实质任务：有明确用户请求且（有工具调用或有输出）。
  // 启动/压缩冷启动轮（seq=0、userRequest 空、无工具）视为空轮，不总结。
  const substantive = sessions.filter((s) =>
    s.some(
      (r) =>
        r.userSeq >= 1 &&
        r.userRequest &&
        r.userRequest.trim().length > 0 &&
        (r.tools >= TOOLS_MIN || r.output > 0),
    ),
  )
  if (substantive.length === 0) {
    console.log(`思考总结: ${fresh.length} 条记录均为空话轮，无可总结任务`)
    saveCursor(fresh[fresh.length - 1].ts)
    return
  }

  // 生成紧凑清单
  let list = ''
  substantive.forEach((s, si) => {
    const t0 = new Date(s[0].ts).toISOString().slice(5, 16).replace('T', ' ')
    const totalTok = s.reduce((a, r) => a + r.contextTokens, 0)
    list += `\n--- 任务${si + 1} (${t0}, 轮${s.length}, 累计${Math.round(totalTok / 1000)}K tokens) ---\n`
    for (const r of s.slice(0, 8)) {
      list += `  [轮 tools=${r.tools} hit=${r.cacheHit} out=${r.output}] ${r.userRequest.slice(0, 120)}\n`
    }
  })

  if (DRY) {
    console.log(`思考总结: ${substantive.length} 个会话待总结（dry-run，不执行）\n${list}`)
    return
  }

  const prompt = [
    '你是 pi 私人助手的经验沉淀器。下面是我最近完成任务的简要记录（任务数见清单）。',
    '请对每个任务：',
    '1) 用一句话概括完成情况；',
    '2) 如有值得长期保留的经验/踩坑/技巧，用 memory_store 工具存入（category 选 procedure 或 solutions，title 简短，content 精确可复现，confidence 一律传 0.6——蒸馏产物非直接观察，防错误经验高置信自我强化，验证有效后可升置信）；多条经验可逐条存；',
    '3) 特别标注：若某个任务满足"成功实现、可复现、有保存价值的长流程"三条，先 ls /root/.pi/packs/drafts/ 并读取主题相近草稿的 description：存在同主题草稿时不新建，改为在最终概述中列出"建议 patch <文件名>：<差异要点>"待人工确认合并；确认无同主题才用 write 工具新建 SKILL.md 草稿（文件名 `<短名>.SKILL.md`，格式：YAML frontmatter 的 name/description + 步骤正文，description 控制在 1-2 句且不带时间戳）。',
    '注意：除此两项（memory_store / write 草稿）外不要改动任何其他文件，不要执行其他工具。',
    '最后用 3-5 行概述本次沉淀了什么。',
    '',
    '任务记录清单：',
    list,
  ].join('\n')

  const logFile = join(HOME, '.pi', 'logs', 'task-summarizer-out.log')
  // 后台 pi 真正跑完（exit 0）确认后才推进游标；失败/超时则保留游标，下次重跑不丢该批记录
  // （原先 spawn 后立即 saveCursor，后台失败时该批记录会被游标跳过而永久丢失）。
  const freshTs = fresh[fresh.length - 1].ts
  const proc = spawn('pi', ['--no-session', '-p', prompt], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: HOME,
    env: { ...process.env, PI_DISABLE_TASK_RECORD: '1' },
  })
  appendFileSync(logFile, `\n=== ${new Date().toISOString()} 总结启动（${substantive.length} 会话待总结）===\n`)
  let errBuf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (c) => appendFileSync(logFile, c))
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-2000); appendFileSync(logFile, c) })
  const SUMMARY_TIMEOUT_MS = 30 * 60 * 1000 // 30 分钟：超时视为未完成，游标不推进
  const timer = setTimeout(() => {
    try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
    console.error(`思考总结: 后台 pi 超过 ${SUMMARY_TIMEOUT_MS / 60000} 分钟未完成，已终止——游标不推进，该批记录保留待下轮重试`)
    appendFileSync(logFile, `提示：超时终止（${SUMMARY_TIMEOUT_MS / 60000}min），游标未推进，记录保留\n`)
  }, SUMMARY_TIMEOUT_MS)
  proc.on('error', (e) => {
    clearTimeout(timer)
    console.error(`思考总结: 后台 pi 启动失败：${e.message}——游标不推进，该批记录不丢失`)
    appendFileSync(logFile, `启动失败：${e.message}，游标未推进\n`)
  })
  proc.on('exit', (code) => {
    clearTimeout(timer)
    if (code === 0) {
      saveCursor(freshTs)
      appendFileSync(logFile, `完成 exit=0 游标=${freshTs}\n`)
      console.log(`思考总结: 后台 pi 已完成（exit 0，${substantive.length} 会话）`)
      console.log(`游标已推进到 ${new Date(freshTs).toISOString()}，下次只处理新记录；输出见 ${logFile}`)
    } else {
      appendFileSync(logFile, `失败 exit=${code}，游标未推进，记录保留\n`)
      console.error(`思考总结: 后台 pi 失败（exit=${code}）——游标不推进，该批记录保留待下轮重试`)
      if (errBuf) console.error('stderr 尾部: ' + errBuf.trim().slice(-400))
    }
  })
}

main()
