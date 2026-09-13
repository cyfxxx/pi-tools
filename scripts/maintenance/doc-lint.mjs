#!/usr/bin/env node
/**
 * doc-lint: 扩展 README 与代码的轻量一致性守门（2026-08-25 文档漂移审计产物）
 *
 * 只做高价值、低误报的断言：
 *  1. 工具名一致：源码注册的工具（name: 'xxx'）必须在对应 README 出现
 *  2. slash 命令一致：registerCommand('xxx') 必须在 README 以 /xxx 出现
 *  3. 测试计数防漂移：README 不应声明具体用例数（数字会过时）
 *
 * 已知局限（有意不做）：不校验机制描述/阈值/行号——那些需要语义理解，由审计流程覆盖；本脚本只抓"机械可验证且漂移高发"的三类。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/root/.pi'
const EXT_DIR = join(ROOT, 'agent', 'extensions')
const SKIP = new Set(['node_modules', 'tests', 'types', 'lib'])

function* extDirs() {
  const entries = readdirSync(EXT_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue
    const full = join(EXT_DIR, entry.name)
    const index = join(full, 'index.ts')
    if (existsSync(index)) yield entry.name, full
  }
}

const toolNameErrors = []
const slashCmdErrors = []
const countErrors = []

for (const [extName, extPath] of extDirs()) {
  const readme = join(extPath, 'README.md')
  if (!existsSync(readme)) continue
  const readmeContent = readFileSync(readme, 'utf-8')

  // 1. 工具名一致 - 使用简单的方法匹配 registerTool
  const toolMatches = readmeContent.match(/registerTool\(\s*{[^}]*name:\s*['"`]([^'"`]+)['"`]/g) || []
  const toolNamesInReadme = toolMatches.map(m => m.replace(/registerTool\(\s*{[^}]*name:\s*['"`]/, '').replace(/['"`]$/, ''))

  // 遍历源码匹配 registerTool
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        const txt = readFileSync(full, 'utf-8')
        const trMatches = txt.match(/registerTool\(\s*{[^}]*name:\s*['"`]([^'"`]+)['"`]/g) || []
        trMatches.forEach(tr => {
          const toolName = tr.replace(/registerTool\(\s*{[^}]*name:\s*['"`]/, '').replace(/['"`]$/, '')
          if (!toolNamesInReadme.includes(toolName)) {
            toolNameErrors.push(`${extName}/${entry.name}: 工具名 "${toolName}" 未在 README.md 中提及`) // 忽略 case
          }
        })
      }
    }
  }
  walk(extPath)

  // 2. slash 命令一致 - 从 README 中提取所有以 '/' 开头的单词
  const slashCmdsInReadme = readmeContent.match(/\s+(\/[a-zA-Z0-9_-]+)\s/g)?.map(x => x.trim()) || []

  const indexSrc = readFileSync(join(extPath, 'index.ts'), 'utf-8')
  // 使用字符串分割代替正则，避免 / 在 regex 中的转义问题
  const cmdMatches = []
  let cmdIdx = 0
  while ((cmdIdx = indexSrc.indexOf('registerCommand', cmdIdx)) !== -1) {
    cmdIdx += 'registerCommand'.length
    // 跳过空白和括号
    let j = cmdIdx
    while (j < indexSrc.length && (indexSrc[j] === ' ' || indexSrc[j] === '\t' || indexSrc[j] === '\n')) j++
    if (j >= indexSrc.length) break
    if (indexSrc[j] === '(') {
      j++
      // 查找 name: 属性
      let k = j
      while (k < indexSrc.length && indexSrc[k] !== 'n') k++
      if (k < indexSrc.length && indexSrc.slice(k, k + 5) === 'name:') {
        k += 5
        // 跳过空白
        while (k < indexSrc.length && (indexSrc[k] === ' ' || indexSrc[k] === '\t')) k++
        if (k < indexSrc.length && (indexSrc[k] === '"' || indexSrc[k] === "'" || indexSrc[k] === '`')) {
          const quote = indexSrc[k]
          k++
          let cmdStart = k
          while (k < indexSrc.length && indexSrc[k] !== quote) k++
          if (k < indexSrc.length) {
            const cmd = indexSrc.slice(cmdStart, k)
            cmdMatches.push(cmd)
          }
        }
      }
    }
    cmdIdx = j
  }

  cmdMatches.forEach(cmd => {
    if (cmd.startsWith('/') && !slashCmdsInReadme.includes(cmd)) {
      slashCmdErrors.push(`${extName}: slash 命令 "${cmd}" 未在 README.md 中提及`) // 忽略 case
    }
  })

  // 3. 测试计数防漂移 - 检查 README 中是否有具体数字
  const countRegex = /\d+\s*个?\s*用例?/g
  const counts = readmeContent.match(countRegex)
  if (counts && counts.length > 0) {
    countErrors.push(`${extName}: README 中提到了测试用例数，可能存在漂移风险（检查是否需要更新）`)
  }
}

if (toolNameErrors.length === 0 && slashCmdErrors.length === 0 && countErrors.length === 0) {
  console.log('✓ doc-lint 通过：工具/slash 命令清单与 README 一致')
  process.exit(0)
}

for (const err of toolNameErrors) console.error('✗ ' + err)
for (const err of slashCmdErrors) console.error('✗ ' + err)
for (const err of countErrors) console.error('✗ ' + err)

console.error(`\ndoc-lint 失败（${toolNameErrors.length} 个工具名 / ${slashCmdErrors.length} 个 slash 命令 / ${countErrors.length} 个测试计数问题）`)
process.exit(1)
