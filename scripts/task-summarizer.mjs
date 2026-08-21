#!/usr/bin/env node
/**
 * 任务完成批量总结层（task #26/27，2026-08-21）
 *
 * 读取 pi-context 即时层落盘的 logs/task-records.jsonl，聚合"上次总结以来"的实质任务，
 * spawn 独立 pi 后台实例做一次性批量总结：
 *   1) 普通任务 → 经验经 memory_store 入库（procedure/solutions）+ 简述
 *   2) 成功、可复现、有保存价值的长任务 → 写 SKILL.md 草稿到
 *      /root/.pi/skill-store/drafts/（功能 3 半自动机制：drafts=待人工确认，不入
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
const SKILL_STORE = join(HOME, '.pi', 'skill-store')
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

  // 按间隔聚类会话
  const sessions = []
  let cur = []
  for (const r of fresh) {
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
    '2) 如有值得长期保留的经验/踩坑/技巧，用 memory_store 工具存入（category 选 procedure 或 solutions，title 简短，content 精确可复现）；多条经验可逐条存；',
    '3) 特别标注：若某个任务满足"成功实现、可复现、有保存价值的长流程"三条，请用 write 工具把 SKILL.md 草稿写到 /root/.pi/skill-store/drafts/ 下（文件名 `<短名>.SKILL.md`，格式：YAML frontmatter 的 name/description + 步骤正文，description 控制在 1-2 句且不带时间戳）。',
    '注意：除此两项（memory_store / write 草稿）外不要改动任何其他文件，不要执行其他工具。',
    '最后用 3-5 行概述本次沉淀了什么。',
    '',
    '任务记录清单：',
    list,
  ].join('\n')

  const logFile = join(HOME, '.pi', 'logs', 'task-summarizer-out.log')
  const proc = spawn('pi', ['--no-session', '-p', prompt], {
    stdio: 'ignore', detached: true, cwd: HOME,
    env: { ...process.env, PI_DISABLE_TASK_RECORD: '1' },
  })
  proc.unref()
  appendFileSync(logFile, `\n=== ${new Date().toISOString()} 总结启动（${substantive.length} 会话待总结）===\n`)
  saveCursor(fresh[fresh.length - 1].ts)
  console.log(`思考总结: 已启动 ${substantive.length} 个会话的批量总结（后台 pi，日志 ${logFile}）`)
  console.log(`游标已推进到 ${new Date(fresh[fresh.length - 1].ts).toISOString()}，下次只处理新记录`)
}

main()
