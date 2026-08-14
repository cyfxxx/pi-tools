#!/usr/bin/env node
/**
 * patch-plan-tools.mjs — plan-mode 工具 schema 恢复补丁（幂等）。
 *
 * 背景（2026-08-10 实证）：--continue 恢复会话后，模型函数调用 schema 不含
 * 重启后新注册的扩展工具（plan_enter/plan_exit）。实测：会话文件 tool_calls
 * 中 plan_enter 出现 0 次（模型无法发出该调用，退化为 bash），而 --print
 * 新进程正常。state.tools 经 setActiveTools 正确更新（debug log 证明含
 * plan_enter），但 prepareNextTurnWithContext 注入的 schema 仍是旧快照。
 *
 * 本补丁修改 core/agent-session.js 的 _installAgentNextTurnRefresh：
 * tools 注入处检测 state.tools 是否缺当前注册工具，缺则调用 _refreshToolRegistry
 * 刷新（保留已有活动工具 + 纳入新注册工具），并返回刷新后的 tools——保证模型
 * 函数调用 schema 可见新工具（plan_enter/plan_exit）。
 *
 * 说明（决策记录）：此补丁解决"TUI 恢复会话模型无法调用新注册工具"的内核缺陷。
 * 若后续不需要模型侧主动切换（用户快捷键切换已完整），移除本补丁即可（方案 2）。
 *
 * 用法：node patch-plan-tools.mjs [dist 目录]
 *   - 不传参数：自动探测
 *   - 已打补丁：输出跳过，exit 0（幂等）
 *   - 未匹配到原代码（pi 升级改动）：报错 exit 1，需人工核对
 *
 * pi update 后需重新执行本脚本（rebuild.sh 自动执行）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-plan-tools.mjs)'

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

const target = join(detectDist(), 'core', 'agent-session.js')
if (!existsSync(target)) {
  console.error(`找不到 ${target}`)
  process.exit(1)
}

let src = readFileSync(target, 'utf-8')
if (src.includes(MARKER)) {
  console.log(`已打补丁，跳过：${target}`)
  process.exit(0)
}

// 匹配 prepareNextTurnWithContext 的 tools 注入（agent-session.js _installAgentNextTurnRefresh）
// 原文形如：
//   context: {
//       ...previousContext,
//       systemPrompt: ...,
//       tools: this.agent.state.tools.slice(),
//   },
// 替换为在 tools 处内联刷新函数（刷新后重取 state.tools）。
const re =
  /(systemPrompt: this\._systemPromptOverride \?\? this\._baseSystemPrompt,)(\s*tools: this\.agent\.state\.tools\.slice\(\),)/

const m = src.match(re)
if (!m) {
  console.error('未匹配到 _installAgentNextTurnRefresh 原代码（pi 版本可能已改动），需人工核对。')
  process.exit(1)
}

const patched = src.replace(
  re,
  `$1

                    // ${MARKER}: 恢复会话工具 schema 刷新——state.tools 若缺当前注册
                    // 工具（重启后新注册的扩展工具如 plan_enter/plan_exit），调用
                    // _refreshToolRegistry 刷新（保留已有活动工具 + 纳入新注册工具），
                    // 并返回刷新后的 tools 供本轮注入（模型函数调用 schema 可见新工具）。
                    tools: (() => {
                        const _names = new Set(this.agent.state.tools.map((t) => t.name));
                        // 字段存在性守卫：pi 升级若改名 _toolDefinitions（正则仍可匹配
                        // 外层 tools: 注入点），此处返回 undefined 会抛 TypeError——
                        // 改由可空取值兜底，字段缺失时静默跳过刷新（补丁失效但不炸每轮 context）
                        const _defs = this._toolDefinitions?.keys?.();
                        const _all = _defs ? Array.from(_defs) : [];
                        if (_all.some((n) => !_names.has(n))) {
                            this._refreshToolRegistry({});
                        }
                        return this.agent.state.tools.slice();
                    })(),`,
)

writeFileSync(target, patched, 'utf-8')
console.log(`补丁已应用：${target}`)
console.log('提示：pi update 后需重跑本脚本（rebuild.sh 自动执行）。')
