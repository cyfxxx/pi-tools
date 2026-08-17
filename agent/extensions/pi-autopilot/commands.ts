import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { readSettings } from './config.ts'
import { writeRestartRequest } from './state.ts'
import {
  addTask, deleteTask, updateTask, listTasks, readTasks, parseIntervalToMs, formatInterval,
  previewCron, exportTasks, importTasks, setSettings,
} from './storage.ts'
import type { Task } from './types.ts'
import type { SessionScheduler } from './scheduler.ts'
import { readAutopilotConfig, writeAutopilotConfig } from './autoconfig.ts'
import { readTelemetry, statsByModel, statsByTask, todayRuns, todayCost } from './telemetry.ts'
import { planFailover, executeFailover } from './failover.ts'
import { currentModel } from './policy.ts'

// ── 通用工具函数（迁自 pi-scheduler） ──────────────────────────────
function taskStatus(t: Task): string {
  const status = t.enabled ? '✓' : '✗'
  const type = t.type.padEnd(8)
  const next = t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'
  const last = t.lastRun ? new Date(t.lastRun).toLocaleString('zh-CN') : '—'
  const result = t.lastResult ?? '—'
  const count = t.runCount
  const tags = t.tags.length > 0 ? ` #${t.tags.join('#')}` : ''
  return `${status} ${t.name.padEnd(20)} ${type} next:${next}  last:${last}(${result})×${count}${tags}  ${t.prompt.slice(0, 40)}`
}

interface ParsedFlags {
  prompt: string
  maxRunTime: number | undefined
  tags: string[] | undefined
  retries: number | undefined
}

function extractFlags(args: string): ParsedFlags {
  const out: ParsedFlags = { prompt: args, maxRunTime: undefined, tags: undefined, retries: undefined }
  let s = args
  const timeoutM = s.match(/--timeout\s+(\d+)/i)
  if (timeoutM) { out.maxRunTime = parseInt(timeoutM[1], 10); s = s.replace(/--timeout\s+\d+/i, '') }
  const tagsM = s.match(/--tags\s+([^\s]+)/i)
  if (tagsM) { out.tags = tagsM[1].split(',').map(x => x.trim()).filter(Boolean); s = s.replace(/--tags\s+[^\s]+/i, '') }
  const retriesM = s.match(/--retries\s+(\d+)/i)
  if (retriesM) { out.retries = parseInt(retriesM[1], 10); s = s.replace(/--retries\s+\d+/i, '') }
  out.prompt = s.replace(/\s+/g, ' ').trim()
  return out
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw)
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw) } catch { /* keep as string */ }
  }
  return raw
}

/** 命令输出统一经 ctx.sendMessage 展示（0.84 handler 不再返回 string）。 */
function reply(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: 'cmd-output', content: text, display: true })
}

export function registerCommands(pi: ExtensionAPI, scheduler: SessionScheduler): void {
  // ── /auto（整合 auto:status/policy/failover/pause/resume 与 admin:restart） ──
  const AUTO_USAGE = [
    '/auto status [--stats]   显示状态（--stats 附加按模型/按任务遥测统计）',
    '/auto policy             查看自主运行策略',
    '/auto policy set <路径> <值>  修改策略（enabled/maxIdleMinutes/requeueOnRestart/policy.*/budget.*/fallbackModels）',
    '/auto failover [--exec]  dry-run 测试 failover 目标（--exec 实际执行切换重启）',
    '/auto pause              全局暂停调度与自主运行动作',
    '/auto resume             恢复全局调度',
    '/auto restart            重启 Agent（需确认，自动恢复会话）',
    '/auto help               显示本帮助',
  ].join('\n')

  pi.registerCommand('auto', {
    description: '自主运行与定时调度（/auto help 查看用法）',
    getArgumentCompletions: (prefix) => {
      const first = (prefix.trim().split(/\s+/)[0] ?? '').toLowerCase()
      if (first === 'policy') {
        return [{ value: 'set', label: 'policy set', description: '修改策略（路径 值）' }]
      }
      if (first === 'failover') {
        return [{ value: '--exec', label: 'failover --exec', description: '实际执行切换重启' }]
      }
      if (first === 'status') {
        return [{ value: '--stats', label: 'status --stats', description: '附加按模型/按任务统计' }]
      }
      return [
        { value: 'status', label: 'status', description: '显示状态（--stats 附加统计）' },
        { value: 'policy', label: 'policy', description: '查看/修改自主运行策略' },
        { value: 'failover', label: 'failover', description: '测试 failover 目标' },
        { value: 'pause', label: 'pause', description: '全局暂停调度' },
        { value: 'resume', label: 'resume', description: '恢复全局调度' },
        { value: 'restart', label: 'restart', description: '重启 Agent' },
        { value: 'help', label: 'help', description: '显示用法' },
      ]
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')
      switch (sub) {
        case 'status': {
          const settings = readSettings()
          const config = await readAutopilotConfig()
          const tasks = await listTasks()
          const telemetry = await readTelemetry()
          const byModel = statsByModel(telemetry)
          const enabled = tasks.filter(t => t.enabled).length
          const lines = [
            '自主运行状态',
            `  模型: ${settings.defaultProvider || '?'}/${settings.defaultModel || '?'}`,
            `  自主运行: ${config.enabled ? '开启' : '关闭'} | 全局暂停: ${(await readTasks()).settings.paused ? '是' : '否'}`,
            `  定时任务: ${tasks.length}（启用 ${enabled}）`,
            `  遥测: ${telemetry.length} 条`,
          ]
          if (byModel.length) lines.push(`  最佳模型: ${byModel[0].provider}/${byModel[0].model} (${Math.round(byModel[0].successRate * 100)}%)`)
          lines.push(`  今日: ${todayRuns(telemetry)} 次 / $${todayCost(telemetry).toFixed(4)}`)
          lines.push(`  failover: ${config.fallbackModels.length ? config.fallbackModels.map(f => `${f.provider}/${f.model}`).join(' → ') : '(未配置)'}`)
          if (restArgs.includes('--stats')) {
            const byTask = statsByTask(telemetry)
            lines.push('', '按模型:')
            for (const m of byModel.slice(0, 10)) lines.push(`  ${m.provider}/${m.model}: ${Math.round(m.successRate * 100)}%, ${m.runs} 次, 平均 ${Math.round(m.avgDurationMs / 1000)}s, $${m.totalCost.toFixed(4)}`)
            lines.push('按任务:')
            for (const t of byTask.slice(0, 10)) lines.push(`  ${t.taskName}: ${Math.round(t.successRate * 100)}%, ${t.runs} 次, ${t.failures} 失败`)
          }
          reply(pi, lines.join('\n'))
          break
        }
        case 'policy': {
          const m = restArgs.match(/^set\s+(\S+)\s+([\s\S]+)$/)
          if (!m) {
            const config = await readAutopilotConfig()
            reply(pi, [
              '自主运行策略（修改: /auto policy set <路径> <值>）',
              `  enabled: ${config.enabled}`,
              `  fallbackModels: ${JSON.stringify(config.fallbackModels)}`,
              `  maxIdleMinutes: ${config.maxIdleMinutes}`,
              `  requeueOnRestart: ${config.requeueOnRestart}`,
              `  policy.failoverAfter: ${config.policy.failoverAfter}`,
              `  policy.suspendAfter: ${config.policy.suspendAfter}`,
              `  policy.timeoutFactor: ${config.policy.timeoutFactor}`,
              `  budget.maxRunsPerDay: ${config.budget.maxRunsPerDay}`,
              `  budget.maxCostPerDay: ${config.budget.maxCostPerDay}`,
              `  budget.allowedModels: ${JSON.stringify(config.budget.allowedModels || [])}`,
            ].join('\n'))
            break
          }
          const path = m[1]
          const value = parseValue(m[2].trim())
          // 审计 LOW：策略数值字段此前无类型校验——写字符串后 decide 中数值比较
          // NaN 恒 false → failoverAfter/suspendAfter 静默失效。数字字段拒绝非数字值。
          const numericPaths = new Set([
            'policy.failoverAfter', 'policy.suspendAfter', 'policy.timeoutFactor', 'policy.maxFailovers',
            'maxIdleMinutes', 'budget.maxRunsPerDay', 'budget.maxCostPerDay',
          ])
          if (numericPaths.has(path) && typeof value !== 'number') {
            reply(pi, `拒绝写入: ${path} 是数值字段，收到 ${JSON.stringify(value)}（如 /auto policy set ${path} 5）`)
            break
          }
          const config = await readAutopilotConfig()
          const setDeep = (obj: Record<string, unknown>, p: string, v: unknown): boolean => {
            const parts = p.split('.')
            let cur = obj
            for (let i = 0; i < parts.length - 1; i++) {
              if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
              cur = cur[parts[i]] as Record<string, unknown>
            }
            cur[parts[parts.length - 1]] = v
            return true
          }
          setDeep(config as unknown as Record<string, unknown>, path, value)
          await writeAutopilotConfig(config)
          reply(pi, `已更新策略: ${path} = ${JSON.stringify(value)}`)
          break
        }
        case 'failover': {
          const config = await readAutopilotConfig()
          const { provider, model } = currentModel()
          const plan = await planFailover(config.fallbackModels, provider, model)
          if (!plan.target) {
            reply(pi, `当前 ${provider}/${model}\nfail: ${plan.reason}`)
            break
          }
          if (restArgs.includes('--exec')) {
            reply(pi, await executeFailover(plan.target, plan.reason, false))
            break
          }
          reply(pi, `当前 ${provider}/${model}\nfail: ${plan.reason}\n（dry-run，使用 --exec 实际执行）`)
          break
        }
        case 'pause':
          await setSettings({ paused: true })
          reply(pi, '已全局暂停调度')
          break
        case 'resume':
          await setSettings({ paused: false })
          reply(pi, '已恢复调度')
          break
        case 'restart': {
          const reason = restArgs.trim() || '用户请求重启'
          const confirmed = await ctx.ui.confirm('重启 Agent', `确认重启？\n原因: ${reason}`)
          if (!confirmed) break
          ctx.ui.notify('正在重启...', 'info')
          writeRestartRequest('restart', { reason })
          try { ctx.shutdown() } catch { process.exit(0) }
          break
        }
        case 'help':
        case '-h':
        case '--help':
        case '':
          reply(pi, AUTO_USAGE)
          break
        default:
          reply(pi, `未知子命令: /auto ${sub}\n\n${AUTO_USAGE}`)
      }
    },
  })

  // ── /schedule（迁自 pi-scheduler；/loop /remind 已并入子命令） ────
  const SCHEDULE_USAGE = [
    '/schedule list [--tag <t>]           列出定时任务（可按标签过滤）',
    '/schedule loop <interval> <prompt>    创建循环任务并立即执行一次',
    '             [--timeout <秒>] [--tags a,b] [--retries <n>]',
    '/schedule remind <time> <prompt>      一次性提醒（+30m / 2026-07-15T09:00）',
    '/schedule cron "<expr>" <prompt>      创建 cron 定时任务',
    '             [--timeout <秒>] [--tags a,b] [--retries <n>]',
    '/schedule edit <id> [--schedule <expr>] [--timeout <秒>] [--retries <n>] [--prompt <text>]  修改任务',
    '/schedule delete <id|name>           删除任务',
    '/schedule enable <id|name>           启用任务',
    '/schedule disable <id|name>          禁用任务',
    '/schedule test "<expr>"               预览 cron 未来触发时间',
    '/schedule history <id|name>          任务执行历史',
    '/schedule export                     导出全部任务到文件',
    '/schedule import <文件路径>            从文件导入任务',
    '/schedule pause                      全局暂停调度',
    '/schedule resume                     恢复调度',
    '/schedule help                       显示本帮助',
  ].join('\n')

  pi.registerCommand('schedule', {
    description: '定时任务与提醒（/schedule help 查看用法）',
    getArgumentCompletions: (prefix) => {
      const first = (prefix.trim().split(/\s+/)[0] ?? '').toLowerCase()
      if (first === 'list' || first === 'ls') {
        return [{ value: '--tag', label: 'list --tag <标签>', description: '按标签过滤' }]
      }
      if (first === 'loop' || first === 'cron') {
        return [
          { value: '--timeout', label: '--timeout <秒>', description: '最大运行时长' },
          { value: '--tags', label: '--tags <a,b>', description: '标签列表' },
          { value: '--retries', label: '--retries <n>', description: '失败重试次数' },
        ]
      }
      if (first === 'edit') {
        return [
          { value: '--schedule', label: '--schedule <expr>', description: '修改调度表达式' },
          { value: '--timeout', label: '--timeout <秒>', description: '最大运行时长' },
          { value: '--retries', label: '--retries <n>', description: '失败重试次数' },
          { value: '--prompt', label: '--prompt <text>', description: '修改提示词' },
        ]
      }
      return [
        { value: 'list', label: 'list', description: '列出定时任务' },
        { value: 'loop', label: 'loop', description: '创建循环任务' },
        { value: 'remind', label: 'remind', description: '一次性提醒' },
        { value: 'cron', label: 'cron', description: '创建 cron 定时任务' },
        { value: 'edit', label: 'edit', description: '修改任务' },
        { value: 'delete', label: 'delete', description: '删除任务' },
        { value: 'enable', label: 'enable', description: '启用任务' },
        { value: 'disable', label: 'disable', description: '禁用任务' },
        { value: 'test', label: 'test', description: '预览 cron 触发时间' },
        { value: 'history', label: 'history', description: '任务执行历史' },
        { value: 'export', label: 'export', description: '导出全部任务' },
        { value: 'import', label: 'import', description: '从文件导入任务' },
        { value: 'pause', label: 'pause', description: '全局暂停调度' },
        { value: 'resume', label: 'resume', description: '恢复调度' },
        { value: 'help', label: 'help', description: '显示用法' },
      ]
    },
    handler: async (args: string, ctx): Promise<void> => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || 'list'

      if (subcmd === 'loop') {
        const { prompt: cleaned, maxRunTime, tags, retries } = extractFlags(parts.slice(1).join(' '))
        const m = cleaned.match(/^(\S+)\s+(.+)/s)
        if (!m) {
          reply(pi, '用法: /schedule loop <interval> <prompt> [--timeout <秒>] [--tags a,b] [--retries <n>]\n示例: /schedule loop 5m check CI status')
          return
        }
        const interval = m[1]
        const prompt = m[2]
        const ms = parseIntervalToMs(interval)
        if (!ms) {
          reply(pi, `无效间隔: ${interval}。支持格式: 30s, 5m, 1h, 2d`)
          return
        }
        const name = `loop-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'interval', schedule: interval, prompt, enabled: true, maxRunTime, tags, retries })
          await scheduler.runNow(task)
          reply(pi, `已创建循环任务 "${name}" 并立即执行一次: 每 ${formatInterval(ms)} 重复\n  ${prompt}\nID: ${task.id}\n下次执行: ${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '未知'}`)
        } catch (err) {
          reply(pi, `创建失败: ${(err as Error).message}`)
        }
      }

      if (subcmd === 'remind') {
        const m = parts.slice(1).join(' ').match(/^(\S+)\s+(.+)/s)
        if (!m) {
          reply(pi, '用法: /schedule remind <time> <prompt>\n示例: /schedule remind +30m review PR\n示例: /schedule remind 2026-07-15T09:00 standup')
          return
        }
        const time = m[1]
        const prompt = m[2]
        const isAbsolute = /^\d{4}-\d{2}-\d{2}/.test(time)
        const schedule = time.startsWith('+') ? time : isAbsolute ? time : `+${time}`
        const name = `remind-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'once', schedule, prompt, enabled: true })
          const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效时间'
          reply(pi, `已创建提醒 "${name}": ${next}\n  ${prompt}\nID: ${task.id}\n（执行后自动移除）`)
        } catch (err) {
          reply(pi, `创建失败: ${(err as Error).message}`)
        }
      }

      if (subcmd === 'list' || subcmd === 'ls') {
        const tasks = await listTasks()
        const tagIdx = parts.indexOf('--tag')
        const tag = tagIdx !== -1 ? parts[tagIdx + 1] : undefined
        const filtered = tag ? tasks.filter(t => t.tags.includes(tag)) : tasks
        if (filtered.length === 0) {
          reply(pi, tag ? `没有标签为 #${tag} 的任务` : '暂无定时任务')
          return
        }
        reply(pi, `定时任务 (${filtered.length}${tag ? `, 标签 #${tag}` : ''}):\n${filtered.map((t, i) => `  ${i + 1}. ${taskStatus(t)}`).join('\n')}`)
        return
      }

      if (subcmd === 'delete' || subcmd === 'rm') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) {
          reply(pi, '用法: /schedule delete <id|name>')
          return
        }
        const ok = await deleteTask(idOrName)
        reply(pi, ok ? `已删除任务: ${idOrName}` : `未找到任务: ${idOrName}`)
        return
      }

      if (subcmd === 'enable') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) {
          reply(pi, '用法: /schedule enable <id|name>')
          return
        }
        // re-enable 时同时清零熔断/失败计数（audit 补充）：否则 suspend 恢复后
        // 一次失败即再次熔断（failoverCount 在 message 路径永不自动重置）
        const t = await updateTask(idOrName, { enabled: true, failoverCount: 0, failCount: 0 })
        reply(pi, t ? `已启用任务: ${t.name}` : `未找到任务: ${idOrName}`)
        return
      }

      if (subcmd === 'disable') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) {
          reply(pi, '用法: /schedule disable <id|name>')
          return
        }
        const t = await updateTask(idOrName, { enabled: false })
        reply(pi, t ? `已禁用任务: ${t.name}` : `未找到任务: ${idOrName}`)
        return
      }

      if (subcmd === 'edit') {
        const idOrName = parts.slice(1).find(p => !p.startsWith('--')) || ''
        if (!idOrName) {
          reply(pi, '用法: /schedule edit <id|name> [--schedule <expr>] [--timeout <秒>] [--retries <n>] [--prompt <text>]')
          return
        }
        const rest = args.trim().replace(new RegExp(`^edit\\s+${idOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').trim()
        const scheduleM = rest.match(/--schedule\s+(\S+)/i)
        const timeoutM = rest.match(/--timeout\s+(\d+)/i)
        const retriesM = rest.match(/--retries\s+(\d+)/i)
        const promptM = rest.match(/--prompt\s+([\s\S]+)/i)
        if (!scheduleM && !timeoutM && !retriesM && !promptM) {
          reply(pi, '未指定任何修改项。可用: --schedule <expr> --timeout <秒> --retries <n> --prompt <text>')
          return
        }
        const updates: Parameters<typeof updateTask>[1] = {}
        if (scheduleM) updates.schedule = scheduleM[1]
        if (timeoutM) updates.maxRunTime = parseInt(timeoutM[1], 10)
        if (retriesM) updates.retries = parseInt(retriesM[1], 10)
        if (promptM) updates.prompt = promptM[1].replace(/\s+$/g, '')
        try {
          const t = await updateTask(idOrName, updates)
          if (!t) {
            reply(pi, `未找到任务: ${idOrName}`)
            return
          }
          reply(pi, `已更新任务: ${t.name}\n  调度: ${t.schedule}  超时: ${t.maxRunTime}s  重试: ${t.retries}\n  下次执行: ${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'}\n  prompt: ${t.prompt.slice(0, 80)}`)
        } catch (err) {
          reply(pi, `更新失败: ${(err as Error).message}`)
        }
      }

      if (subcmd === 'cron') {
        const { prompt: cleaned, maxRunTime, tags, retries } = extractFlags(args)
        const m = cleaned.match(/^cron\s+"([^"]+)"\s+(.+)/s) || cleaned.match(/^cron\s+'([^']+)'\s+(.+)/s)
        if (!m) {
          reply(pi, '用法: /schedule cron "<expr>" <prompt> [--timeout <秒>] [--tags a,b] [--retries <n>]\n示例: /schedule cron "0 9 * * 1-5" daily standup')
          return
        }
        const name = `cron-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'cron', schedule: m[1], prompt: m[2], enabled: true, maxRunTime, tags, retries })
          reply(pi, `已创建定时任务 "${name}": ${m[1]}\n  下次执行: ${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效表达式'}\n  ${m[2]}\nID: ${task.id}`)
        } catch (err) {
          reply(pi, `创建失败: ${(err as Error).message}`)
        }
      }

      if (subcmd === 'test') {
        const expr = parts.slice(1).join(' ')
        if (!expr) {
          reply(pi, '用法: /schedule test "<expr>"\n示例: /schedule test "0 9 * * 1-5"')
          return
        }
        try {
          const times = await previewCron(expr)
          reply(pi, `未来 ${times.length} 次触发时间:\n${times.map(t => `  ${new Date(t).toLocaleString('zh-CN')}`).join('\n')}`)
        } catch (err) {
          reply(pi, (err as Error).message)
        }
      }

      if (subcmd === 'history') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) {
          reply(pi, '用法: /schedule history <id|name>')
          return
        }
        const tasks = await listTasks()
        const t = tasks.find(x => x.id === idOrName || x.name === idOrName)
        if (!t) {
          reply(pi, `未找到任务: ${idOrName}`)
          return
        }
        if (t.history.length === 0) {
          reply(pi, `任务 "${t.name}" 暂无执行历史`)
          return
        }
        const lines = t.history.map((h, i) => {
          const icon = h.result === 'success' ? '✓' : '✗'
          const dur = typeof h.durationMs === 'number' ? ` ${(h.durationMs / 1000).toFixed(1)}s` : ''
          return `  ${i + 1}. ${icon} ${h.time}${dur}\n     ${h.output.replace(/\n/g, '\n     ').slice(0, 200)}`
        })
        reply(pi, `任务 "${t.name}" 执行历史 (${t.history.length}):\n${lines.join('\n')}`)
        return
      }

      if (subcmd === 'export') {
        try {
          const tasks = await listTasks()
          const path = await exportTasks()
          reply(pi, `已导出 ${tasks.length} 个任务到: ${path}`)
        } catch (err) {
          reply(pi, `导出失败: ${(err as Error).message}`)
        }
        return
      }

      if (subcmd === 'import') {
        const file = parts.slice(1).join(' ').trim()
        if (!file) {
          reply(pi, '用法: /schedule import <文件路径>')
          return
        }
        try {
          const { imported, skipped } = await importTasks(file)
          reply(pi, `导入完成: 新增 ${imported} 个任务` + (skipped.length > 0 ? `，跳过 ${skipped.length} 个（${skipped.join(', ')}）` : ''))
        } catch (err) {
          reply(pi, `导入失败: ${(err as Error).message}`)
        }
        return
      }

      if (subcmd === 'pause') {
        await setSettings({ paused: true })
        reply(pi, '已全局暂停调度（在线与离线均跳过执行）')
        return
      }

      if (subcmd === 'resume') {
        await setSettings({ paused: false })
        reply(pi, '已恢复调度')
        return
      }

      if (subcmd === 'help' || subcmd === '-h' || subcmd === '--help') {
        reply(pi, SCHEDULE_USAGE)
        return
      }

      reply(pi, `未知子命令: /schedule ${subcmd}\n\n${SCHEDULE_USAGE}`)
    },
  })
}