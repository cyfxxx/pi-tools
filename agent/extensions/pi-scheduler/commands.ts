import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { addTask, deleteTask, updateTask, listTasks, parseIntervalToMs, formatInterval, parseRelativeTime, computeNextRun, isoNow } from './storage.ts'
import type { Task } from './types.ts'

function taskStatus(t: Task): string {
  const status = t.enabled ? '✓' : '✗'
  const type = t.type.padEnd(8)
  const next = t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'
  const last = t.lastRun ? new Date(t.lastRun).toLocaleString('zh-CN') : '—'
  const result = t.lastResult ?? '—'
  const count = t.runCount
  return `${status} ${t.name.padEnd(20)} ${type} next:${next}  last:${last}(${result})×${count}  ${t.prompt.slice(0, 40)}`
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('loop', {
    description: '创建间隔循环任务并立即执行一次',
    usage: '/loop <interval> <prompt...>',
    handler: async (args: string) => {
      const m = args.match(/^(\S+)\s+(.+)/s)
      if (!m) return '用法: /loop <interval> <prompt>\n示例: /loop 5m check CI status'
      const interval = m[1]
      const prompt = m[2]
      const ms = parseIntervalToMs(interval)
      if (!ms) return `无效间隔: ${interval}。支持格式: 30s, 5m, 1h, 2d`
      const name = `loop-${Date.now().toString(36)}`
      const task = await addTask({
        name,
        type: 'interval',
        schedule: interval,
        prompt,
        enabled: true,
      })
      return `已创建循环任务 "${name}": ${formatInterval(ms)} 执行一次\n  ${prompt}\nID: ${task.id}\n下次执行: ${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '未知'}`
    },
  })

  pi.registerCommand('remind', {
    description: '创建一次性提醒任务',
    usage: '/remind <time> <prompt...>',
    handler: async (args: string) => {
      const m = args.match(/^(\S+)\s+(.+)/s)
      if (!m) return '用法: /remind <time> <prompt>\n示例: /remind +30m review PR\n示例: /remind 2026-07-15T09:00 standup'
      const time = m[1]
      const prompt = m[2]
      const name = `remind-${Date.now().toString(36)}`
      const task = await addTask({
        name,
        type: 'once',
        schedule: time.startsWith('+') ? time : (time.includes('T') ? time : `+${time}`),
        prompt,
        enabled: true,
      })
      const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效时间'
      return `已创建提醒 "${name}": ${next}\n  ${prompt}\nID: ${task.id}`
    },
  })

  pi.registerCommand('schedule', {
    description: '管理定时任务',
    usage: '/schedule [list|delete|enable|disable|cron] [args...]',
    handler: async (args: string) => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || 'list'

      if (subcmd === 'list' || subcmd === 'ls') {
        const tasks = await listTasks()
        if (tasks.length === 0) return '暂无定时任务'
        const lines = tasks.map((t, i) => `  ${i + 1}. ${taskStatus(t)}`)
        return `定时任务 (${tasks.length}):\n${lines.join('\n')}`
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

      if (subcmd === 'cron') {
        const m = args.match(/^cron\s+"([^"]+)"\s+(.+)/s) || args.match(/^cron\s+'([^']+)'\s+(.+)/s)
        if (!m) return '用法: /schedule cron "<expr>" <prompt>\n示例: /schedule cron "0 9 * * 1-5" daily standup'
        const expr = m[1]
        const prompt = m[2]
        const name = `cron-${Date.now().toString(36)}`
        const task = await addTask({ name, type: 'cron', schedule: expr, prompt, enabled: true })
        const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效表达式'
        return `已创建定时任务 "${name}": ${expr}\n  下次执行: ${next}\n  ${prompt}\nID: ${task.id}`
      }

      return `未知子命令: ${subcmd}\n可用: list, delete <id>, enable <id>, disable <id>, cron "<expr>" <prompt>`
    },
  })
}
