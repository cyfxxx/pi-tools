#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-footer-restart-hint.mjs — footer 重启前建议压缩提示补丁（幂等）。
 *
 * 背景：上下文超过重启压缩阈值（40% 窗口）时，重启后首轮必然全量重发
 * （pi-context 的 session_start 会按 PI_CONTEXT_RESTART_RATIO 默认 0.4 自动压缩，
 * 但用户手动退出 / 直接重启前如果能先 /compact 更好）。footer 是持续可见
 * 的唯一界面，>40% 且 ≤70% 时在 context 区追加 `⚠` 标记提示
 * （>70% 已有黄色 / >90% 红色，无需再加标记）。
 *
 * 依赖：须在 patch-footer-cache.mjs 之后应用（匹配其去掉百分比的实时
 * context 形态——live-context V2 后分母为 effWindow；未应用时报错提示）。
 *
 * 用法：node patch-footer-restart-hint.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-footer-restart-hint.mjs)'
// 与 pi-context PI_CONTEXT_RESTART_RATIO 默认一致的提示阈值
const RESTART_HINT_RATIO = 0.4

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

// 匹配 patch-footer-cache 后的 contextPercentDisplay 拼接（?/effWindow 与 34.5k/effWindow 两分支），
// 兼容 V1（分母 contextWindow）与 V2（分母 effWindow）形态
const re =
  /const contextPercentDisplay = contextPercent === "\?"\n(\s*)\? `\?\/\$\{formatTokens\((?:contextWindow|effWindow)\)\}\$\{autoIndicator\}`\n\s*: `\$\{liveTokensStr\}\$\{formatTokens\((?:contextWindow|effWindow)\)\}\$\{autoIndicator\}`;/
const m = src.match(re)
if (!m) {
  console.error('未匹配到 footer.js contextPercentDisplay 实时形态（patch-footer-cache 未应用或 pi 版本已改动），需人工核对。')
  process.exit(1)
}
const indent = m[1]
const patched = src.replace(
  re,
  `// ${MARKER}: 上下文 >40% 窗口时在 context 区追加 "⚠"（重启后首轮必全量重发，建议先 /compact；>70% 已有黄/红着色）。
${indent}const restartHint = contextPercent !== "?" && contextPercentValue > ${RESTART_HINT_RATIO * 100} && contextPercentValue <= 70 ? " ⚠" : "";
${indent}const contextPercentDisplay = contextPercent === "?"
${indent}    ? \`?/\${formatTokens(effWindow)}\${autoIndicator}\`
${indent}    : \`\${liveTokensStr}\${formatTokens(effWindow)}\${autoIndicator}\${restartHint}\`;`,
)

writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用：${target}`)
console.log(`提示阈值：上下文 >40% 窗口（与 pi-context PI_CONTEXT_RESTART_RATIO=0.4 对齐）`)
console.log('提示：pi update 后需重跑本脚本（应加入 rebuild.sh Phase 3）。')