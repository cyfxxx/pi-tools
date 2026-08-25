#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-footer-live-context.mjs — footer 实时上下文 token 显示补丁（幂等，V3.1）。
 *
 * 背景：pi footer 的 `↑↓RW$` 统计整个会话文件的累计消耗（含已压缩历史与
 * compaction 摘要 usage），压缩后数值不变，易误解为"显示坏了"。
 * V1 把实时上下文 token 数并入 context 显示。
 * V2（2026-08-24）：分母改为压缩临界 min(窗口, 200K)——后被否决：把自动压缩
 * 条件之一冒充上下文窗口显示会造成误会（用户反馈 2026-08-25）。
 *
 * V3/V3.1（现行）：
 * - 分母恒为真实 contextWindow（`x/1M`），不显示压缩线数字；
 * - 自动压缩参考线 PI_CONTEXT_ABSOLUTE_TOKENS 默认 256K 仅用于着色预警：
 *   达线黄、超真实窗口 80% 红（优先级更高）、超窗加 !!——同时解决大窗口模型
 *   按窗口占比着色永不触发的问题；达线≠必然压缩（普通压缩受完成/后台/空闲
 *   三重门限约束），仅模型真实窗口溢出才强制压缩；
 * - 压缩后 tokens=null 显示 "?"；↑↓RW$ 累计口径保留（账单信息）。
 *
 * 依赖链（rebuild.sh 顺序）：live-context(V3) → cache(Part2 去百分比，支持
 * effWindow 形态) → format → restart-hint(⚠ 标记，支持 effWindow 形态)。
 *
 * 用法：node patch-footer-live-context.mjs [dist 目录]
 *   - 不传参数：自动探测；PI_DIST 环境变量优先
 *   - 已打 V3.1：跳过（幂等）；V2/旧 V3/半状态：就地升级
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本（rebuild.sh Phase 3 自动执行）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER_V1 = 'Patch (patch-footer-live-context.mjs)'
const MARKER_V2 = 'Patch (patch-footer-live-context.mjs) V2'
const MARKER_V3 = 'Patch (patch-footer-live-context.mjs) V3'
const MARKER_V31 = 'Patch (patch-footer-live-context.mjs) V3.1'
// dry-run 校验模式（verify-patches.mjs 调用）：只做模式命中检测，不写盘
const DRY_RUN = process.env.PATCH_DRY_RUN === '1'

// ── 注入模板 ──────────────────────────────────────────────

/** 计算段模板（V3）：分母=真实窗口；compactLine 仅供着色 */
const CALC_V3 = `// ${MARKER_V3}: 实时上下文显示——分母恒为真实上下文窗口（压缩线不是窗口，显示 x/256k 会误导）。
// 自动压缩参考线 PI_CONTEXT_ABSOLUTE_TOKENS 默认 256K 仅用于着色预警：达线黄、超窗80%红+!!。
// 达线≠必然压缩（普通压缩受完成/后台/空闲三重门限约束）；压缩后 tokens=null 显示 "?"。
    const compactLine = (() => {
        const raw = process.env.PI_CONTEXT_ABSOLUTE_TOKENS;
        const n = raw ? parseInt(raw, 10) : 0;
        return Number.isFinite(n) && n > 0 ? n : 256000;
    })();
    const effWindow = contextWindow > 0 ? contextWindow : compactLine; // 即真实窗口（历史变量名，下游 cache/restart-hint 补丁引用）
    const liveTokens = contextUsage?.tokens;
    const liveTokensStr =
        liveTokens !== null && liveTokens !== undefined && effWindow > 0
            ? \`\${formatTokens(liveTokens)}/\`
            : "";`

/** V3.1 双指标着色体（$MARKER$ 为注释头占位） */
const COLOR_BODY = `// $MARKER$ 着色: 双指标——黄=达自动压缩参考线(256K)；红=超真实窗口 80%（溢出预警，优先级更高，超窗加!!）。
// 显示分母仍为真实窗口；两指标口径独立（小窗口模型红会先于黄触发，自洽）。
    const linePct = (liveTokens !== null && liveTokens !== undefined && compactLine > 0)
        ? (liveTokens / compactLine) * 100
        : -1;
    const winPct = (liveTokens !== null && liveTokens !== undefined && contextWindow > 0)
        ? (liveTokens / contextWindow) * 100
        : contextPercentValue;
    if ((winPct > 80 || contextPercentValue > 90)) {
        if (winPct > 100) {
            contextPercentStr = theme.fg("error", contextPercentDisplay + " !!");
        }
        else {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
        }
    }
    else if (linePct >= 100) {
        contextPercentStr = theme.fg("warning", contextPercentDisplay);
    }
    else {
        contextPercentStr = contextPercentDisplay;
    }`

const COLOR_V3 = `// ${MARKER_V31} ` + COLOR_BODY.replace('$MARKER$', '着色')

/** display 段正则：V1 形态（contextWindow 分母）→ effWindow 形态 */
const DISP_RE =
  /(const contextPercentDisplay = contextPercent === "\?"\n\s*\? `\?\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`\n\s*: `\$\{liveTokensStr\}\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}(?:\$\{restartHint\})?`;)/

/** 原版着色块正则（0.84.x 原代码形态；半状态修复与全新注入共用） */
const COLOR_RE =
  /if \(contextPercentValue > 90\) \{\n(\s+)contextPercentStr = theme\.fg\("error", contextPercentDisplay\);\n\s+\}\n\s+else if \(contextPercentValue > 70\) \{\n\s+contextPercentStr = theme\.fg\("warning", contextPercentDisplay\);\n\s+\}\n\s+else \{\n\s+contextPercentStr = contextPercentDisplay;\n\s+\}/

/** 旧 V3 单指标着色块正则（V3 首版产物，V3.1 就地升级用） */
const COLOR_V3_OLD_RE =
  /\/\/ Patch \(patch-footer-live-context\.mjs\) V3 着色:[^\n]*\n[^\n]*\n[\s\S]*?contextPercentStr = contextPercentDisplay;\n    \}/

// ── 主流程 ────────────────────────────────────────────────

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

const target = join(detectDist(), 'modes', 'interactive', 'components', 'footer.js')
if (!existsSync(target)) {
  console.error(`找不到 ${target}`)
  process.exit(1)
}
const src = readFileSync(target, 'utf-8')

// ── 幂等/升级分支 ──
if (src.includes(MARKER_V31) || src.includes('linePct')) {
  console.log(`已打 V3.1 补丁，跳过：${target}`)
  process.exit(0)
}

if (src.includes(MARKER_V3)) {
  // V3 半状态/旧着色 → V3.1：待修形态两种——①旧 V3 单指标着色块 ②原版着色
  // （历史 bug：全新注入曾用 src.replace 重算丢弃着色替换，产出半状态）
  let fixed = src.replace(COLOR_V3_OLD_RE, COLOR_BODY.replace('$MARKER$', MARKER_V31))
  if (fixed === src && COLOR_RE.test(src)) {
    fixed = src.replace(COLOR_RE, COLOR_BODY.replace('$MARKER$', MARKER_V31))
  }
  if (!fixed.includes('linePct')) {
    console.error('V3→V3.1 着色修正未命中预期形态（既非旧 V3 块也非原版着色），需人工核对。')
    process.exit(1)
  }
  if (!DRY_RUN) writeFileSync(target, fixed, 'utf-8')
  console.log(`${DRY_RUN ? 'dry-run：' : ''}V3 着色已升级 V3.1（双指标阈值）：${target}`)
  process.exit(0)
}

// ── V2 状态 → 直接按 V3 全新注入处理（V2 的 CALC 结构与新注入同构，标记不同）──
// （V2 用户极少：仅 2026-08-25 当日窗口，统一走下方全新/升级路径即可）

let patched = src
const isV1 = src.includes(MARKER_V1) || CALC_RE_TEST(src)

/** V1 计算段形态检测（避免维护完整正则的转义漂移；V1 仅存在于极老安装） */
function CALC_RE_TEST(s) {
  return s.includes('// Patch (patch-footer-live-context.mjs):') && s.includes('const liveTokensStr =')
}

if (isV1) {
  // V1 → V3：整体替换计算段（从 MARKER_V1 注释到 liveTokensStr 定义）
  const re = new RegExp(
    `${MARKER_V1.replace(/[()]/g, '\\$&')}:[\\s\\S]*?const liveTokensStr =\\n\\s+liveTokens !== null && liveTokens !== undefined && contextWindow > 0\\n\\s+\\? \`\\$\\{formatTokens\\(liveTokens\\)\\}\\/\`\\n\\s+: "";`,
  )
  patched = patched.replace(re, CALC_V3)
  if (DISP_RE.test(patched)) {
    patched = patched.replace(DISP_RE, (m) => m.replaceAll('formatTokens(contextWindow)', 'formatTokens(effWindow)'))
  }
}

// 着色块：V1/全新状态下均为原版权色形态
if (COLOR_RE.test(patched)) {
  patched = patched.replace(COLOR_RE, COLOR_BODY.replace('$MARKER$', MARKER_V31))
}

// 全新安装（原代码，无任何补丁标记）→ 从 contextPercentDisplay 定义注入完整块
if (!isV1 && !src.includes(MARKER_V1)) {
  const re =
    /const contextPercentDisplay = contextPercent === "\?"\n(\s*)\? `\?\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`\n\s*: `\$\{contextPercent\}%\/\$\{formatTokens\(contextWindow\)\}\$\{autoIndicator\}`;/
  // 审计修复（2026-08-25）: 此前用 src.replace 重算，丢弃了上方已完成的着色替换，
  // 产出「CALC 已注入、着色仍原版」的半状态（0.84.3 更新实测复现）；改基于 patched 迭代
  const m = patched.match(re)
  if (!m) {
    console.error('未匹配到 footer.js contextPercentDisplay 原代码（pi 版本可能已改动或补丁形态异常），需人工核对。')
    process.exit(1)
  }
  const indent = m[1]
  patched = patched.replace(
    re,
    `${CALC_V3}\n${indent}const effPercent = (liveTokens !== null && liveTokens !== undefined && effWindow > 0)\n${indent}    ? String(Math.round((liveTokens / effWindow) * 1000) / 10)\n${indent}    : contextPercent;\n${indent}const contextPercentDisplay = contextPercent === "?"\n${indent}    ? \`?/\${formatTokens(effWindow)}\${autoIndicator}\`\n${indent}    : \`\${liveTokensStr}\${formatTokens(effWindow)} (\${effPercent}%)\${autoIndicator}\`;`,
  )
  if (!patched.includes(MARKER_V31)) {
    console.error('未匹配到 footer.js 着色块（pi 版本可能已改动），需人工核对。')
    process.exit(1)
  }
}

if (DRY_RUN) { console.log(`dry-run：${target} 模式命中，未写盘`); process.exit(0) }
writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用（${isV1 ? 'V1 就地升级' : '全新注入'}）：${target}`)
console.log('提示：pi update 后需重跑本脚本（rebuild.sh Phase 3 自动执行）；cache/restart-hint 补丁形态已同步支持 effWindow。')
