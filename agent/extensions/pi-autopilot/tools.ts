import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readSettings, readModels, listAvailableModels, updateModelConfig, updateSettings, isSensitiveKey } from './config.ts'
import { listSessions, resolveSession } from './sessions.ts'
import { writeRestartRequest } from './state.ts'
import { addTask, deleteTask, listTasks, updateTask, setSettings, readTasks } from './storage.ts'
import { readAutopilotConfig, writeAutopilotConfig } from './autoconfig.ts'
import { readTelemetry, statsByModel, statsByTask, todayRuns, todayCost } from './telemetry.ts'
import { planFailover, executeFailover } from './failover.ts'
import { currentModel } from './policy.ts'

export function registerTools(pi: ExtensionAPI): void {
  // ── autopilot_status：融合 agent 状态 + 调度统计 + 预算 ──────────
  pi.registerTool({
    name: 'autopilot_status',
    label: '自主运行状态',
    description: '查看自主运行整体状态：当前模型、会话、调度任务统计、遥测成功率、预算用量、failover 配置、全局暂停标志。',
    parameters: { type: 'object', properties: {} },
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const settings = readSettings()
      const config = await readAutopilotConfig()
      const tasks = await listTasks()
      const telemetry = await readTelemetry()
      const sessionFile = ctx.sessionManager?.getSessionFile?.() || '(未知)'
      const byModel = statsByModel(telemetry)
      const enabledTasks = tasks.filter(t => t.enabled).length

      const sections: string[] = [
        '自主运行状态',
        `  运行模式: ${ctx.mode || '未知'}`,
        `  当前模型: ${settings.defaultProvider || '?'}/${settings.defaultModel || '?'}`,
        `  会话文件: ${sessionFile}`,
        `  自主运行: ${config.enabled ? '开启' : '关闭'} | 全局暂停: ${(await readTasks()).settings.paused ? '是' : '否'}`,
        `  定时任务: ${tasks.length} 个（启用 ${enabledTasks}）`,
        `  遥测: ${telemetry.length} 条记录`,
      ]
      if (byModel.length) {
        const top = byModel[0]
        sections.push(`  成功率最高模型: ${top.provider}/${top.model} (${Math.round(top.successRate * 100)}%, ${top.runs} 次)`)
      }
      sections.push(`  今日预算: ${todayRuns(telemetry)} 次 / $${todayCost(telemetry).toFixed(4)}`)
      sections.push(`  failover 链: ${config.fallbackModels.length ? config.fallbackModels.map(f => `${f.provider}/${f.model}`).join(' → ') : '(未配置)'}`)

      return { content: [{ type: 'text', text: sections.join('\n') }], details: null }
    },
  })

  // ── autopilot_stats：遥测统计 ────────────────────────────────────
  pi.registerTool({
    name: 'autopilot_stats',
    label: '执行遥测统计',
    description: '查看任务执行遥测：按模型和按任务的成功率、耗时、估算成本。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const telemetry = await readTelemetry()
      const byModel = statsByModel(telemetry)
      const byTask = statsByTask(telemetry)
      const lines: string[] = [`执行遥测 (${telemetry.length} 条记录):`]
      lines.push('\n按模型:')
      for (const m of byModel.slice(0, 10)) {
        lines.push(`  ${m.provider}/${m.model}: ${Math.round(m.successRate * 100)}% 成功率, ${m.runs} 次, 平均 ${Math.round(m.avgDurationMs / 1000)}s, 成本 $${m.totalCost.toFixed(4)}`)
      }
      lines.push('\n按任务:')
      for (const t of byTask.slice(0, 10)) {
        lines.push(`  ${t.taskName}: ${Math.round(t.successRate * 100)}% 成功率, ${t.runs} 次, ${t.failures} 失败`)
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: null }
    },
  })

  // ── autopilot_policy：查看策略（只读 + 建议） ────────────────────
  pi.registerTool({
    name: 'autopilot_policy',
    label: '查看自主运行策略',
    description: '查看当前 failover 链、失败阈值、挂死检测、预算等自主运行策略配置。策略修改请使用 /auto policy 命令。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const config = await readAutopilotConfig()
      const lines: string[] = [
        '自主运行策略（修改请用 /auto policy）:',
        `  enabled: ${config.enabled}`,
        `  failover 链: ${config.fallbackModels.length ? config.fallbackModels.map(f => `${f.provider}/${f.model}`).join(' → ') : '(未配置)'}`,
        `  failoverAfter: ${config.policy.failoverAfter} 次失败后切换`,
        `  suspendAfter: ${config.policy.suspendAfter} 次失败后暂停任务`,
        `  timeoutFactor: ${config.policy.timeoutFactor}`,
        `  maxIdleMinutes: ${config.maxIdleMinutes}（超时判定挂死并重启）`,
        `  requeueOnRestart: ${config.requeueOnRestart}`,
        `  预算: 日运行上限 ${config.budget.maxRunsPerDay} 次, 日成本上限 $${config.budget.maxCostPerDay}, 模型白名单 ${config.budget.allowedModels?.length ? config.budget.allowedModels.join(', ') : '(无)'}`,
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }], details: null }
    },
  })

  // ── autopilot_failover：dry-run 测试 ─────────────────────────────
  pi.registerTool({
    name: 'autopilot_failover',
    label: '测试模型切换计划',
    description: 'dry-run 测试 failover：展示当前模型故障时下一个目标模型及决策理由，不实际执行切换。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const config = await readAutopilotConfig()
      const { provider, model } = currentModel()
      const plan = await planFailover(config.fallbackModels, provider, model)
      if (!plan.target) {
        return { content: [{ type: 'text', text: `当前 ${provider}/${model}\nfailover: ${plan.reason}` }], details: null }
      }
      return { content: [{ type: 'text', text: `当前 ${provider}/${model}\nfailover: ${plan.reason}\n（dry-run，未实际执行）` }], details: null }
    },
  })

  // ── 以下为 pi-admin 迁移工具（原名保留） ─────────────────────────
  pi.registerTool({
    name: 'admin_status',
    label: 'Agent 状态',
    description: '查看当前 Agent 的运行时状态：当前模型/Provider、当前会话文件、运行模式、配置摘要、是否有待处理的重启操作。',
    parameters: { type: 'object', properties: {} },
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const settings = readSettings()
      const models = readModels()
      const sessionFile = ctx.sessionManager?.getSessionFile?.() || '(未知)'
      const sections: string[] = [
        'Agent 状态',
        `  运行模式: ${ctx.mode || '未知'}`,
        `  当前 Provider: ${settings.defaultProvider || '未设置'}`,
        `  当前模型: ${settings.defaultModel || '未设置'}`,
        `  会话文件: ${sessionFile}`,
        `  思考层级: ${settings.defaultThinkingLevel || '未设置'}`,
        `  Provider 总数: ${models.providers ? Object.keys(models.providers).length : 0}`,
      ]
      return { content: [{ type: 'text', text: sections.join('\n') }], details: null }
    },
  })

  pi.registerTool({
    name: 'admin_list_models',
    label: '列出可用模型',
    description: '列出 models.json 中所有可用的 Provider 及其模型列表，包含模型 ID、上下文窗口大小等信息。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const providers = listAvailableModels()
      if (!providers.length) return { content: [{ type: 'text', text: '(未找到可用模型)' }], details: null }
      const lines: string[] = ['可用模型列表:']
      for (const p of providers) {
        lines.push(`\n[${p.name}]`)
        if (p.baseUrl) lines.push(`  API: ${p.api || '未知'} | Base URL: ${p.baseUrl}`)
        for (const m of p.models) {
          const ctx = m.contextWindow ? `ctx:${m.contextWindow}` : ''
          const maxT = m.maxTokens ? `max:${m.maxTokens}` : ''
          const reas = m.reasoning ? '思考' : ''
          lines.push(`  - ${m.id}${m.name ? ` (${m.name})` : ''}${[ctx, maxT, reas].filter(Boolean).join(' ')}`)
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: null }
    },
  })

  pi.registerTool({
    name: 'admin_set_model',
    label: '切换模型',
    description: '切换默认模型和 Provider。会更新 settings.json 并立即重启 Agent 以加载新模型。重启后自动恢复当前会话。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider 名称，如 "deepseek"' },
        model: { type: 'string', description: '模型 ID' },
      },
      required: ['provider', 'model'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const provider = params.provider as string
      const model = params.model as string
      const result = updateModelConfig(provider, model)
      if (!result.success) return { content: [{ type: 'text', text: result.error || '设置失败' }], details: null, isError: true }
      if (!ctx.hasUI) {
        // headless 禁止未经确认重启宿主（防 agent 自我授权改模型/切会话并重启）
        return { content: [{ type: 'text', text: '无 UI 环境禁止直接切换模型（会重启 Agent）。请在 TUI 会话中执行，或设置环境变量 PI_AUTOPILOT_ALLOW_HEADLESS=1 显式放行。' }], details: null, isError: true }
      }
      const confirmed = await ctx.ui.confirm('切换模型', `将切换为 ${provider}/${model}，需要重启 Agent。是否继续？`)
      if (!confirmed) return { content: [{ type: 'text', text: `已保存配置但未重启。下次启动将使用 ${provider}/${model}` }], details: null }
      writeRestartRequest('set_model', {
        targetProvider: provider,
        targetModel: model,
        reason: `切换模型为 ${provider}/${model}`,
      })
      try { ctx.shutdown() } catch { process.exit(0) }
      return { content: [{ type: 'text', text: `正在重启以加载模型 ${provider}/${model}...` }], details: null }
    },
  })

  pi.registerTool({
    name: 'admin_get_config',
    label: '读取配置',
    description: '读取 settings.json 的配置项。不传 key 时返回全部配置（敏感字段掩蔽为 ***）。',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: '配置键名（可选），不传则返回全部' } },
    },
    execute: async (_toolCallId, params) => {
      const settings = readSettings()
      const key = params.key as string | undefined
      if (key) {
        const val = settings[key]
        // 与无参路径一致：递归掩蔽嵌套敏感字段（key=providers 时内层 apiKey 不泄漏）
        const safeVal = isSensitiveKey(key) && typeof val === 'string' ? '***' : maskSensitive(val)
        return { content: [{ type: 'text', text: `${key}: ${typeof safeVal === 'string' ? safeVal : JSON.stringify(safeVal, null, 2)}` }], details: null }
      }
      const safe = maskSensitive(settings)
      return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], details: null }
    },
  })

  // 递归掩蔽含 key/token/secret 的字段（含嵌套 provider 配置）
  function maskSensitive(val: unknown, depth = 0): unknown {
    if (val === null || typeof val !== 'object' || depth > 6) return val
    if (Array.isArray(val)) return val.map((v) => maskSensitive(v, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val)) {
      out[k] = isSensitiveKey(k) && typeof v === 'string' ? '***' : maskSensitive(v, depth + 1)
    }
    return out
  }

  pi.registerTool({
    name: 'admin_set_config',
    label: '修改配置',
    description: '修改 settings.json 中的配置项。敏感字段（如含 key/token/secret 的字段）需用户确认。修改立即生效。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '配置键名' },
        value: { type: 'string', description: '配置值（字符串）。数组或对象字段会自动解析 JSON。' },
      },
      required: ['key', 'value'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const key = params.key as string
      const rawValue = params.value as string
      let parsedValue: unknown = rawValue
      if (rawValue === 'true') parsedValue = true
      else if (rawValue === 'false') parsedValue = false
      else if (/^\d+$/.test(rawValue)) parsedValue = parseInt(rawValue, 10)
      else if (/^\d+\.\d+$/.test(rawValue)) parsedValue = parseFloat(rawValue)
      else if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
        try { parsedValue = JSON.parse(rawValue) } catch { /* keep as string */ }
      }
      if (isSensitiveKey(key) && ctx.hasUI) {
        const ok = await ctx.ui.confirm('修改敏感配置', `确认修改 "${key}" 为 ${JSON.stringify(parsedValue)}？`)
        if (!ok) return { content: [{ type: 'text', text: '已取消' }], details: null }
      }
      const result = updateSettings(key, parsedValue)
      if (!result.success) return { content: [{ type: 'text', text: result.error || '写入失败' }], details: null, isError: true }
      return { content: [{ type: 'text', text: `已更新配置: ${key} = ${JSON.stringify(parsedValue)}` }], details: null }
    },
  })

  pi.registerTool({
    name: 'admin_list_sessions',
    label: '列出会话',
    description: '列出当前工作目录下（或全部）的会话文件。',
    parameters: {
      type: 'object',
      properties: { cwd: { type: 'string', description: '工作目录（可选），不传时列出全部会话目录' } },
    },
    execute: async (_toolCallId, params) => {
      const cwd = params.cwd as string | undefined
      const sessions = listSessions(cwd)
      if (!sessions.length) return { content: [{ type: 'text', text: `(未找到会话${cwd ? ` 在 ${cwd}` : ''})` }], details: null }
      const lines: string[] = [`会话列表 (${sessions.length} 个，按修改时间倒序):`]
      for (const s of sessions.slice(0, 30)) {
        const sizeKB = (s.sizeBytes / 1024).toFixed(1)
        const mtime = new Date(s.mtimeMs).toISOString().slice(0, 19)
        lines.push(`  ${s.sessionId}  [${sizeKB} KB] [${mtime}]`)
        lines.push(`    摘要: ${s.firstLinePreview}`)
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: null }
    },
  })

  pi.registerTool({
    name: 'admin_switch_session',
    label: '切换会话',
    description: '切换到指定的会话文件。支持按 sessionId 前缀匹配或直接指定文件路径。需要重启 Agent。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '会话 ID（支持前缀匹配）或 .jsonl 文件路径' },
        reason: { type: 'string', description: '切换原因（可选）' },
      },
      required: ['target'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const target = params.target as string
      const reason = params.reason as string | undefined
      const session = resolveSession(target)
      if (!session) return { content: [{ type: 'text', text: `未找到匹配的会话: ${target}` }], details: null, isError: true }
      if (!ctx.hasUI) {
        return { content: [{ type: 'text', text: '无 UI 环境禁止直接切换会话（会重启 Agent）。请在 TUI 会话中执行，或设置环境变量 PI_AUTOPILOT_ALLOW_HEADLESS=1 显式放行。' }], details: null, isError: true }
      }
      const confirmed = await ctx.ui.confirm('切换会话', `将切换到会话 ${session.sessionId}，需要重启 Agent。是否继续？`)
      if (!confirmed) return { content: [{ type: 'text', text: '已取消会话切换' }], details: null }
      writeRestartRequest('switch_session', {
        targetSession: session.filePath,
        reason: reason || `切换到会话 ${session.sessionId}`,
      })
      try { ctx.shutdown() } catch { process.exit(0) }
      return { content: [{ type: 'text', text: `正在切换到会话 ${session.sessionId}...` }], details: null }
    },
  })

  pi.registerTool({
    name: 'admin_restart',
    label: '重启 Agent',
    description: '重启 Agent 程序。当前会话会自动保存，重启后通过 --continue 自动恢复并继续执行任务。如果不需要重启，请拒绝此调用。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '重启原因（可选）' } },
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const reason = params.reason as string | undefined
      writeRestartRequest('restart', { reason: reason || '用户请求重启' })
      // ctx.shutdown() 在 TUI 环境实测不退出进程（admin_restart 后 PID 不变，
      // 新代码永不加载）。强制退出让 wrapper 检测到退出码并按 restart 请求
      // --continue 重启；1500ms 兜底（给 shutdown 异步保存会话的时间）。
      try {
        const p = ctx.shutdown() as unknown
        if (p && typeof (p as Promise<unknown>).then === 'function') {
          await (p as Promise<unknown>)
        }
      } catch {
        /* ignore */
      }
      setTimeout(() => process.exit(0), 1500)
      return { content: [{ type: 'text', text: '正在重启...' }], details: null }
    },
  })

  // ── schedule_task（迁自 pi-scheduler） ───────────────────────────
  pi.registerTool({
    name: 'schedule_task',
    label: '管理定时任务',
    description: `创建、列出、更新、删除、启用或禁用定时任务。
支持的任务类型:
- interval: 按间隔重复（例如 "5m", "1h", "30s"）
- cron: 按 cron 表达式执行（5字段 POSIX，例如 "0 9 * * 1-5" 表示工作日9点）
- once: 一次性任务（相对时间 "+30m" 或 ISO 时间戳），执行后自动移除

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
        name: { type: 'string', description: '任务名称（add 必需，delete/enable/disable/update 可用作标识）' },
        type: { type: 'string', enum: ['interval', 'cron', 'once'], description: '任务类型（action=add 时必需）' },
        schedule: { type: 'string', description: '调度表达式（action=add 必需；update 时可修改）' },
        prompt: { type: 'string', description: '要执行的提示词（action=add 必需；update 时可修改）' },
        useSubagent: { type: 'boolean', description: '是否在子代理中执行（不打断当前会话）' },
        notifyOnCompletion: { type: 'boolean', description: '执行完成时是否发送 webhook 通知（需配置 webhookUrl）' },
        maxRunTime: { type: 'number', description: '执行超时秒数（默认 300），仅 useSubagent=true 时生效' },
        tags: { type: 'array', items: { type: 'string' }, description: '任务标签（可选，用于 list 过滤）' },
        retries: { type: 'number', description: '失败后的额外重试次数（每次间隔 60s，默认 0）' },
        taskId: { type: 'string', description: '任务 ID（用于 update/delete/enable/disable）' },
      },
      required: ['action'],
    },
    execute: async (_toolCallId, params) => {
      const action = params.action as string

      if (action === 'add') {
        if (!params.name || !params.type || !params.schedule || !params.prompt) {
          return { content: [{ type: 'text', text: '缺少参数: name, type, schedule, prompt 为必需' }], details: null }
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
          return { content: [{ type: 'text', text: `已创建任务: ${task.name}\nID: ${task.id}\n类型: ${task.type}\n调度: ${task.schedule}\n下次执行: ${task.nextRun || '无法计算'}\n标签: ${task.tags.join(', ') || '无'}\n重试: ${task.retries}` }], details: null }
        } catch (err) {
          return { content: [{ type: 'text', text: `创建失败: ${(err as Error).message}` }], details: null }
        }
      }

      if (action === 'list') {
        const tasks = await listTasks()
        if (tasks.length === 0) return { content: [{ type: 'text', text: '暂无定时任务' }], details: null }
        const lines = tasks.map(t =>
          `${t.enabled ? '✓' : '✗'} ${t.name} (${t.type}) ${t.schedule}${t.tags.length > 0 ? ` #${t.tags.join('#')}` : ''}\n  next: ${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'} last: ${t.lastRun ? new Date(t.lastRun).toLocaleString('zh-CN') : '—'} (${t.lastResult || '—'})×${t.runCount} 重试: ${t.retries}\n  prompt: ${t.prompt.slice(0, 60)}`
        )
        return { content: [{ type: 'text', text: `定时任务 (${tasks.length}):\n${lines.join('\n')}` }], details: null }
      }

      if (action === 'pause') {
        await setSettings({ paused: true })
        return { content: [{ type: 'text', text: '已全局暂停调度' }], details: null }
      }

      if (action === 'resume') {
        await setSettings({ paused: false })
        return { content: [{ type: 'text', text: '已恢复调度' }], details: null }
      }

      const idOrName = (params.taskId || params.name) as string | undefined
      if (!idOrName) return { content: [{ type: 'text', text: '缺少参数: taskId 或 name' }], details: null }

      if (action === 'delete') {
        const ok = await deleteTask(idOrName)
        return { content: [{ type: 'text', text: ok ? `已删除任务: ${idOrName}` : `未找到任务: ${idOrName}` }], details: null }
      }

      if (action === 'enable') {
        const t = await updateTask(idOrName, { enabled: true })
        return { content: [{ type: 'text', text: t ? `已启用任务: ${t.name}` : `未找到任务: ${idOrName}` }], details: null }
      }

      if (action === 'disable') {
        const t = await updateTask(idOrName, { enabled: false })
        return { content: [{ type: 'text', text: t ? `已禁用任务: ${t.name}` : `未找到任务: ${idOrName}` }], details: null }
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
          return { content: [{ type: 'text', text: '未指定修改项: schedule / prompt / useSubagent / notifyOnCompletion / maxRunTime / retries / tags' }], details: null }
        }
        try {
          const t = await updateTask(idOrName, updates)
          if (!t) return { content: [{ type: 'text', text: `未找到任务: ${idOrName}` }], details: null }
          return { content: [{ type: 'text', text: `已更新任务: ${t.name}\n调度: ${t.schedule}\n下次执行: ${t.nextRun || '—'}` }], details: null }
        } catch (err) {
          return { content: [{ type: 'text', text: `更新失败: ${(err as Error).message}` }], details: null }
        }
      }

      return { content: [{ type: 'text', text: `未知操作: ${action}` }], details: null }
    },
  })
}
