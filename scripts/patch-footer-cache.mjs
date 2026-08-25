#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-footer-cache.mjs — footer CH 双命中率 + context 去百分比补丁（幂等）。
 *
 * 背景：pi footer 的 `CH85.3%` 只显示最近一轮缓存命中率（latestCacheHitRate，
 * 循环覆盖），`/session`/`/usage-diag` 的命中率口径又各不相同，易混淆。
 * 本补丁：
 *   1) CH 区改为实时/会话双命中率：`CH92.1/85.3%`（左=最近一轮，右=会话累计）
 *   2) context 区去掉括号百分比：`442.0K/256k (172%)` → `442.0K/256k`
 *      （上下文压力靠颜色提示——live-context V2 已把着色阈值改为压缩临界，
 *      >70% 黄、>90% 红、>100% 加 !!；分母 effWindow = min(窗口, 256K 压缩临界参考线)）
 * ↑↓RW$ 累计口径保留（账单信息），不受影响。
 *
 * 依赖：须在 patch-footer-live-context.mjs（V1 或 V2）之后应用（part 2 匹配其实时
 * context 形态；未应用时报错提示）。
 *
 * 用法：node patch-footer-cache.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-footer-cache.mjs)'
// dry-run 校验模式（verify-patches.mjs 调用）：只做模式命中检测，不写盘
const DRY_RUN = process.env.PATCH_DRY_RUN === '1'

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
  // 兑底：在 pi-node 安装根下检测 current 软链或最近 node-v* 版本目录（node 随 pi
  // 安装，版本目录随升级变化——硬编码 v22.23.1-linux-arm64 已过期）
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
  throw new Error('无法定位 pi dist 目录：请先安装 pi（node 随 pi 装入 ~/.local/share/pi-node/），或传入参数/设置 PI_DIST')
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

// Part 1: CH 区 — 原样 = `if (...) && latestCacheHitRate !== undefined) { push(CH...) }`
// 替换为：会话累计命中率计算 + 实时/会话双值显示。
const reChBlock =
  /if \(\(usageTotals\.cacheRead > 0 \|\| usageTotals\.cacheWrite > 0\) && latestCacheHitRate !== undefined\) \{\n(\s+)statsParts\.push\(`CH\$\{latestCacheHitRate\.toFixed\(1\)\}%`\);\n\s+\}/
const m1 = src.match(reChBlock)
if (!m1) {
  console.error('未匹配到 footer.js 的 CH 块（pi 版本可能已改动），需人工核对。')
  process.exit(1)
}
const indent = m1[1]
const chPatched = src.replace(
  reChBlock,
  `// ${MARKER}: CH 实时/会话双命中率（实时=最新一条 assistant 消息，会话=全部条目累计）。↑↓RW$ 保持累计口径。
${indent}const sessionPromptTokens = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
${indent}const sessionCacheHitRate =
${indent}    sessionPromptTokens > 0 ? (usageTotals.cacheRead / sessionPromptTokens) * 100 : undefined;
${indent}if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && (latestCacheHitRate !== undefined || sessionCacheHitRate !== undefined)) {
${indent}    const hitRates = [];
${indent}    if (latestCacheHitRate !== undefined) hitRates.push(latestCacheHitRate.toFixed(1));
${indent}    if (sessionCacheHitRate !== undefined) hitRates.push(sessionCacheHitRate.toFixed(1));
${indent}    statsParts.push(\`CH\${hitRates.join("/")}%\`);
${indent}}`,
)

// Part 2: context 区去百分比（依赖 patch-footer-live-context.mjs 已应用，
// 其实时 context 形态 `442.0K/256k (172%)`；V1 形态 contextPercent / V2 形态 effPercent
// 均可；未应用时此处原文无括号百分比，跳过即可）。
const reCtxPct =
  /: `\$\{liveTokensStr\}\$\{formatTokens\((?:contextWindow|effWindow)\)\} \(\$\{(?:contextPercent|effPercent)\}%\)\$\{autoIndicator\}`;/
const m2 = chPatched.match(reCtxPct)
let patched = chPatched
if (m2) {
  patched = chPatched.replace(
    reCtxPct,
    `: \`\${liveTokensStr}\${formatTokens(effWindow)}\${autoIndicator}\`;`,
  )
} else {
  console.warn('未匹配到 context 百分比行（live-context 补丁未应用或 pi 版本已改动），跳过去百分比。')
}

if (DRY_RUN) { console.log(`dry-run：${target} 模式命中，未写盘`); process.exit(0) }
writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用：${target}`)
console.log('提示：pi update 后需重跑本脚本（已接入 rebuild.sh Phase 3）。')