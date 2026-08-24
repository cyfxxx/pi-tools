#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-footer-live-context.mjs — footer 实时上下文 token 显示补丁（幂等，V2）。
 *
 * 背景：pi footer 的 `↑↓RW$` 统计整个会话文件的累计消耗（含已压缩历史与
 * compaction 摘要 usage），压缩后数值不变，易误解为"显示坏了"。
 * V1 把实时上下文 token 数并入 context 显示：`34.5k/1M (3.4%) (auto)`。
 *
 * V2（2026-08-24 审计修复）：分母与百分比改为**压缩临界窗口**
 * `effWindow = min(contextWindow, PI_CONTEXT_ABSOLUTE_TOKENS 默认 200K)`——
 * 1M 窗口下原显示 `34.5k/1M (3.4%)` 读起来"还很空"，实际 200K 压缩线已用 17%；
 * V2 显示 `34.5k/200k (17.2%)`，直观反映距自动压缩的距离。
 * 着色阈值同步改为基于压缩线（1M 窗口下旧逻辑 >70%×1M 永不触发，黄/红失效），
 * 超过压缩线（>100%）追加 " !!" 标记。
 * 压缩后 contextUsage.tokens 为 null，保持 `?/200k (auto)`。
 * ↑↓RW$ 累计口径保留（账单信息），不受影响。
 *
 * 依赖链（rebuild.sh 顺序）：live-context(V2) → cache(Part2 去百分比，支持 effWindow
 * 形态) → format → restart-hint(⚠ 标记，支持 effWindow 形态)。同步改这三个脚本的
 * 匹配形态，勿单独升级其中之一（pi update 后全链重新执行）。
 *
 * 用法：node patch-footer-live-context.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打 V2 补丁：输出跳过，exit 0（幂等）
 *   - 已打 V1 补丁：就地升级为 V2（含 restart-hint 已插入的形态）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER_V1 = 'Patch (patch-footer-live-context.mjs)'
const MARKER_V2 = 'Patch (patch-footer-live-context.mjs) V2'
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
if (src.includes(MARKER_V2)) {
  console.log(`已打 V2 补丁，跳过：${target}`)
  process.exit(0)
}

// ── 计算段（V1 形态 → V2 形态；全新注入时整体生成）──
// V1 计算段 = "// Patch (patch-footer-live-context.mjs):" 注释 + liveTokens/liveTokensStr 定义
const CALC_RE =
  /\/\/ Patch \(patch-footer-live-context\.mjs\):[\s\S]*?const liveTokensStr =\n\s+liveTokens !== null && liveTokens !== undefined && contextWindow > 0\n\s+\? `\$\{formatTokens\(liveTokens\)\}\/`\n\s+: "";/
const CALC_V2 = `// ${MARKER_V2}: 实时上下文显示——分母与百分比改为"压缩临界"min(窗口, PI_CONTEXT_ABSOLUTE_TOKENS 默认 200K)，
// 直观反映距自动压缩的距离（1M 窗口下旧显示 34.5k/1M (3.4%) 误读为还很空，实际 200K 线已用 17%）。
// 压缩后 tokens=null 显示 "?"；↑↓RW$ 累计口径不受影响。
    const compactLine = (() => {
        const raw = process.env.PI_CONTEXT_ABSOLUTE_TOKENS;
        const n = raw ? parseInt(raw, 10) : 0;
        return Number.isFinite(n) && n > 0 ? n : 200000;
    })();
    const effWindow = contextWindow > 0 ? Math.min(contextWindow, compactLine) : contextWindow;
    const liveTokens = contextUsage?.tokens;
    const liveTokensStr =
        liveTokens !== null && liveTokens !== undefined && effWindow > 0
            ? \`\${formatTokens(liveTokens)}/\`
            : "";`

// ── display 段（V1/cache/restart-hint 任一形态 → effWindow 形态，保留 restartHint 拼接）──
// 匹配形式：`?/${formatTokens(contextWindow)}` 与 `${liveTokensStr}${formatTokens(contextWindow)}${autoIndicator}[${restartHint}]`
const DISP_RE =
  /(const contextPercentDisplay = contextPercent === "\?"\n\s*\? `\?\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`\n\s*: `\$\{liveTokensStr\}\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}(?:\$\{restartHint\})?`;)/

// ── 着色块（原代码形态 → 基于压缩线 effWindow 的着色）──
const COLOR_RE =
  /if \(contextPercentValue > 90\) \{\n(\s+)contextPercentStr = theme\.fg\("error", contextPercentDisplay\);\n\s+\}\n\s+else if \(contextPercentValue > 70\) \{\n\s+contextPercentStr = theme\.fg\("warning", contextPercentDisplay\);\n\s+\}\n\s+else \{\n\s+contextPercentStr = contextPercentDisplay;\n\s+\}/
const COLOR_V2 = `// ${MARKER_V2} 着色: 阈值基于压缩临界 effWindow（1M 窗口下旧逻辑 >70%×1M=700K 永不触发，黄/红失效）；
// 有实时 token 用 liveTokens/effWindow（可 >100% → 已过压缩线加 " !!"），无实时（压缩后）回退窗口占用率。
    const colorPct = (liveTokens !== null && liveTokens !== undefined && effWindow > 0)
        ? (liveTokens / effWindow) * 100
        : contextPercentValue;
    if (colorPct > 120) {
        contextPercentStr = theme.fg("error", contextPercentDisplay + " !!");
    }
    else if (colorPct > 90) {
        contextPercentStr = theme.fg("error", contextPercentDisplay);
    }
    else if (colorPct > 70) {
        contextPercentStr = theme.fg("warning", contextPercentDisplay);
    }
    else {
        contextPercentStr = contextPercentDisplay;
    }`

let patched = src
const isV1 = CALC_RE.test(patched) || DISP_RE.test(patched)

if (isV1) {
  // V1 已应用 → 就地升级三段（计算段 / display 分母 / 着色块）
  patched = patched.replace(CALC_RE, CALC_V2)
  if (DISP_RE.test(patched)) {
    patched = patched.replace(DISP_RE, (m) => m.replaceAll('formatTokens(contextWindow)', 'formatTokens(effWindow)'))
  }
}

// 着色块：两条路径都要替换（原版与 V1 状态下同形态）
if (COLOR_RE.test(patched)) {
  patched = patched.replace(COLOR_RE, COLOR_V2)
}

// 全新安装（原代码）→ 从 display 定义注入 V2 完整块（含 percent 显示，后续 cache 补丁去百分比）
if (!isV1) {
  const re =
    /const contextPercentDisplay = contextPercent === "\?"\n(\s*)\? `\?\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`\n\s*: `\$\{contextPercent\}%\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`;/
  const m = src.match(re)
  if (!m) {
    console.error('未匹配到 footer.js contextPercentDisplay 原代码（pi 版本可能已改动或补丁形态异常），需人工核对。')
    process.exit(1)
  }
  const indent = m[1]
  patched = src.replace(
    re,
    `${CALC_V2}\n${indent}const effPercent = (liveTokens !== null && liveTokens !== undefined && effWindow > 0)\n${indent}    ? String(Math.round((liveTokens / effWindow) * 1000) / 10)\n${indent}    : contextPercent;\n${indent}const contextPercentDisplay = contextPercent === "?"\n${indent}    ? \`?/\${formatTokens(effWindow)}\${autoIndicator}\`\n${indent}    : \`\${liveTokensStr}\${formatTokens(effWindow)} (\${effPercent}%)\${autoIndicator}\`;`,
  )
  if (!COLOR_RE.test(patched)) {
    console.error('未匹配到 footer.js 着色块（pi 版本可能已改动），需人工核对。')
    process.exit(1)
  }
}

if (DRY_RUN) { console.log(`dry-run：${target} 模式命中，未写盘`); process.exit(0) }
writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用（${isV1 ? 'V1 就地升级' : '全新注入'}）：${target}`)
console.log('提示：pi update 后需重跑本脚本（rebuild.sh Phase 3 自动执行）；cache/restart-hint 补丁形态已同步支持 effWindow。')