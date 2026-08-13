#!/usr/bin/env node
/**
 * patch-playwright-core.mjs — Termux/Android 平台补丁：playwright-core 的 linux 平台分支扩展至 android。
 *
 * 背景：Termux 的 Node 报告 process.platform === "android"，而 playwright-core 的
 * 缓存目录/二进制路径解析只认 linux/darwin/win32，直接 throw "Unsupported platform: android"。
 * 本补丁把所有 `process.platform === "linux"` 分支改为 `=== "linux" || === "android"`——
 * android 复用 linux 的路径布局（Termux 是 POSIX 兼容），修复后 cloakbrowser 可启动本地 Chromium。
 *
 * 仅 Termux 需要（其他平台 linux 原生支持，无 android 平台身份）。
 * 用法：node patch-playwright-core.mjs [pi-browser 扩展目录]（默认自动探测）
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（playwright-core 升级改动）：报错 exit 1，需人工核对
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'process.platform === "android"'
const OLD = 'if (process.platform === "linux")'
const NEW = 'if (process.platform === "linux" || process.platform === "android")'

/** 自动探测 pi-browser 扩展目录（playwright-core 所在）。 */
function detectExtDir() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  const candidates = [
    process.env.PI_HOME || join(process.env.HOME || '', '.pi'),
  ]
  for (const base of candidates) {
    const p = join(base, 'agent/extensions/pi-browser')
    if (existsSync(join(p, 'node_modules/playwright-core'))) return p
  }
  return ''
}

const extDir = detectExtDir()
if (!extDir) {
  console.error('未找到 pi-browser 扩展目录（playwright-core 未安装？先跑 rebuild Phase 2-A）')
  process.exit(1)
}

// Termux 检测：非 Termux 环境不需要本补丁（linux 原生支持）
const isTermux = existsSync('/data/data/com.termux')
if (!isTermux) {
  console.log('非 Termux 环境，无需 playwright-core 补丁')
  process.exit(0)
}

const targets = [
  'node_modules/playwright-core/lib/coreBundle.js',
  'node_modules/playwright-core/lib/serverRegistry.js',
  'node_modules/playwright-core/lib/tools/cli-client/registry.js',
]

let patched = 0
let skipped = 0
for (const rel of targets) {
  const file = join(extDir, rel)
  if (!existsSync(file)) {
    console.warn(`跳过（不存在）: ${rel}`)
    continue
  }
  const src = readFileSync(file, 'utf8')
  if (src.includes(MARKER)) {
    console.log(`已打补丁（幂等跳过）: ${rel}`)
    skipped++
    continue
  }
  const count = src.split(OLD).length - 1
  if (count === 0) {
    console.error(`未匹配到 linux 平台分支（playwright-core 升级改动？）: ${rel}`)
    process.exit(1)
  }
  writeFileSync(file, src.split(OLD).join(NEW))
  console.log(`补丁已应用: ${rel}（${count} 处）`)
  patched++
}

if (patched === 0 && skipped === targets.length) {
  console.log('全部已打补丁，跳过')
} else if (patched === 0 && skipped === 0) {
  console.error('无文件可打补丁（playwright-core 未安装？）')
  process.exit(1)
}
console.log('提示：pi-browser npm install 重装后需重跑本脚本（rebuild.sh Phase 3 自动执行）。')
process.exit(0)
