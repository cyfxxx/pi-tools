import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { addTask, deleteTask, listTasks, updateTask } from './storage.ts'

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'schedule_task',
    label: '管理定时任务',
    description: `创建、列出、删除、启用或禁用定时任务。
支持的任务类型:
- interval: 按间隔重复（例如 "5m", "1h", "30s"）
- cron: 按 cron 表达式执行（5字段 POSIX，例如 "0 9 * * 1-5" 表示工作日9点）
- once: 一次性任务（相对时间 "+30m" 或 ISO 时间戳）

创建任务后，任务会在 Pi 会话活跃时自动触发。
Pi 关闭时，系统 cron 会接管执行。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'delete', 'enable', 'disable'],
          description: '操作类型',
        },
        name: {
          type: 'string',
          description: '任务名称（add/delete/enable/disable 时使用）',
        },
        type: {
          type: 'string',
          enum: ['interval', 'cron', 'once'],
          description: '任务类型（action=add 时必需）',
        },
        schedule: {
          type: 'string',
          description: '调度表达式（action=add 时必需）',
        },
        prompt: {
          type: 'string',
          description: '要执行的提示词（action=add 时必需）',
        },
        useSubagent: {
          type: 'boolean',
          description: '是否在子代理中执行（不打断当前会话）',
        },
        notifyOnCompletion: {
          type: 'boolean',
          description: '执行完成时是否发送通知',
        },
        taskId: {
          type: 'string',
          description: '任务 ID（用于 delete/enable/disable）',
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
        const task = await addTask({
          name: params.name as string,
          type: params.type as 'interval' | 'cron' | 'once',
          schedule: params.schedule as string,
          prompt: params.prompt as string,
          useSubagent: params.useSubagent as boolean | undefined,
          notifyOnCompletion: params.notifyOnCompletion as boolean | undefined,
        })
        return {
          content: [{
            type: 'text',
            text: `已创建任务: ${task.name}\nID: ${task.id}\n类型: ${task.type}\n调度: ${task.schedule}\n下次执行: ${task.nextRun || '无法计算'}`,
          }],
        }
      }

      if (action === 'list') {
        const tasks = await listTasks()
        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: '暂无定时任务' }] }
        }
        const lines = tasks.map(t =>
          `${t.enabled ? '✓' : '✗'} ${t.name} (${t.type}) ${t.schedule}\n  next: ${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'} last: ${t.lastRun ? new Date(t.lastRun).toLocaleString('zh-CN') : '—'} (${t.lastResult || '—'})×${t.runCount}\n  prompt: ${t.prompt.slice(0, 60)}`
        )
        return { content: [{ type: 'text', text: `定时任务 (${tasks.length}):\n${lines.join('\n')}` }] }
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

      return { content: [{ type: 'text', text: `未知操作: ${action}` }] }
    },
  })
}
