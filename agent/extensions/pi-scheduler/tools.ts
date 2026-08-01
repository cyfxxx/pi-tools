import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { addTask, deleteTask, listTasks, updateTask, setSettings } from './storage.ts'

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'schedule_task',
    label: '管理定时任务',
    description: `创建、列出、更新、删除、启用或禁用定时任务。
支持的任务类型:
- interval: 按间隔重复（例如 "5m", "1h", "30s"）
- cron: 按 cron 表达式执行（5字段 POSIX，例如 "0 9 * * 1-5" 表示工作日9点）
- once: 一次性任务（相对时间 "+30m" 或 ISO 时间戳），执行后自动移除

创建任务后，任务会在 Pi 会话活跃时自动触发。
Pi 关闭时，系统 cron 会接管执行。
prompt 支持模板变量: {{date}} {{time}} {{datetime}} {{cwd}}。
失败重试: retries 指定失败后的额外尝试次数（每次间隔 60s）。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'update', 'delete', 'enable', 'disable', 'pause', 'resume'],
          description: '操作类型',
        },
        name: {
          type: 'string',
          description: '任务名称（add 必需，delete/enable/disable/update 可用作标识）',
        },
        type: {
          type: 'string',
          enum: ['interval', 'cron', 'once'],
          description: '任务类型（action=add 时必需）',
        },
        schedule: {
          type: 'string',
          description: '调度表达式（action=add 必需；update 时可修改）',
        },
        prompt: {
          type: 'string',
          description: '要执行的提示词（action=add 必需；update 时可修改）',
        },
        useSubagent: {
          type: 'boolean',
          description: '是否在子代理中执行（不打断当前会话）',
        },
        notifyOnCompletion: {
          type: 'boolean',
          description: '执行完成时是否发送 webhook 通知（需配置 webhookUrl）',
        },
        maxRunTime: {
          type: 'number',
          description: '执行超时秒数（默认 300），仅 useSubagent=true 时生效',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '任务标签（可选，用于 list 过滤）',
        },
        retries: {
          type: 'number',
          description: '失败后的额外重试次数（每次间隔 60s，默认 0）',
        },
        taskId: {
          type: 'string',
          description: '任务 ID（用于 update/delete/enable/disable）',
        },
      },
      required: ['action'],
    },
    execute: async (_toolCallId, params) => {
      const action = params.action as string

      if (action === 'add') {
        if (!params.name || !params.type || !params.schedule || !params.prompt) {
          return { content: [{ type: 'text', text: '缺少参数: name, type, schedule, prompt 为必需' }] }
        }
        try {
          const task = await addTask({
            name: params.name as string,
            type: params.type as 'interval' | 'cron' | 'once',
            schedule: params.schedule as string,
            prompt: params.prompt as string,
            useSubagent: params.useSubagent as boolean | undefined,
            notifyOnCompletion: params.notifyOnCompletion as boolean | undefined,
            maxRunTime: params.maxRunTime as number | undefined,
            tags: params.tags as string[] | undefined,
            retries: params.retries as number | undefined,
          })
          return {
            content: [{
              type: 'text',
              text: `已创建任务: ${task.name}\nID: ${task.id}\n类型: ${task.type}\n调度: ${task.schedule}\n下次执行: ${task.nextRun || '无法计算'}\n标签: ${task.tags.join(', ') || '无'}\n重试: ${task.retries}`,
            }],
          }
        } catch (err) {
          return { content: [{ type: 'text', text: `创建失败: ${(err as Error).message}` }] }
        }
      }

      if (action === 'list') {
        const tasks = await listTasks()
        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: '暂无定时任务' }] }
        }
        const lines = tasks.map(t =>
          `${t.enabled ? '✓' : '✗'} ${t.name} (${t.type}) ${t.schedule}${t.tags.length > 0 ? ` #${t.tags.join('#')}` : ''}\n  next: ${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'} last: ${t.lastRun ? new Date(t.lastRun).toLocaleString('zh-CN') : '—'} (${t.lastResult || '—'})×${t.runCount} 重试: ${t.retries}\n  prompt: ${t.prompt.slice(0, 60)}`
        )
        return { content: [{ type: 'text', text: `定时任务 (${tasks.length}):\n${lines.join('\n')}` }] }
      }

      if (action === 'pause') {
        await setSettings({ paused: true })
        return { content: [{ type: 'text', text: '已全局暂停调度' }] }
      }

      if (action === 'resume') {
        await setSettings({ paused: false })
        return { content: [{ type: 'text', text: '已恢复调度' }] }
      }

      const idOrName = (params.taskId || params.name) as string | undefined
      if (!idOrName) {
        return { content: [{ type: 'text', text: '缺少参数: taskId 或 name' }] }
      }

      if (action === 'delete') {
        const ok = await deleteTask(idOrName)
        return { content: [{ type: 'text', text: ok ? `已删除任务: ${idOrName}` : `未找到任务: ${idOrName}` }] }
      }

      if (action === 'enable') {
        const t = await updateTask(idOrName, { enabled: true })
        return { content: [{ type: 'text', text: t ? `已启用任务: ${t.name}` : `未找到任务: ${idOrName}` }] }
      }

      if (action === 'disable') {
        const t = await updateTask(idOrName, { enabled: false })
        return { content: [{ type: 'text', text: t ? `已禁用任务: ${t.name}` : `未找到任务: ${idOrName}` }] }
      }

      if (action === 'update') {
        const updates: Parameters<typeof updateTask>[1] = {}
        if (params.schedule !== undefined) updates.schedule = params.schedule as string
        if (params.prompt !== undefined) updates.prompt = params.prompt as string
        if (params.useSubagent !== undefined) updates.useSubagent = params.useSubagent as boolean
        if (params.notifyOnCompletion !== undefined) updates.notifyOnCompletion = params.notifyOnCompletion as boolean
        if (params.maxRunTime !== undefined) updates.maxRunTime = params.maxRunTime as number
        if (params.retries !== undefined) updates.retries = params.retries as number
        if (params.tags !== undefined) updates.tags = params.tags as string[]
        if (Object.keys(updates).length === 0) {
          return { content: [{ type: 'text', text: '未指定修改项: schedule / prompt / useSubagent / notifyOnCompletion / maxRunTime / retries / tags' }] }
        }
        try {
          const t = await updateTask(idOrName, updates)
          if (!t) return { content: [{ type: 'text', text: `未找到任务: ${idOrName}` }] }
          return { content: [{ type: 'text', text: `已更新任务: ${t.name}\n调度: ${t.schedule}\n下次执行: ${t.nextRun || '—'}` }] }
        } catch (err) {
          return { content: [{ type: 'text', text: `更新失败: ${(err as Error).message}` }] }
        }
      }

      return { content: [{ type: 'text', text: `未知操作: ${action}` }] }
    },
  })
}
