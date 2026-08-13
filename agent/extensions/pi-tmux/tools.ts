import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  type TmuxOpts,
  startSession,
  listSessions,
  hasSession,
  readOutput,
  sendKeys,
  killSession,
  waitSession,
  loadRegistry,
  registerSession,
  unregisterSession,
  removeLog,
  isPiSession,
  tmuxMissingError,
  tmuxUnsupportedError,
} from './core'
import type { TmuxConfig } from './config'

type ToolText = { type: 'text'; text: string }[]
type ToolResultObj = { content: ToolText; details: unknown }
type ToolErrorObj = { content: ToolText; details: unknown; isError: boolean }

/** 统一错误输出：环境缺失时返回可修复指引，不抛异常崩溃。 */
function err(text: string): ToolErrorObj {
  return { content: [{ type: 'text', text }], details: null, isError: true }
}

function ok(text: string): ToolResultObj {
  return { content: [{ type: 'text', text }], details: null }
}

function resolveName(params: Record<string, unknown>, prefix: string): string {
  const raw = String(params.name ?? '')
  return raw.startsWith(prefix) ? raw : prefix + raw
}

async function requireTmux(cfg: TmuxConfig): Promise<TmuxOpts | { error: ReturnType<typeof err> }> {
  const opts = { bin: cfg.bin, prefix: cfg.prefix, logDir: cfg.logDir }
  const { runTmux } = await import('./core')
  const r = await runTmux(opts, ['-V'], 10000)
  if (r.code === 127) {
    return { error: err(tmuxMissingError(`命令 "${cfg.bin}" 不存在`)) }
  }
  if (r.code !== 0) {
    return { error: err(tmuxUnsupportedError(`tmux -V 失败 (${r.stderr || r.stdout})`)) }
  }
  return opts
}

export function registerTmuxTools(pi: ExtensionAPI, cfg: TmuxConfig): void {
  // ── tmux_run ────────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_run',
    label: '启动后台会话',
    description:
      '在 detached tmux 会话中执行命令（pi- 前缀命名），输出持续落盘到 ~/.pi/logs/tmux/<会话>.log。' +
      '适合长任务/dev server/watch/交互式程序：不阻塞当前对话、不依赖当前终端存活、会话可保留供后续读取与交互。',
    promptSnippet: '在后台 tmux 会话运行长任务',
    promptGuidelines: [
      '长任务（构建/测试/下载/服务）优先用 tmux_run 而非 bash 直接跑，避免输出截断与会话中断',
      '之后用 tmux_read 读日志、tmux_send 交互、tmux_wait 等完成、tmux_stop 结束',
    ],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '会话名（仅字母数字下划线中划线，自动加 pi- 前缀）' },
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（默认 ~）' },
      },
      required: ['name', 'command'],
    },
    async execute(_id, params) {
      const maybe = await requireTmux(cfg)
      if ('error' in maybe) return maybe.error
      const opts = maybe
      try {
        const { name, logPath, started } = await startSession(opts, String(params.name), String(params.command), params.cwd as string | undefined)
        // 仅新启动的会话登记注册表；已存在同名会话（started=false）不登记，
        // 避免 pi 退出时 session_shutdown 误杀用户手动创建的会话
        if (started) registerSession({ name, logPath, command: String(params.command), createdAt: new Date().toISOString() })
        const note = started ? '已启动' : '已存在同名会话（沿用）'
        return ok(`tmux 会话 ${name} ${note}\n命令: ${params.command}\n日志: ${logPath}\n\n查看: tmux_read(name=${name})\n交互: tmux_send(name=${name})\n等待: tmux_wait(name=${name})`)
      } catch (e) {
        return err(`启动会话失败: ${(e as Error).message}`)
      }
    },
  })

  // ── tmux_status ─────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_status',
    label: '查看会话状态',
    description: '列出所有 tmux 会话（含非 pi- 前缀的用户会话），标注是否附加；可指定会话名查看单个。',
    promptSnippet: '查看后台会话状态',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '可选：指定会话名，仅查该会话是否存活' },
      },
    },
    async execute(_id, params) {
      const maybe = await requireTmux(cfg)
      if ('error' in maybe) return maybe.error
      const opts = maybe
      try {
        if (params.name && String(params.name).length > 0) {
          const name = resolveName(params, cfg.prefix)
          const alive = await hasSession(opts, name)
          return ok(`会话 ${name}: ${alive ? '存活' : '不存在/已结束'}`)
        }
        const sessions = await listSessions(opts)
        const reg = loadRegistry()
        const piSessions = sessions.filter((s) => isPiSession(s.name, cfg.prefix))
        const userSessions = sessions.filter((s) => !isPiSession(s.name, cfg.prefix))
        const lines = [
          `tmux 会话共 ${sessions.length} 个：`,
          ...piSessions.map((s) => {
            const e = reg.sessions[s.name]
            const cmd = e ? ` — ${e.command}` : ''
            return `  ${s.name}${s.attached ? ' (已附加)' : ''}${cmd}`
          }),
          ...(userSessions.length ? ['用户会话:', ...userSessions.map((s) => `  ${s.name}${s.attached ? ' (已附加)' : ''}`)] : []),
        ]
        return ok(lines.join('\n'))
      } catch (e) {
        return err(`查询状态失败: ${(e as Error).message}`)
      }
    },
  })

  // ── tmux_read ───────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_read',
    label: '读取会话输出',
    description: '读取 tmux 会话最近的输出（优先日志尾部 N 行，缺失时回退 capture-pane 当前屏幕）。',
    promptSnippet: '读取后台任务输出',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '会话名' },
        lines: { type: 'number', description: `读取尾部行数（默认 ${cfg.defaultLines}）` },
      },
      required: ['name'],
    },
    async execute(_id, params) {
      const maybe = await requireTmux(cfg)
      if ('error' in maybe) return maybe.error
      const opts = maybe
      try {
        const name = resolveName(params, cfg.prefix)
        const lines = Math.max(1, Math.min(Number(params.lines) || cfg.defaultLines, 1000))
        const out = await readOutput(opts, name, lines)
        const src = out.source === 'log' ? '日志' : '当前屏幕'
        const tag = out.truncated ? ' (已截断)' : ''
        return ok(`[${name} · ${src}${tag}]\n${out.text || '(无输出)'}`)
      } catch (e) {
        return err(`读取会话失败: ${(e as Error).message}`)
      }
    },
  })

  // ── tmux_send ───────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_send',
    label: '向会话发送输入',
    description: '向 tmux 会话发送文本/按键：文本默认回车执行，或发送 Ctrl 组合键（如 c/c 中断）。',
    promptSnippet: '向后台任务发送输入/按键',
    promptGuidelines: [
      '停止运行中的任务：tmux_send(name=..., ctrl_key="c")',
      '向交互程序输入：tmux_send(name=..., text="...", enter=true)',
    ],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '会话名' },
        text: { type: 'string', description: '要输入的文本' },
        ctrl_key: { type: 'string', description: 'Ctrl 组合键字母，如 "c"=Ctrl+C"；与 text 二选一' },
        enter: { type: 'boolean', description: '发送后是否回车（默认 text 时 true）' },
      },
      required: ['name'],
    },
    async execute(_id, params) {
      const maybe = await requireTmux(cfg)
      if ('error' in maybe) return maybe.error
      const opts = maybe
      try {
        const name = resolveName(params, cfg.prefix)
        if (!params.text && !params.ctrl_key) return err('需提供 text 或 ctrl_key')
        const enter = params.enter !== false
        await sendKeys(opts, name, {
          text: params.text ? String(params.text) : undefined,
          ctrlKey: params.ctrl_key ? String(params.ctrl_key) : undefined,
          enter: !!params.text && enter,
        })
        return ok(`已发送到 ${name}`)
      } catch (e) {
        return err(`发送失败: ${(e as Error).message}`)
      }
    },
  })

  // ── tmux_stop ───────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_stop',
    label: '结束会话',
    description: '结束 tmux 会话（kill-session）。可选删除日志文件。',
    promptSnippet: '结束后台会话',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '会话名' },
        remove_log: { type: 'boolean', description: '是否同时删除日志文件（默认 false）' },
      },
      required: ['name'],
    },
    async execute(_id, params) {
      const maybe = await requireTmux(cfg)
      if ('error' in maybe) return maybe.error
      const opts = maybe
      try {
        const name = resolveName(params, cfg.prefix)
        await killSession(opts, name)
        unregisterSession(name)
        if (params.remove_log) removeLog(opts, name)
        return ok(`会话 ${name} 已结束${params.remove_log ? '，日志已删除' : ''}`)
      } catch (e) {
        return err(`结束会话失败: ${(e as Error).message}`)
      }
    },
  })

  // ── tmux_wait ───────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_wait',
    label: '等待会话完成',
    description: '轮询等待 tmux 会话结束，或日志中出现指定 pattern，或超时返回。适合阻塞式等长任务结果。',
    promptSnippet: '等待后台任务完成',
    promptGuidelines: [
      '想等命令跑完拿结果：tmux_wait(name=..., until_exit=true)',
      '想等日志出现某关键字：tmux_wait(name=..., pattern="...", until_exit=false)',
    ],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '会话名' },
        pattern: { type: 'string', description: '等待日志中出现的关键字（可选）' },
        timeout: { type: 'number', description: `超时秒数（默认 ${cfg.defaultTimeoutSec}）` },
        until_exit: { type: 'boolean', description: '等待会话结束（默认 false；true 时 pattern 忽略）' },
      },
      required: ['name'],
    },
    async execute(_id, params) {
      const maybe = await requireTmux(cfg)
      if ('error' in maybe) return maybe.error
      const opts = maybe
      try {
        const name = resolveName(params, cfg.prefix)
        const timeoutSec = Math.max(1, Math.min(Number(params.timeout) || cfg.defaultTimeoutSec, 3600))
        const untilExit = params.until_exit === true
        const pattern = !untilExit && params.pattern ? String(params.pattern) : undefined
        const result = await waitSession(opts, name, pattern, timeoutSec * 1000, untilExit)
        const head: Record<string, string> = {
          exited: '会话已结束',
          pattern: `日志已出现关键字 "${pattern}"`,
          timeout: `等待超时（${timeoutSec}s）`,
        }
        const tail = result.lastOutput ? `\n\n最新输出（尾部）:\n${result.lastOutput.slice(-2000)}` : ''
        return ok(`${head[result.outcome]}${tail}`)
      } catch (e) {
        return err(`等待失败: ${(e as Error).message}`)
      }
    },
  })
}
