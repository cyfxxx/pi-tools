#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-footer-live-context.mjs — footer 实时上下文 token 显示补丁（幂等）。
 *
 * 背景：pi footer 的 `↑↓RW$` 统计整个会话文件的累计消耗（含已压缩历史与
 * compaction 摘要 usage），压缩后数值不变，易误解为"显示坏了"。
 * 本补丁把实时上下文 token 数并入 context 显示：
 *   `17.2%/200k (auto)`  →  `34.5k/200k (17.2%) (auto)`
 * 压缩后 contextUsage.tokens 为 null，保持 `?/200k (auto)`。
 * ↑↓RW$ 累计口径保留（账单信息），不受影响。
 *
 * 用法：node patch-footer-live-context.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-footer-live-context.mjs)'

/** 自动探测 pi 安装的 dist 根目录。 */
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
  } catch {
    // fall through
  }
  const known = '/root/.local/share/pi-node/node-v22.23.1-linux-arm64/lib/node_modules/@earendil-works/pi-coding-agent/dist'
  if (existsSync(known)) return known
  throw new Error('无法定位 pi dist 目录：请传入参数或设置 PI_DIST')
}

const target = join(detectDist(), 'modes', 'interactive', 'components', 'footer.js')
if (!existsSync(target)) {
  console.error(`找不到 ${target}`)
  process.exit(1)
}

const src = readFileSync(target, 'utf-8')
if (src.includes(MARKER)) {
  console.log(`已打补丁，跳过：${target}`)
  process.exit(0)
}

// 匹配 contextPercentDisplay 拼接块：原样 = `17.2%/200k (auto)` / `?/200k (auto)`
const re =
  /const contextPercentDisplay = contextPercent === "\?"\n(\s*)\? `\?\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`\n\s*: `\$\{contextPercent\}%\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`;/
const m = src.match(re)
if (!m) {
  console.error('未匹配到 footer.js contextPercentDisplay 原代码（pi 版本可能已改动），需人工核对。')
  process.exit(1)
}

const indent = m[1]
const patched = src.replace(
  re,
  `// ${MARKER}: 实时上下文 token 数并入 context 显示（contextUsage.tokens，压缩后为 null 显示 "?"）。↑↓RW$ 保持累计口径。
${indent}const liveTokens = contextUsage?.tokens;
${indent}const liveTokensStr =
${indent}    liveTokens !== null && liveTokens !== undefined && contextWindow > 0
${indent}        ? \`\${formatTokens(liveTokens)}/\`
${indent}        : "";
${indent}const contextPercentDisplay = contextPercent === "?"
${indent}    ? \`?/\${formatTokens(contextWindow)}\${autoIndicator}\`
${indent}    : \`\${liveTokensStr}\${formatTokens(contextWindow)} (\${contextPercent}%)\${autoIndicator}\`;`,
)

writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用：${target}`)
console.log('提示：pi update 后需重跑本脚本（可加入 rebuild.sh 或手动执行）。')
