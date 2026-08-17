#!/usr/bin/env node
/**
 * patch-footer-format.mjs — footer 字段与货币补丁（幂等，含旧版迁移）。
 *
 * 背景：`↑↓RW$` 符号抽象（↑=累计输入未命中、↓=累计输出、R=缓存命中、
 * W=缓存写入、$=USD 成本）。用户需要字段更直白：前 3 字段改为
 *   `Σ{总量}`（输入 prompt 总量=命中+未命中）/ `↑{未命中}`（累计 input）/
 *   `↓{输出}`（累计 output）——R 与 W 合并进浅"Σ"（明细看 CH 与 /session）；
 * 成本 `$0.123` → `¥0.83`（USD→CNY 近似汇率常量，改汇率编辑 CNY_PER_USD）。
 * v1 曾用中文标签（总/未/出），v2 改回符号（Σ/↑/↓）；脚本带迁移逻辑：
 * 已打 v1（中文标签）的 dist 直接字面替换，无盾幂等。
 *
 * 实现用行级定位（findIndex + splice），避免模板字面量的正则转义陷阱。
 *
 * 用法：node patch-footer-format.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打补丁且无旧标签：输出跳过，exit 0（幂等）
 *   - 已打 v1 中文标签：自动迁移到符号版，exit 0
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-footer-format.mjs)'
// USD→CNY 参考汇率（2026-08 近 90 天中位数 6.77：近 3 个月区间 6.74-6.81、波动 <1%，
// 全年趋势 7.18→6.74 缓贬但近段最稳；改此值后重跑脚本即同步更新 dist，幂等兼容）
const CNY_PER_USD = 6.77

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
const lines = src.split('\n')

// 迁移/更新逻辑：已打 format 补丁时
//   a) 仍是 v1 中文标签（总/未/出）→ 字面替换为符号版
//   b) 汇率行值与脚本常量不同 → 更新汇率行
// 两者皆无需处理才跳过（幂等）。
const hasMarker = src.includes(MARKER)
const hasOldLabels =
  src.includes('push(`总${formatTokens(sessionPromptTotal)}`)') ||
  src.includes('push(`未${formatTokens(usageTotals.input)}`)') ||
  src.includes('push(`出${formatTokens(usageTotals.output)}`)')
const rateRe = /^(\s*)const CNY_PER_USD = [\d.]+;/m
const rateM = src.match(rateRe)
const rateNeedsUpdate = !!rateM && !src.includes(`const CNY_PER_USD = ${CNY_PER_USD};`)
if (hasMarker) {
  if (hasOldLabels || rateNeedsUpdate) {
    let out = src
    if (hasOldLabels) {
      out = out
        .replace(/push\(`总\$\{formatTokens\(sessionPromptTotal\)}`\)/, 'push(`Σ${formatTokens(sessionPromptTotal)}`)')
        .replace(/push\(`未\$\{formatTokens\(usageTotals\.input\)}`\)/, 'push(`↑${formatTokens(usageTotals.input)}`)')
        .replace(/push\(`出\$\{formatTokens\(usageTotals\.output\)}`\)/, 'push(`↓${formatTokens(usageTotals.output)}`)')
    }
    if (rateNeedsUpdate) {
      out = out.replace(rateRe, `$1const CNY_PER_USD = ${CNY_PER_USD};`)
    }
    writeFileSync(target, out, 'utf-8')
    console.log(`已更新：${target}（${hasOldLabels ? '迁移符号版；' : ''}${rateNeedsUpdate ? `汇率 ${rateM[1] ? '' : ''}→${CNY_PER_USD}` : ''}）`)
    process.exit(0)
  }
  console.log(`已打补丁（符号版），跳过：${target}`)
  process.exit(0)
}

// 主流程：全新安装（无 MARKER）直接应用。若 dist 已有符号版但无 MARKER（异常状态）
// 的字段块校验用 `↑`/`↓` 存在性检查，避免重复插入。

// Part 1: ↑↓RW 字段块 → Σ/↑/↓（定位 "// Build stats line" 到 cacheWrite push 行）
const startI = lines.findIndex((l) => l.includes('// Build stats line'))
if (startI === -1) {
  console.error('未匹配到 footer.js 的 "// Build stats line"（pi 版本可能已改动），需人工核对。')
  process.exit(1)
}
let endI = -1
for (let i = startI; i < Math.min(startI + 12, lines.length); i++) {
  if (lines[i].includes('cacheWrite') && lines[i].includes('push')) { endI = i; break }
}
if (endI === -1) {
  console.error('未匹配到字段块结束行（cacheWrite push），pi 版本可能已改动，需人工核对。')
  process.exit(1)
}
const block = lines.slice(startI, endI + 1).join('\n')
if (!block.includes('usageTotals.input') || !block.includes('`↑') || !block.includes('`↓')) {
  console.error('字段块内容与预期不符（前后补丁顺序/版本异常），需人工核对。当前块：\n' + block)
  process.exit(1)
}
const indent = lines[startI + 1].match(/^\s*/)[0]
const replacement = [
  `// ${MARKER}: 前 3 字段改为 Σ总输入(prompt 总量=命中+未命中) / ↑累计未命中 / ↓累计输出；R/W 合并进"Σ"（明细见 CH 与 /session）。`,
  `${indent}const sessionPromptTotal = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;`,
  `${indent}const statsParts = [];`,
  `${indent}if (sessionPromptTotal > 0)`,
  `${indent}    statsParts.push(\`Σ\${formatTokens(sessionPromptTotal)}\`);`,
  `${indent}if (usageTotals.input)`,
  `${indent}    statsParts.push(\`↑\${formatTokens(usageTotals.input)}\`);`,
  `${indent}if (usageTotals.output)`,
  `${indent}    statsParts.push(\`↓\${formatTokens(usageTotals.output)}\`);`,
]
lines.splice(startI, endI - startI + 1, ...replacement)

// Part 2: 成本 USD → CNY（定位 costStr 行，前置注释 + 汇率常量）
const li = lines.findIndex((l) => l.includes('costStr') && l.includes('usageTotals.cost.toFixed(3)'))
if (li === -1) {
  console.error('未匹配到 footer.js 的 costStr 行（pi 版本可能已改动或已被其他补丁修改），需人工核对。')
  process.exit(1)
}
const ic = lines[li].match(/^\s*/)[0]
lines[li] = `// Patch (patch-footer-format.mjs): 成本换算人民币（近似汇率常量；usageTotals.cost 为 USD，改汇率编辑下一行）`
lines.splice(
  li + 1,
  0,
  `${ic}const CNY_PER_USD = ${CNY_PER_USD};`,
  `${ic}const costStr = \`¥\${(usageTotals.cost * CNY_PER_USD).toFixed(2)}\${usingSubscription ? " (sub)" : ""}\`;`,
)

writeFileSync(target, lines.join('\n'), 'utf-8')
console.log(`补丁已应用：${target}`)
console.log(`汇率 CNY_PER_USD=${CNY_PER_USD}（改汇率请编辑脚本顶部常量）`)
console.log('提示：pi update 后需重跑本脚本（已接入 rebuild.sh Phase 3）。')