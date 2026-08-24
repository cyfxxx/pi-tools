#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-voice-enter.mjs — pi-voice 回车拦截补丁（幂等）。
 *
 * 背景：pi 的 registerShortcut 匹配按键即消费，handler 返回值被忽略，
 * 导致扩展无法"条件拦截"回车（录音中拦截、未录音放行）。
 * 本补丁修改 interactive-mode.js 的 onExtensionShortcut：
 * handler 同步返回 false 时不消费该按键，继续内置处理（输入提交等）。
 *
 * 用法：node patch-voice-enter.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-voice-enter.mjs)'
// dry-run 校验模式（verify-patches.mjs 调用）：只做模式命中检测，不写盘
const DRY_RUN = process.env.PATCH_DRY_RUN === '1'

/** 自动探测 pi 安装的 dist 根目录。 */
function detectDist() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  // 1. PI_DIST 环境变量
  if (process.env.PI_DIST && existsSync(process.env.PI_DIST)) return process.env.PI_DIST
  // 2. which pi → 反推 node_modules/@earendil-works/pi-coding-agent/dist
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
  // 3. 当前环境已知路径
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

const target = join(detectDist(), 'modes', 'interactive', 'interactive-mode.js')
if (!existsSync(target)) {
  console.error(`找不到 ${target}`)
  process.exit(1)
}

const src = readFileSync(target, 'utf-8')
if (src.includes(MARKER)) {
  console.log(`已打补丁，跳过：${target}`)
  process.exit(0)
}

// 匹配 onExtensionShortcut 中"匹配即消费"的循环体，替换为支持 false 放行的版本
const re =
  /(if \(matchesKey\(data, shortcutStr\)\) \{)[\s\S]*?(return true;\n\s*\}\n\s*\}\n\s*return false;)/
const m = src.match(re)
if (!m) {
  console.error('未匹配到 onExtensionShortcut 原代码（pi 版本可能已改动），需人工核对。')
  process.exit(1)
}

const patched = src.replace(
  re,
  `$1
                    // ${MARKER}: handler 同步返回 false 时放行按键（条件拦截，如录音中才拦截回车）。
                    const result = shortcut.handler(createContext());
                    if (result === false) continue;
                    // Run handler async, don't block input
                    Promise.resolve(result).catch((err) => {
                        this.showError(\`Shortcut handler error: \${err instanceof Error ? err.message : String(err)}\`);
                    });
                    $2`,
)

if (DRY_RUN) { console.log(`dry-run：${target} 模式命中，未写盘`); process.exit(0) }
writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用：${target}`)
console.log('提示：pi update 后需重跑本脚本（可加入 rebuild.sh 或手动执行）。')
