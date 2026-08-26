#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-compaction-warm-prefix.mjs — 压缩摘要调用暖前缀重放补丁（幂等）。
 *
 * 背景（2026-08-26，对齐 dsh compaction-basic 的 KV 复用策略）：pi 内核压缩摘要是
 * 独立隔离请求（SUMMARIZATION_SYSTEM_PROMPT + <conversation> 序列化文本），与主会话
 * 请求前缀零交集，每次压缩全价计费。dsh 实测暖前缀重放可让摘要调用命中自动前缀缓存，
 * 成本降至约 1/10 且延迟更低。
 *
 * 本补丁只提供机制，不做决策：
 *   compaction.js 增加模块级 setCompactionWarmPrefixProvider(fn) 注册点；
 *   generateSummaryWithUsage 构建 context 前调用 provider，返回
 *   { systemPrompt, tools, messages }（与主请求逐字节同源）时重放为前缀、
 *   摘要指令作为尾部 user 消息；返回 null 或结构缺失时回退原生隔离上下文。
 * 门控（哪些模型启用、何时禁用）由扩展侧 pi-context 决定。
 *
 * 改动三处：① core/compaction/compaction.js（机制）
 *           ② index.js 具名导出列表加 setter
 *           ③ index.d.ts 类型声明同步（否则扩展 tsc 报 TS2305）
 *
 * 用法：node patch-compaction-warm-prefix.mjs [dist 目录]
 *   - 已打补丁：跳过 exit 0（幂等）
 *   - 未匹配原代码（pi 升级改动）：报错 exit 1，需人工核对
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-compaction-warm-prefix.mjs)'
const DRY_RUN = process.env.PATCH_DRY_RUN === '1'
let failed = false

function detectDist() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  if (process.env.PI_DIST && existsSync(process.env.PI_DIST)) return process.env.PI_DIST
  try {
    const bin = execFileSync('which', ['pi'], { encoding: 'utf-8' }).trim()
    if (bin) {
      const resolved = execFileSync('readlink', ['-f', bin], { encoding: 'utf-8' }).trim()
      const m = resolved.match(/(.*node_modules\/@earendil-works\/pi-coding-agent\/)/)
      if (m && existsSync(join(m[1], 'dist'))) return join(m[1], 'dist')
    }
  } catch { /* fall through */ }
  const root = join(process.env.HOME || '', '.local', 'share', 'pi-node')
  const candidates = []
  const cur = join(root, 'current', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
  if (existsSync(cur)) candidates.push(cur)
  try {
    readdirSync(root)
      .filter((d) => d.startsWith('node-v'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((d) => {
        const p = join(root, d, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
        if (existsSync(p)) candidates.push(p)
      })
  } catch { /* pi-node 目录不存在 */ }
  if (candidates.length) return candidates[candidates.length - 1]
  throw new Error('无法定位 pi dist 目录：请先安装 pi，或传入参数/设置 PI_DIST')
}

const dist = detectDist()

// ── Part 1: compaction.js — setter 注册点 + generateSummaryWithUsage 暖前缀分支 ──
{
  const target = join(dist, 'core', 'compaction', 'compaction.js')
  if (!existsSync(target)) {
    console.error(`找不到 ${target}`)
    failed = true
  } else {
    const src = readFileSync(target, 'utf-8')
    if (src.includes(MARKER)) {
      console.log(`已打补丁，跳过：${target}`)
    } else {
      // 锚点 1：buildSummarizationContext 定义前插入模块级 provider 注册块
      const anchorFn = '/** Build the provider context for a standalone summary request. */'
      if (!src.includes(anchorFn)) {
        console.error('未匹配到 buildSummarizationContext 注释锚点（pi 版本可能已改动），需人工核对。')
        failed = true
      } else {
        const anchorCall =
          '    const response = await completeSummarization(model, buildSummarizationContext(promptText), completionOptions, streamFn, retry, callbacks);'
        if (!src.includes(anchorCall)) {
          console.error('未匹配到 completeSummarization 调用行（pi 版本可能已改动），需人工核对。')
          failed = true
        } else {
          const setterBlock = `// ${MARKER}: 暖前缀重放注册点——扩展（pi-context）按模型门控注册 provider，
// 返回与主请求同源的 { systemPrompt, tools, messages } 即启用重放；null 回退原生。
let _warmPrefixProvider = null;
export function setCompactionWarmPrefixProvider(fn) {
    _warmPrefixProvider = typeof fn === "function" ? fn : null;
}
function getCompactionWarmPrefix() {
    if (!_warmPrefixProvider) return null;
    try {
        return _warmPrefixProvider();
    } catch {
        return null;
    }
}
`
          const callPatched = `    // ${MARKER}: 暖前缀重放分支——messages 同源时历史部分命中缓存，仅尾部指令为增量。
    // 注意不重复携带 <conversation> 文本（历史已在 messages 里，避免体积翻倍）。
    const _wp = getCompactionWarmPrefix();
    let summaryContext;
    if (_wp && _wp.systemPrompt && Array.isArray(_wp.messages) && Array.isArray(_wp.tools) && _wp.tools.length > 0) {
        let tail = basePrompt;
        if (previousSummary) {
            tail = \`<previous-summary>\\n\${previousSummary}\\n</previous-summary>\\n\\n\` + tail;
        }
        summaryContext = {
            systemPrompt: _wp.systemPrompt,
            tools: _wp.tools,
            messages: [
                ..._wp.messages,
                { role: "user", content: [{ type: "text", text: tail }], timestamp: Date.now() },
            ],
        };
    } else {
        summaryContext = buildSummarizationContext(promptText);
    }
    const response = await completeSummarization(model, summaryContext, completionOptions, streamFn, retry, callbacks);`
          let patched = src.replace(anchorFn, `${setterBlock}${anchorFn}`)
          patched = patched.replace(anchorCall, callPatched)
          if (!DRY_RUN) {
            writeFileSync(target, patched)
            console.log(`已打补丁：${target}`)
          } else {
            console.log(`dry-run 命中：${target}`)
          }
        }
      }
    }
  }
}

// ── Part 2 & 3: 包根 index.js / index.d.ts — 导出列表与类型声明同步 ──
for (const [file, isDts] of [
  ['index.js', false],
  ['index.d.ts', true],
]) {
  const target = join(dist, file)
  if (!existsSync(target)) {
    console.error(`找不到 ${target}`)
    failed = true
    continue
  }
  const src = readFileSync(target, 'utf-8')
  if (src.includes('setCompactionWarmPrefixProvider')) {
    console.log(`已打补丁，跳过：${target}`)
    continue
  }
  const anchor = 'generateSummaryWithUsage, getLastAssistantUsage'
  if (!src.includes(anchor)) {
    console.error(`未匹配到 ${file} 导出列表锚点（pi 版本可能已改动），需人工核对。`)
    failed = true
    continue
  }
  const patched = src.replace(
    anchor,
    'generateSummaryWithUsage, setCompactionWarmPrefixProvider, getLastAssistantUsage',
  )
  if (!DRY_RUN) {
    writeFileSync(target, patched)
    console.log(`已打补丁：${target}`)
  } else {
    console.log(`dry-run 命中：${target}`)
  }
}

process.exit(failed ? 1 : 0)
