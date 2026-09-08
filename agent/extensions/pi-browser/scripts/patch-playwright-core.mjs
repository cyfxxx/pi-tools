#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-playwright-core.mjs — Termux/Android 平台补丁：playwright-core 的 linux 平台分支扩展至 android。
 *
 * 背景：Termux 的 Node 报告 process.platform / os.platform() === "android"，而 playwright-core
 * 的缓存目录/二进制路径解析只认 linux/darwin/win32，android 会落到 `<unknown>` 导致浏览器启动失败。
 * 本补丁把各文件的 `platform === "linux"` 判断（含 process.platform / os.platform() 写法）扩展为
 * `=== "linux" || === "android"`——android 复用 linux 的路径布局（Termux 是 POSIX 兼容）。
 *
 * 仅 Termux 需要。统一依赖根布局（2026-08-19）：playwright-core 在 agent/node_modules，
 * 目标为 lib/server 结构（hostPlatform/registry 等，非旧版 lib/coreBundle.js）。
 * 实现为逐文件精确字符串替换（非正则通配，避免误伤/重复）；幂等：已含 NEW 则跳过。
 * 用法：node patch-playwright-core.mjs [agent 目录]（默认自动探测）
 *   - 全部命中并应用/已跳过：exit 0；有文件未匹配（升级改动）：exit 1 需人工核对
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 逐文件「原文 → 补丁后」精确替换表（playwright-core 1.53.x lib/server 布局实测）
const PATCHES = [
  { rel: 'lib/server/registry/index.js',
    old: 'if (process.platform === "linux")',
    new: 'if (process.platform === "linux" || process.platform === "android")' },
  { rel: 'lib/server/utils/hostPlatform.js',
    old: 'if (platform === "linux") {',
    new: 'if (platform === "linux" || platform === "android") {' },
  { rel: 'lib/server/utils/userAgent.js',
    old: '} else if (process.platform === "linux") {',
    new: '} else if (process.platform === "linux" || process.platform === "android") {' },
  { rel: 'lib/server/chromium/crPage.js',
    old: 'else if (process.platform === "linux")',
    new: 'else if (process.platform === "linux" || process.platform === "android")' },
  { rel: 'lib/server/webkit/webkit.js',
    old: '} else if (process.platform === "linux") {',
    new: '} else if (process.platform === "linux" || process.platform === "android") {' },
  { rel: 'lib/cli/program.js',
    old: 'browserType.name() === "webkit" && process.platform === "linux"',
    new: 'browserType.name() === "webkit" && (process.platform === "linux" || process.platform === "android")' },
  // os.platform() 写法（registry 另两处 + firefox 系）
]
// 追加 registry 的 os.platform() 两处与 bidi/electron/firefox（与上表相互独立）
for (const f of ['registry/index.js', 'bidi/bidiFirefox.js', 'electron/electron.js', 'firefox/firefox.js']) {
  PATCHES.push({
    rel: `lib/server/${f}`,
    old: 'import_os.default.platform() === "linux"',
    new: 'import_os.default.platform() === "linux" || import_os.default.platform() === "android"',
  })
}

function detectDir() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  const base = process.env.PI_HOME || join(process.env.HOME || '', '.pi')
  const p = join(base, 'agent')
  return existsSync(join(p, 'node_modules/playwright-core')) ? p : ''
}

const agentDir = detectDir()
if (!agentDir) {
  console.error('未找到 agent/node_modules/playwright-core（依赖未安装？先跑 rebuild Phase 2-A）')
  process.exit(1)
}
if (!existsSync('/data/data/com.termux')) {
  console.log('非 Termux 环境，无需 playwright-core 补丁')
  process.exit(0)
}

let applied = 0, skipped = 0, missing = 0, errors = 0
const seen = new Set()
for (const p of PATCHES) {
  if (seen.has(p.rel + '\u0000' + p.old)) continue
  seen.add(p.rel + '\u0000' + p.old)
  const file = join(agentDir, 'node_modules/playwright-core', p.rel)
  if (!existsSync(file)) { console.warn(`跳过（不存在）: ${p.rel}`); missing++; continue }
  const src = readFileSync(file, 'utf8')
  if (src.includes(p.new)) { skipped++; continue }
  if (!src.includes(p.old)) {
    console.error(`未匹配到: ${p.rel} —「${p.old}」\n（playwright-core 升级改动？需人工核对补丁表）`)
    errors++
    continue
  }
  // 替换该文件全部出现处（registry 同 pattern 2 处）
  const cnt = src.split(p.old).length - 1
  writeFileSync(file, src.split(p.old).join(p.new))
  console.log(`补丁已应用: ${p.rel}（${cnt} 处）`)
  applied++
}

if (errors > 0) {
  console.error(`✗ ${errors} 处未匹配—— playwright-core 结构变化，人工更新补丁表后重跑`)
  process.exit(1)
}
console.log(`完成：应用 ${applied} 项 / 幂等跳过 ${skipped} 项 / 缺失文件 ${missing} 项`)
console.log('提示：npm install（agent/）重装后需重跑本脚本（rebuild.sh Phase 3 自动执行）。')
process.exit(0)