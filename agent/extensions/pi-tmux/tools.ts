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
  normalizeSessionName,
  loadRegistry,
  registerSession,
  unregisterSession,
  pruneRegistry,
  removeLog,
  isPiSession,
  tmuxMissingError,
  tmuxUnsupportedError,
} from './core'
import type { TmuxConfig } from './config'
import { createCompletionWatcher, type CompletionWatcher, type WatcherHandle, NOTIFY_CUSTOM_TYPE } from './watcher'

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

/**
 * 会话名规范化（安全）：强制 pi- 前缀，仅允许字母/数字/下划线/中划线。
 * 非法名（含 ../、/、空名等）抛错，由调用方 try/catch 转 err() 返回——
 * 防止路径穿越注入日志路径（tmux_stop remove_log 删任意 .log、tmux_read 读任意 .log）。
 */
export function resolveName(params: Record<string, unknown>, prefix: string): string {
  const raw = String(params.name ?? '')
  return normalizeSessionName(raw, prefix)
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

export function registerTmuxTools(pi: ExtensionAPI, cfg: TmuxConfig): CompletionWatcher {
  // 完成自动唤醒：tmux_run 启动会话后轮询，会话结束即 sendMessage 触发新回合
  // （风险：探测失败保守判存活防误报；通知失败静默不中断）
  // opts 缓存：轮询每 5s 一次，若每次 re-spawn `tmux -V` 检查，长任务（小时级）
  // 会 spawn 数百次子进程；tmux 配置在会话生命周期内不变，首次解析后复用
  let cachedOpts: TmuxOpts | null = null
  // 审计 MEDIUM 修复：tmux_run 的 watcher 句柄按会话名登记——tmux_stop 主动
  // 停止时须同步停监听，否则 ≤5s 内轮询发现会话消失触发 sendMessage 空唤醒新回合
  const watcherHandles = new Map<string, WatcherHandle>()
  const watcher = createCompletionWatcher({
    hasSession: async (name: string) => {
      if (!cachedOpts) {
        const maybe = await requireTmux(cfg)
        if ('error' in maybe) return true // tmux 探测失败：保守认为存活，避免误报完成
        cachedOpts = maybe
      }
      return hasSession(cachedOpts, name)
    },
    notify: async (text: string) => {
      await pi.sendMessage(
        { customType: NOTIFY_CUSTOM_TYPE, content: text, display: true },
        { triggerTurn: true },
      )
    },
    // 审计 LOW 修复：会话自然完成（watch 探测到 !alive，非 tmux_stop）后同步
    // 从 watcherHandles Map 删除句柄、卸载注册表条目——避免长工作时长下 Map/
    // registry 累积已结束会话的引用（会话已死，无需再查 tmux 存活）。
    onDone: (name) => {
      watcherHandles.delete(name)
      unregisterSession(name)
    },
  })
  // ── tmux_run ────────────────────────────────────────────────
  pi.registerTool({
    name: 'tmux_run',
    label: '启动后台会话',
    description:
      '在分离的 tmux 会话中执行命令（pi- 前缀命名），输出持续落盘 ~/.pi/logs/tmux/<会话>.log。适合长任务/dev server/不用阻塞对话、不依赖终端存活、可后续读取与交互。',
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
        notify: { type: 'boolean', description: '任务结束后自动触发新回合汇报结果（默认 true）' },
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
        if (started) {
          registerSession({
            name,
            logPath,
            command: String(params.command),
            createdAt: new Date().toISOString(),
            // 审计（2026-08-24）：记录发起会话 id，供 pi-context“本会话后台任务”
            // 压缩门识别本会话发起的后台任务；owner 为空/缺失视为无主条目不匹配
            owner: process.env.PI_SESSION_ID || "",
          })
          // 完成自动唤醒（默认开；沿用已有会话不注册，防误报用户会话）。
          // 审计 LOW：仅通知启用的会话登记句柄——notify=false 无监听定时器、
          // 永不触发 onDone，登记只会残留无法回收的句柄引用。
          if (params.notify !== false) {
            watcherHandles.set(name, watcher.watch(name, logPath, true))
          }
        }
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
        // 审计 LOW 修复：查看状态时同步清理注册表陈旧条目（会话自然退出/崩溃后残留），
        // 防 registry.sessions 长期累积；tmux 不可用时 pruneRegistry 内部自跳。
        await pruneRegistry(opts)
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
        // 完成自动唤醒 ack：用户已读取过该会话（日志已人工查看），
        // 会话完成时不再触发完成通知打扰（防积压/冗余报警）
        watcher.ack(name)
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
        // 审计 MEDIUM 修复：主动停止时停掉完成监听，防止 5s 内轮询发现会话消失
        // 而触发 sendMessage 空唤醒新回合（与“手动停止”语义冲突）
        watcherHandles.get(name)?.stop()
        watcherHandles.delete(name)
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
    description: '轮询等待会话结束/日志出现 pattern/超时返回。阻塞式（等待期间无法处理用户新消息）；仅本轮必须拿结果才能继续时才用，否则 tmux_run 后直接结束回合，进度下轮 tmux_read 查看。',
    promptSnippet: '等待后台任务完成（阻塞式，慎用）',
    promptGuidelines: [
      '需拿结果才能继续：tmux_wait(name=..., until_exit=true)',
      '等日志关键字：tmux_wait(name=..., pattern="...", until_exit=false)',
      '不需阻塞：tmux_run 后结束回合，下轮 tmux_read 看进度',
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

  return watcher
}
