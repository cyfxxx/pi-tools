// subagent vitest 配置：本扩展无本地 node_modules，@earendil-works/* 与 typebox
// 需 alias 到全局 pi SDK。探测逻辑与 tests/loader.mjs 保持一致
// （PI_SDK_PATH → npm root -g → 便携回退）。
import { defineConfig } from 'vitest/config'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function detectSdkBase(): string {
  if (process.env.PI_SDK_PATH) return process.env.PI_SDK_PATH
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = resolve(root, '@earendil-works/pi-coding-agent')
    if (existsSync(candidate)) return candidate
  } catch {
    /* fall through to legacy default */
  }
  return '/root/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent'
}

function pkgEntry(base: string, name: string): string {
  const dir = name === '@earendil-works/pi-coding-agent' ? base : resolve(base, 'node_modules', name)
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  const e = pkg.exports?.['.']?.import ?? pkg.exports?.['.'] ?? pkg.main
  const target = typeof e === 'string' ? e : (e?.import ?? e?.default)
  return resolve(dir, target)
}

const BASE = detectSdkBase()
const PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
  'typebox',
]

export default defineConfig({
  resolve: {
    alias: PACKAGES.map((name) => ({ find: name, replacement: pkgEntry(BASE, name) })),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
