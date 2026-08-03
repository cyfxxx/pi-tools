import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
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

export function registerCommands(pi: ExtensionAPI, scheduler: SessionScheduler): void {
  // ── /auto:status ─────────────────────────────────────────────────
  pi.registerCommand('auto:status', {
    description: '显示自主运行状态：模型、会话、任务、遥测、预算、failover 链。--stats 附加遥测统计（按模型/按任务）。',
    usage: '/auto:status [--stats]',
    handler: async (args: string) => {
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
      if (args.trim().includes('--stats')) {
        const byTask = statsByTask(telemetry)
        lines.push('', '按模型:')
        for (const m of byModel.slice(0, 10)) lines.push(`  ${m.provider}/${m.model}: ${Math.round(m.successRate * 100)}%, ${m.runs} 次, 平均 ${Math.round(m.avgDurationMs / 1000)}s, $${m.totalCost.toFixed(4)}`)
        lines.push('按任务:')
        for (const t of byTask.slice(0, 10)) lines.push(`  ${t.taskName}: ${Math.round(t.successRate * 100)}%, ${t.runs} 次, ${t.failures} 失败`)
      }
      return lines.join('\n')
    },
  })

  // ── /auto:policy ─────────────────────────────────────────────────
  pi.registerCommand('auto:policy', {
    description: '查看或修改自主运行策略。只读: /auto:policy；修改: /auto:policy set <路径> <值>。路径支持 enabled / maxIdleMinutes / requeueOnRestart / policy.failoverAfter / policy.suspendAfter / policy.timeoutFactor / budget.maxRunsPerDay / budget.maxCostPerDay / budget.allowedModels / fallbackModels（JSON 数组）。',
    usage: '/auto:policy [set <path> <value>]',
    handler: async (args: string) => {
      const m = args.trim().match(/^set\s+(\S+)\s+([\s\S]+)$/)
      if (!m) {
        const config = await readAutopilotConfig()
        return [
          '自主运行策略（修改: /auto:policy set <路径> <值>）',
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
        ].join('\n')
      }
      const path = m[1]
      const value = parseValue(m[2].trim())
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
      return `已更新策略: ${path} = ${JSON.stringify(value)}`
    },
  })

  // ── /auto:failover ───────────────────────────────────────────────
  pi.registerCommand('auto:failover', {
    description: 'dry-run 测试 failover 目标选择。可选参数 --exec 实际执行切换重启。',
    usage: '/auto:failover [--exec]',
    handler: async (args: string) => {
      const config = await readAutopilotConfig()
      const { provider, model } = currentModel()
      const plan = await planFailover(config.fallbackModels, provider, model)
      if (!plan.target) return `当前 ${provider}/${model}\nfailover: ${plan.reason}`
      if (args.trim().includes('--exec')) {
        const msg = await executeFailover(plan.target, plan.reason, false)
        return msg
      }
      return `当前 ${provider}/${model}\nfailover: ${plan.reason}\n（dry-run，使用 --exec 实际执行）`
    },
  })

  // ── /auto:pause /auto:resume ─────────────────────────────────────
  pi.registerCommand('auto:pause', {
    description: '全局暂停调度与自主运行动作（保留现有任务与状态）。',
    usage: '/auto:pause',
    handler: async () => {
      await setSettings({ paused: true })
      return '已全局暂停调度'
    },
  })

  pi.registerCommand('auto:resume', {
    description: '恢复全局调度。',
    usage: '/auto:resume',
    handler: async () => {
      await setSettings({ paused: false })
      return '已恢复调度'
    },
  })

  // ── /admin:restart（保留：需用户确认的重启） ──────────────────────
  pi.registerCommand('admin:restart', {
    description: '重启 Agent。自动保存当前会话，重启后恢复。',
    usage: '/admin:restart [reason]',
    handler: async (args, ctx) => {
      const reason = args.trim() || '用户请求重启'
      const confirmed = await ctx.ui.confirm('重启 Agent', `确认重启？\n原因: ${reason}`)
      if (!confirmed) return
      ctx.ui.notify('正在重启...', 'info')
      writeRestartRequest('restart', { reason })
      try { ctx.shutdown() } catch { process.exit(0) }
    },
  })

  // ── /schedule（迁自 pi-scheduler；/loop /remind 已并入子命令） ────
  pi.registerCommand('schedule', {
    description: '管理定时任务，并支持 loop/remind 子命令创建循环任务与提醒。',
    usage: '/schedule [list|edit|delete|enable|disable|cron|test|history|export|import|pause|resume|loop|remind] [args...]',
    handler: async (args: string) => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || 'list'

      if (subcmd === 'loop') {
        const { prompt: cleaned, maxRunTime, tags, retries } = extractFlags(parts.slice(1).join(' '))
        const m = cleaned.match(/^(\S+)\s+(.+)/s)
        if (!m) return '用法: /schedule loop <interval> <prompt> [--timeout <秒>] [--tags a,b] [--retries <n>]\n示例: /schedule loop 5m check CI status'
        const interval = m[1]
        const prompt = m[2]
        const ms = parseIntervalToMs(interval)
        if (!ms) return `无效间隔: ${interval}。支持格式: 30s, 5m, 1h, 2d`
        const name = `loop-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'interval', schedule: interval, prompt, enabled: true, maxRunTime, tags, retries })
          await scheduler.runNow(task)
          return `已创建循环任务 "${name}" 并立即执行一次: 每 ${formatInterval(ms)} 重复\n  ${prompt}\nID: ${task.id}\n下次执行: ${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '未知'}`
        } catch (err) {
          return `创建失败: ${(err as Error).message}`
        }
      }

      if (subcmd === 'remind') {
        const m = parts.slice(1).join(' ').match(/^(\S+)\s+(.+)/s)
        if (!m) return '用法: /schedule remind <time> <prompt>\n示例: /schedule remind +30m review PR\n示例: /schedule remind 2026-07-15T09:00 standup'
        const time = m[1]
        const prompt = m[2]
        const isAbsolute = /^\d{4}-\d{2}-\d{2}/.test(time)
        const schedule = time.startsWith('+') ? time : isAbsolute ? time : `+${time}`
        const name = `remind-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'once', schedule, prompt, enabled: true })
          const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效时间'
          return `已创建提醒 "${name}": ${next}\n  ${prompt}\nID: ${task.id}\n（执行后自动移除）`
        } catch (err) {
          return `创建失败: ${(err as Error).message}`
        }
      }

      if (subcmd === 'list' || subcmd === 'ls') {
        const tasks = await listTasks()
        const tagIdx = parts.indexOf('--tag')
        const tag = tagIdx !== -1 ? parts[tagIdx + 1] : undefined
        const filtered = tag ? tasks.filter(t => t.tags.includes(tag)) : tasks
        if (filtered.length === 0) return tag ? `没有标签为 #${tag} 的任务` : '暂无定时任务'
        return `定时任务 (${filtered.length}${tag ? `, 标签 #${tag}` : ''}):\n${filtered.map((t, i) => `  ${i + 1}. ${taskStatus(t)}`).join('\n')}`
      }

      if (subcmd === 'delete' || subcmd === 'rm') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) return '用法: /schedule delete <id|name>'
        const ok = await deleteTask(idOrName)
        return ok ? `已删除任务: ${idOrName}` : `未找到任务: ${idOrName}`
      }

      if (subcmd === 'enable') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) return '用法: /schedule enable <id|name>'
        const t = await updateTask(idOrName, { enabled: true })
        return t ? `已启用任务: ${t.name}` : `未找到任务: ${idOrName}`
      }

      if (subcmd === 'disable') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) return '用法: /schedule disable <id|name>'
        const t = await updateTask(idOrName, { enabled: false })
        return t ? `已禁用任务: ${t.name}` : `未找到任务: ${idOrName}`
      }

      if (subcmd === 'edit') {
        const idOrName = parts.slice(1).find(p => !p.startsWith('--')) || ''
        if (!idOrName) return '用法: /schedule edit <id|name> [--schedule <expr>] [--timeout <秒>] [--retries <n>] [--prompt <text>]'
        const rest = args.trim().replace(new RegExp(`^edit\\s+${idOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').trim()
        const scheduleM = rest.match(/--schedule\s+(\S+)/i)
        const timeoutM = rest.match(/--timeout\s+(\d+)/i)
        const retriesM = rest.match(/--retries\s+(\d+)/i)
        const promptM = rest.match(/--prompt\s+([\s\S]+)/i)
        if (!scheduleM && !timeoutM && !retriesM && !promptM) return '未指定任何修改项。可用: --schedule <expr> --timeout <秒> --retries <n> --prompt <text>'
        const updates: Parameters<typeof updateTask>[1] = {}
        if (scheduleM) updates.schedule = scheduleM[1]
        if (timeoutM) updates.maxRunTime = parseInt(timeoutM[1], 10)
        if (retriesM) updates.retries = parseInt(retriesM[1], 10)
        if (promptM) updates.prompt = promptM[1].replace(/\s+$/g, '')
        try {
          const t = await updateTask(idOrName, updates)
          if (!t) return `未找到任务: ${idOrName}`
          return `已更新任务: ${t.name}\n  调度: ${t.schedule}  超时: ${t.maxRunTime}s  重试: ${t.retries}\n  下次执行: ${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'}\n  prompt: ${t.prompt.slice(0, 80)}`
        } catch (err) {
          return `更新失败: ${(err as Error).message}`
        }
      }

      if (subcmd === 'cron') {
        const { prompt: cleaned, maxRunTime, tags, retries } = extractFlags(args)
        const m = cleaned.match(/^cron\s+"([^"]+)"\s+(.+)/s) || cleaned.match(/^cron\s+'([^']+)'\s+(.+)/s)
        if (!m) return '用法: /schedule cron "<expr>" <prompt> [--timeout <秒>] [--tags a,b] [--retries <n>]\n示例: /schedule cron "0 9 * * 1-5" daily standup'
        const name = `cron-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'cron', schedule: m[1], prompt: m[2], enabled: true, maxRunTime, tags, retries })
          return `已创建定时任务 "${name}": ${m[1]}\n  下次执行: ${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效表达式'}\n  ${m[2]}\nID: ${task.id}`
        } catch (err) {
          return `创建失败: ${(err as Error).message}`
        }
      }

      if (subcmd === 'test') {
        const expr = parts.slice(1).join(' ')
        if (!expr) return '用法: /schedule test "<expr>"\n示例: /schedule test "0 9 * * 1-5"'
        try {
          const times = await previewCron(expr)
          return `未来 ${times.length} 次触发时间:\n${times.map(t => `  ${new Date(t).toLocaleString('zh-CN')}`).join('\n')}`
        } catch (err) {
          return (err as Error).message
        }
      }

      if (subcmd === 'history') {
        const idOrName = parts.slice(1).join(' ')
        if (!idOrName) return '用法: /schedule history <id|name>'
        const tasks = await listTasks()
        const t = tasks.find(x => x.id === idOrName || x.name === idOrName)
        if (!t) return `未找到任务: ${idOrName}`
        if (t.history.length === 0) return `任务 "${t.name}" 暂无执行历史`
        const lines = t.history.map((h, i) => {
          const icon = h.result === 'success' ? '✓' : '✗'
          const dur = typeof h.durationMs === 'number' ? ` ${(h.durationMs / 1000).toFixed(1)}s` : ''
          return `  ${i + 1}. ${icon} ${h.time}${dur}\n     ${h.output.replace(/\n/g, '\n     ').slice(0, 200)}`
        })
        return `任务 "${t.name}" 执行历史 (${t.history.length}):\n${lines.join('\n')}`
      }

      if (subcmd === 'export') {
        try {
          const tasks = await listTasks()
          const path = await exportTasks()
          return `已导出 ${tasks.length} 个任务到: ${path}`
        } catch (err) {
          return `导出失败: ${(err as Error).message}`
        }
      }

      if (subcmd === 'import') {
        const file = parts.slice(1).join(' ').trim()
        if (!file) return '用法: /schedule import <文件路径>'
        try {
          const { imported, skipped } = await importTasks(file)
          return `导入完成: 新增 ${imported} 个任务` + (skipped.length > 0 ? `，跳过 ${skipped.length} 个（${skipped.join(', ')}）` : '')
        } catch (err) {
          return `导入失败: ${(err as Error).message}`
        }
      }

      if (subcmd === 'pause') {
        await setSettings({ paused: true })
        return '已全局暂停调度（在线与离线均跳过执行）'
      }

      if (subcmd === 'resume') {
        await setSettings({ paused: false })
        return '已恢复调度'
      }

      return `未知子命令: ${subcmd}\n可用: list [--tag <t>], edit <id>, delete <id>, enable <id>, disable <id>, cron "<expr>" <prompt>, test "<expr>", history <id>, export, import <file>, pause, resume`
    },
  })
}
