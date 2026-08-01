import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  addTask, deleteTask, updateTask, listTasks, parseIntervalToMs, formatInterval,
  previewCron, exportTasks, importTasks, setSettings,
} from './storage.ts'
import type { Task } from './types.ts'
import type { SessionScheduler } from './scheduler.ts'

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
  if (timeoutM) {
    out.maxRunTime = parseInt(timeoutM[1], 10)
    s = s.replace(/--timeout\s+\d+/i, '')
  }
  const tagsM = s.match(/--tags\s+([^\s]+)/i)
  if (tagsM) {
    out.tags = tagsM[1].split(',').map(x => x.trim()).filter(Boolean)
    s = s.replace(/--tags\s+[^\s]+/i, '')
  }
  const retriesM = s.match(/--retries\s+(\d+)/i)
  if (retriesM) {
    out.retries = parseInt(retriesM[1], 10)
    s = s.replace(/--retries\s+\d+/i, '')
  }
  out.prompt = s.replace(/\s+/g, ' ').trim()
  return out
}

export function registerCommands(pi: ExtensionAPI, scheduler: SessionScheduler): void {
  pi.registerCommand('loop', {
    description: '创建间隔循环任务并立即执行一次',
    usage: '/loop <interval> <prompt...> [--timeout <秒>] [--tags a,b] [--retries <n>]',
    handler: async (args: string) => {
      const { prompt: cleaned, maxRunTime, tags, retries } = extractFlags(args)
      const m = cleaned.match(/^(\S+)\s+(.+)/s)
      if (!m) return '用法: /loop <interval> <prompt> [--timeout <秒>] [--tags a,b] [--retries <n>]\n示例: /loop 5m check CI status'
      const interval = m[1]
      const prompt = m[2]
      const ms = parseIntervalToMs(interval)
      if (!ms) return `无效间隔: ${interval}。支持格式: 30s, 5m, 1h, 2d`
      const name = `loop-${Date.now().toString(36)}`
      try {
        const task = await addTask({
          name,
          type: 'interval',
          schedule: interval,
          prompt,
          enabled: true,
          maxRunTime,
          tags,
          retries,
        })
        await scheduler.runNow(task)
        return `已创建循环任务 "${name}" 并立即执行一次: 每 ${formatInterval(ms)} 重复\n  ${prompt}\nID: ${task.id}\n下次执行: ${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '未知'}`
      } catch (err) {
        return `创建失败: ${(err as Error).message}`
      }
    },
  })

  pi.registerCommand('remind', {
    description: '创建一次性提醒任务（执行后自动移除）',
    usage: '/remind <time> <prompt...>',
    handler: async (args: string) => {
      const m = args.match(/^(\S+)\s+(.+)/s)
      if (!m) return '用法: /remind <time> <prompt>\n示例: /remind +30m review PR\n示例: /remind 2026-07-15T09:00 standup'
      const time = m[1]
      const prompt = m[2]
      const name = `remind-${Date.now().toString(36)}`
      try {
        const task = await addTask({
          name,
          type: 'once',
          schedule: time.startsWith('+') ? time : (time.includes('T') ? time : `+${time}`),
          prompt,
          enabled: true,
        })
        const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效时间'
        return `已创建提醒 "${name}": ${next}\n  ${prompt}\nID: ${task.id}\n（执行后自动移除）`
      } catch (err) {
        return `创建失败: ${(err as Error).message}`
      }
    },
  })

  pi.registerCommand('schedule', {
    description: '管理定时任务',
    usage: '/schedule [list|edit|delete|enable|disable|cron|test|history|export|import|pause|resume] [args...]',
    handler: async (args: string) => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || 'list'

      if (subcmd === 'list' || subcmd === 'ls') {
        const tasks = await listTasks()
        const tagIdx = parts.indexOf('--tag')
        const tag = tagIdx !== -1 ? parts[tagIdx + 1] : undefined
        const filtered = tag ? tasks.filter(t => t.tags.includes(tag)) : tasks
        if (filtered.length === 0) return tag ? `没有标签为 #${tag} 的任务` : '暂无定时任务'
        const lines = filtered.map((t, i) => `  ${i + 1}. ${taskStatus(t)}`)
        return `定时任务 (${filtered.length}${tag ? `, 标签 #${tag}` : ''}):\n${lines.join('\n')}`
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
        if (!scheduleM && !timeoutM && !retriesM && !promptM) {
          return '未指定任何修改项。可用: --schedule <expr> --timeout <秒> --retries <n> --prompt <text>'
        }
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
        const expr = m[1]
        const prompt = m[2]
        const name = `cron-${Date.now().toString(36)}`
        try {
          const task = await addTask({ name, type: 'cron', schedule: expr, prompt, enabled: true, maxRunTime, tags, retries })
          const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '无效表达式'
          return `已创建定时任务 "${name}": ${expr}\n  下次执行: ${next}\n  ${prompt}\nID: ${task.id}`
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
