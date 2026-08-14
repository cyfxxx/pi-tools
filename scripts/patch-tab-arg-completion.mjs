#!/usr/bin/env node
/**
 * patch-tab-arg-completion.mjs — Tab 参数补全补丁（幂等）。
 *
 * 背景：pi-tui editor.js handleTabCompletion 中，斜杠命令上下文只有"无空格"
 * 时走命令名补全（force:false）；一旦有空格（如 `/voice `）按 Tab 走
 * forceFileAutocomplete(true) → getSuggestions(force:true) 跳过斜杠命令分支 →
 * extractPathPrefix(force:true) 把 `/voice ` 当路径 → 文件补全。
 * 结果：`/voice` Tab 自动加空格后，子命令补全永远不显示（需手动删空格重打空格，
 * 靠输入字符触发非 force 补全才显示）。
 *
 * 本补丁：斜杠命令上下文统一走 handleSlashCommandCompletion()（force:false）——
 * 无空格 = 命令名补全（行为不变），有空格 = getArgumentCompletions 参数补全
 * （/voice 等扩展子命令 Tab 可见；命令无参数补全时 fallback 文件补全不变）。
 *
 * 用法：node patch-tab-arg-completion.mjs [dist 目录]
 *   - 不传参数：自动探测（默认 /root/.local/share/pi-node/...）
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本（rebuild.sh Phase 3 自动执行）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-tab-arg-completion.mjs)'

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

// pi-tui 在 pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/editor.js
const target = join(detectDist(), '..', 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'components', 'editor.js')
if (!existsSync(target)) {
  console.error(`找不到 ${target}`)
  process.exit(1)
}

let src = readFileSync(target, 'utf-8')

if (src.includes(MARKER)) {
  console.log(`已打补丁，跳过：${target}`)
  process.exit(0)
}

// 原代码（pi-tui 0.84.x）：
//   handleTabCompletion() {
//       if (!this.autocompleteProvider)
//           return;
//       const currentLine = this.state.lines[this.state.cursorLine] || "";
//       const beforeCursor = currentLine.slice(0, this.state.cursorCol);
//       if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
//           this.handleSlashCommandCompletion();
//       }
//       else {
//           this.forceFileAutocomplete(true);
//       }
//   }
const needle =
  'if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {' +
  '\n            this.handleSlashCommandCompletion();' +
  '\n        }' +
  '\n        else {' +
  '\n            this.forceFileAutocomplete(true);' +
  '\n        }'

if (!src.includes(needle)) {
  console.error(`未匹配到 handleTabCompletion 原代码（pi-tui 版本可能已变）：${target}`)
  console.error('请核对 editor.js 中 handleTabCompletion 的 Tab 分支后更新本脚本')
  process.exit(1)
}

const patched = src.replace(
  needle,
  'if (this.isInSlashCommandContext(beforeCursor)) {' +
    '\n            // Patch (patch-tab-arg-completion.mjs): 斜杠命令上下文统一走非 force 补全——' +
    '\n            // 无空格 = 命令名匹配，有空格 = getArgumentCompletions 参数补全' +
    '\n            // （原实现有空格时走 forceFileAutocomplete，/voice 等子命令永远不显示）' +
    '\n            this.handleSlashCommandCompletion();' +
    '\n        }' +
    '\n        else {' +
    '\n            this.forceFileAutocomplete(true);' +
    '\n        }',
)

writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用：${target}`)
console.log('提示：pi update 后需重跑本脚本（rebuild.sh Phase 3 自动执行）。')
