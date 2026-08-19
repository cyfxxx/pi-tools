#!/usr/bin/env node
/**
 * verify-patches.mjs — 校验 TUI 补丁的目标 pi 版本与当前安装版本匹配。
 *
 * 背景：8 个 patch-*.mjs 直接修改 pi 安装包 dist，pi update 后原代码可能移位/改名，
 * 旧补丁会静默跳过（rebuild.sh 旧逻辑仅 warn）。本脚本把「补丁版本失配」从 warn 升级为
 * 显式失败，防止更新后补丁失效不被察觉（丢失 footer 实时 token / 回车键被吞等行为回退）。
 *
 * 版本语义：补丁文件头声明 `@target-version 0.84`（major.minor）。当前 pi 0.84.x
 * 任意 patch 级均视为匹配（minor 内补丁保持幂等跳过语义）。
 *
 * 用法：node scripts/verify-patches.mjs [pi-coding-agent dist 目录]
 *   （参数缺省读 PI_DIST 环境变量）
 *   exit 0 = 全部匹配；exit 1 = 存在失配（供 rebuild.sh Phase 3 判定）；exit 2 = 用法错误
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = resolve(__dirname)

const piDist = process.argv[2] || process.env.PI_DIST
if (!piDist) {
  console.error('用法: node verify-patches.mjs [pi dist 目录]（或设 PI_DIST）')
  process.exit(2)
}

// 当前 pi 版本：dist/ 的父目录即 pi-coding-agent 包根
const pkgPath = join(piDist, '..', 'package.json')
let currentVersion = ''
try {
  currentVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
} catch {
  console.error(`无法读取 pi 版本（${pkgPath}）——先安装 pi 再跑 rebuild`)
  process.exit(2)
}
const currentMinor = currentVersion.split('.').slice(0, 2).join('.')

// 扫描补丁文件（按数字后缀顺序，与 rebuild.sh Phase 3 一致）
const patchFiles = readdirSync(SCRIPTS_DIR)
  .filter((f) => /^patch-[a-z0-9-]+\.mjs$/.test(f))
  .sort()

let mismatched = []
for (const f of patchFiles) {
  const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8')
  const m = src.match(/@target-version\s+(\d+\.\d+)/)
  if (!m) {
    mismatched.push({ f, declared: '(未声明)' })
    continue
  }
  if (m[1] !== currentMinor) {
    mismatched.push({ f, declared: m[1] })
  }
}

if (mismatched.length === 0) {
  console.log(`✓ 补丁版本匹配（${patchFiles.length} 个全部声明 @target-version ${currentMinor}，当前 pi ${currentVersion}）`)
  process.exit(0)
}
console.error(`✗ ${mismatched.length} 个补丁与当前 pi ${currentVersion}（期望 @target-version ${currentMinor}）失配:`)
for (const { f, declared } of mismatched) {
  console.error(`   - ${f}: 声明 ${declared}`)
}
console.error('处理：更新这些文件头部的 @target-version 声明并核对补丁逻辑仍适用（pi update 后原代码可能移位），然后重跑 rebuild')
process.exit(1)