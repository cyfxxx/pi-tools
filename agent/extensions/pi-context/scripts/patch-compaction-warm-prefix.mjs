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

// ── Part 1: compaction.js — setter 注册点 + completeSummarization onPayload 桥 ──
// v1.5 终态（2026-08-26）：context 级暖分支已退役（素材为转换前消息时二次转换
// 结构失配、为已转换参数时再次串行化重复，两版实测均失败）；改在 completeSummarization
// 的 produce 内注入 onPayload 桥，在 provider 参数层（buildParams 之后、发送之前）用主请求
// 最终 payload（缓存键原文）整体替换，零二次转换。素材由扩展侧 provider 提供。
{
  const target = join(dist, 'core', 'compaction', 'compaction.js')
  if (!existsSync(target)) {
    console.error(`找不到 ${target}`)
    failed = true
  } else {
    let src = readFileSync(target, 'utf-8')
    const hasBridge = src.includes('onPayload 桥——摘要请求发送前')
    if (src.includes(MARKER) && hasBridge) {
      console.log(`已打补丁，跳过：${target}`)
    } else {
      // ── 锚点 1：buildSummarizationContext 定义前插入模块级 provider 注册块 ──
      const anchorFn = '/** Build the provider context for a standalone summary request. */'
      if (!src.includes(anchorFn)) {
        console.error('未匹配到 buildSummarizationContext 注释锚点（pi 版本可能已改动），需人工核对。')
        failed = true
      } else {
        const anchorCall = '    const response = await completeSummarization(model, buildSummarizationContext(promptText), completionOptions, streamFn, retry, callbacks);'
        const anchorProduce = '    const produce = async () => streamFn\n        ? (await streamFn(model, context, requestOptions)).result()\n        : completeSimple(model, context, requestOptions);'
        const missing = []
        if (!src.includes(anchorCall)) missing.push('completeSummarization 调用行（原形态）')
        if (!src.includes(anchorProduce)) missing.push('produce 定义（原形态）')
        if (missing.length && !src.includes('_wp = getCompactionWarmPrefix')) {
          console.error(`未匹配到：${missing.join('、')}（pi 版本可能已改动），需人工核对。`)
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
          // 旧形态（_wp 分支）升级：整块替换为退役注释 + 原生调用
          const legacyBlockRe = /    \/\/ Patch \(patch-compaction-warm-prefix\.mjs\): 暖前缀重放分支——[\s\S]*?const response = await completeSummarization\(model, summaryContext, completionOptions, streamFn, retry, callbacks\);/u
          const retiredBlock = `    // ${MARKER}: 暖前缀重放退役说明——context 级重放已移除：
    // 历史素材是「转换前」消息时二次转换结构不匹配，是「已转换」最终参数时再次串行化
    // 会重复串行化（v1/v1.5 两版均实测失败）。改为 completeSummarization 内注入 onPayload
    // 桥，在 provider 参数层用主请求最终 payload 整体替换（即缓存键原文），零二次转换。
    const summaryContext = buildSummarizationContext(promptText);
    const response = await completeSummarization(model, summaryContext, completionOptions, streamFn, retry, callbacks);`
          const producePatched = `    const produce = async () => {
        // ${MARKER}: 暖前缀重放 onPayload 桥——摘要请求发送前用主请求
        // 最终 payload（缓存键原文）替换自身消息，尾部追加剥离 <conversation> 后的摘要指令；素材由
        // 扩展侧 setCompactionWarmPrefixProvider 提供（未注册/门控拒绝时返回 null → 原生摘要路径）。
        let reqOpts = requestOptions;
        if (typeof options?.onPayload !== "function" && typeof getCompactionWarmPrefix === "function") {
            reqOpts = {
                ...requestOptions,
                onPayload: async (payload) => {
                    try {
                        const wp = getCompactionWarmPrefix();
                        if (!wp || !Array.isArray(wp.messages) || wp.messages.length === 0) return payload;
                        const msgs = payload?.messages;
                        if (!Array.isArray(msgs) || msgs.length === 0) return payload;
                        const last = msgs[msgs.length - 1];
                        const lastText = typeof last?.content === "string"
                            ? last.content
                            : Array.isArray(last?.content)
                                ? last.content.map((b) => (b?.type === "text" ? (b?.text ?? "") : "")).join("\\n")
                                : "";
                        if (!(last?.role === "user" && typeof lastText === "string" && lastText.includes("<conversation>"))) return payload;
                        const tail = lastText.replace(/^<conversation>\\n[\\s\\S]*?\\n<\\/conversation>\\n\\n/, "");
                        if (!tail || tail === lastText) return payload;
                        const next = { ...payload, messages: [...wp.messages, { role: "user", content: tail }] };
                        if (Array.isArray(wp.tools) && wp.tools.length > 0) next.tools = wp.tools;
                        try {
                            const fs0 = await import("node:fs");
                            fs0.appendFileSync("/root/.pi/logs/warm-diag.jsonl", JSON.stringify({ t: Date.now(), reason: "rewrite-bridge", baseMsgs: wp.messages.length, tailLen: tail.length, tools: Array.isArray(wp.tools) ? wp.tools.length : 0 }) + "\\n");
                        } catch {}
                        return next;
                    } catch {
                        return payload;
                    }
                },
            };
        }
        return streamFn
            ? (await streamFn(model, context, reqOpts)).result()
            : completeSimple(model, context, reqOpts);
    };`
          let patched = src
          if (!src.includes(MARKER)) {
            patched = patched.replace(anchorFn, `${setterBlock}${anchorFn}`)
            patched = patched.replace(anchorCall, retiredBlock)
          } else if (legacyBlockRe.test(patched)) {
            patched = patched.replace(legacyBlockRe, retiredBlock)
          }
          patched = patched.replace(anchorProduce, producePatched)
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
