import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { spawn } from 'node:child_process'
import {
  listTasks, isDue, updateTaskAfterRun, readTasks, writeTasks, renderPrompt, sendWebhook, updateTask, computeNextRun, withStoreLock, isoNow, releaseSessionLock,
} from './storage.ts'
import type { Task } from './types.ts'
import { readAutopilotConfig } from './autoconfig.ts'
import { decide, classifyError, currentModel, isLocalModel } from './policy.ts'
import { planFailover, executeFailover } from './failover.ts'
import { appendRun, estimateCost } from './telemetry.ts'
import { checkBudget } from './budget.ts'
import { triggerHangRecovery, touchActivity } from './watchdog.ts'
import { markPendingInjected, clearPending } from './queue.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'


/**
 * 解析 pi CLI 入口（spawn 用）。
 * Linux/macOS：pi（PATH）。
 * Windows 便携版：USERPROFILE=包根，spawn 不解析 .cmd——用包内 node + cli.js。
 */
function resolvePiSpawn(): { cmd: string; args: string[] } {
  if (process.platform !== 'win32') {
    // 审计 MEDIUM：headless/cron（PATH 精简）下 `pi` 可能 ENOENT。
    // 优先显式 PI_BIN（wrapper 会设置），否则探测 pi-node 标准安装位置的绝对路径，
    // 都没有才退回 PATH 的 pi。
    const candidates = [
      process.env.PI_BIN || '',
      join(homedir(), '.local', 'share', 'pi-node', 'current', 'bin', 'pi'),
    ]
    for (const c of candidates) {
      if (c && existsSync(c)) return { cmd: c, args: [] }
    }
    return { cmd: 'pi', args: [] }
  }
  const root = process.env.USERPROFILE || homedir()
  const node = join(root, 'node', 'node.exe')
  const cli = join(root, 'pi-global', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  return { cmd: node, args: [cli] }
}

/**
 * 任务经验沉淀触发器（2026-08-24 用户需求）：任务成功完成 → 立即在后台跑
 * task-summarizer.mjs（游标去重幂等，无新任务快速退出不耗 LLM），不再等每日任务。
 * 节流：距上次触发 ≥15min 才跑（防高频 interval 任务反复拉起总结进程）。
 */
const SUMMARIZER_GATE_MS = 15 * 60 * 1000
export async function maybeTriggerSummarizer(): Promise<void> {
  const stamp = join(homedir(), '.pi', 'logs', 'scheduler', 'summarizer.last')
  try {
    const now = Date.now()
    const last = existsSync(stamp) ? Number(readFileSync(stamp, 'utf8')) || 0 : 0
    if (now - last < SUMMARIZER_GATE_MS) return
    writeFileSync(stamp, String(now))
    const logFd = openSync(join(homedir(), '.pi', 'logs', 'scheduler', 'summarizer.log'), 'a')
    const proc = spawn(process.execPath, [join(homedir(), '.pi', 'scripts', 'task-summarizer.mjs')], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    proc.unref()
    // 审计 LOW：detached+stdio 已让子进程接管 fd 副本，父进程句柄不再需要——
    // 不关闭则每次触发泄漏一个 fd，长期运行累积耗尽描述符
    closeSync(logFd)
  } catch { /* 失败静默：下次任务完成再试 */ }
}

export class SessionScheduler {
  private pi: ExtensionAPI
  private timer: ReturnType<typeof setInterval> | null = null
  private firing = new Set<string>()
  /** 本轮已注入主会话的 message 任务 id（agent_settled 时 finalizeInjected 消费） */
  private injectedIds = new Set<string>()
  /** 正在注入中的任务（同步维护，agent_settled 的 clearAllPending 据此跳过） */
  readonly injectingIds = new Set<string>()
  /** 本回合是否被用户中止（agent_end 尾部 assistant stopReason==='aborted'，index.ts 回写）
   *  实测（2026-08-25）：宿主 _runAgentPrompt 的 finally 无条件发 agent_settled——
   *  abort 回合也会走到 finalizeInjected，若不区分会把失败闭环为 success */
  private lastRunAborted = false

  constructor(pi: ExtensionAPI) {
    this.pi = pi
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 30000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.firing.clear()
  }

  /** 立即执行任务（/loop 创建后首次触发用；force=用户手动触发，跳过本地模型提示分支） */
  async runNow(task: Task, force = false): Promise<void> {
    if (this.firing.has(task.id)) return
    await this.fireTask(task, force)
  }

  private async tick(): Promise<void> {
    try {
      const config = await readAutopilotConfig()
      const store = await readTasks()
      // 看门狗挂死检测先于一切业务门控（审计 MEDIUM：此前被 enabled/paused 连带短路——
      // 自主运行关闭/暂停时主会话真挂死无人恢复）。进程自愈与任务调度正交：
      // 不想被自动重启用 maxIdleMinutes=0 显式关闭看门狗（isHanging 直接 false）。
      if (await triggerHangRecovery(config.maxIdleMinutes)) {
        try { (this.pi as unknown as { shutdown?: () => void }).shutdown?.() } catch { /* ignore */ }
        try { await releaseSessionLock() } catch { /* ignore */ }
        process.exit(0)
      }
      if (store.settings.paused) return
      // enabled=false = 自主运行关闭：到期任务不自动执行（含 waitForUserOnLocal 提示注入）。
      // 审计 HIGH：预算拦截整体包在 fireTask 的 if (config.enabled) 内，若 tick 不门控，
      // 关闭状态下任务照常执行且预算检查完全跳过。手动 /schedule run（force）不受影响。
      if (!config.enabled) return

      const tasks = await listTasks()
      // pendingInject=true 表示任务已注入主会话仍可能执行中（fireViaMessage 非阻塞），
      // 过滤掉防 interval 长任务重叠触发（agent_settled 时统一清除）
      const due = tasks.filter(t => isDue(t) && !this.firing.has(t.id) && !t.pendingInject)
      for (const task of due) {
        if (this.firing.has(task.id)) continue
        await this.fireTask(task)
      }
    } catch { /* suppress tick errors */ }
  }

  private async fireTask(task: Task, force = false): Promise<void> {
    this.firing.add(task.id)
    const startedAt = Date.now()
    const config = await readAutopilotConfig()
    const { provider, model } = currentModel()

    try {
      // 本地模型（串行推理）提示分支（2026-08-24 用户需求）：waitForUserOnLocal 任务
      // 到期时不自动执行（后台会话会与主会话串行排队阻塞），仅注入提示由用户决定；
      // 用户手动触发（/schedule run，force=true）时跳过此分支正常执行。
      if (!force && task.waitForUserOnLocal && isLocalModel()) {
        try {
          await this.pi.sendUserMessage?.(
            `[Scheduler] ${task.name} 已到点。当前为本地模型（串行推理），为避免阻塞主会话，未自动执行。` +
            `可回复「/schedule run ${task.name}」或直接说「执行 ${task.name}」后台运行。`)
        } catch { /* 注入失败静默：下次 tick 再提示 */ }
        // 推进 nextRun（+1h）防止每 30s tick 重复催
        await withStoreLock(async () => {
          const store = await readTasks()
          const t = store.tasks.find(x => x.id === task.id)
          if (t) {
            t.nextRun = new Date(Date.now() + 3600 * 1000).toISOString()
            await writeTasks(store)
          }
        })
        return
      }

      // 预算检查
      if (config.enabled) {
        const b = await checkBudget(config.budget, model)
        if (!b.allowed) {
          await sendWebhook(task, 'skipped', `预算限制: ${b.reason}`)
          // 预算拦截不是任务失败：推进 nextRun 防止每 tick 重复触发（否则每 30s
          // 追加一条 failed 遥测，todayRuns 越拦越满，锁到次日零点）；不记 failed。
          // 读写经 withStoreLock 串行化：与 updateTaskAfterRun//schedule 编辑并发时
          // 不得用陈旧副本覆盖（否则丢更新/复活已删任务）。
          await withStoreLock(async () => {
            const store = await readTasks()
            const t = store.tasks.find(x => x.id === task.id)
            if (t) {
              let next = computeNextRun(t)
              if (!next || new Date(next).getTime() <= Date.now()) {
                // once/过期调度：推到 1 小时后重试（预算恢复后自动补跑）
                next = new Date(Date.now() + 3600 * 1000).toISOString()
              }
              t.nextRun = next
              await writeTasks(store)
            }
          })
          return
        }
      }

      if (task.useSubagent) {
        await this.fireViaSubagent(task, provider, model)
        // 审计 MEDIUM：记账与执行隔离——fireViaSubagent 已成功后 updateTaskAfterRun 若抛错
        // （磁盘满/JSON 损坏），落外层 catch 会把已成功的任务记 failed 并可能误触 failover 重启。
        // 记账失败仅记日志，不改任务结果语义（nextRun 停留旧值，下轮 tick 重跑由幂等性兑底）。
        try {
          await updateTaskAfterRun(task.id, 'success', '', Date.now() - startedAt)
        } catch (bookErr) {
          console.error(`[pi-autopilot] 任务 ${task.id} 成功但记账失败: ${bookErr instanceof Error ? bookErr.message : bookErr}`)
        }
        await maybeTriggerSummarizer()
        await appendRun({
          ts: new Date().toISOString(), taskId: task.id, taskName: task.name,
          model, provider, result: 'success', durationMs: Date.now() - startedAt,
          outputLen: 0, estCost: estimateCost(provider, model, task.prompt.length, 0),
          errClass: null,
        })
      } else {
        // 注入式（fireViaMessage）：注入成功 ≠ 主会话执行成功——不记 success、
        // 不发 webhook、不删 once（审计 MEDIUM：此前注入即记 success，主会话实际
        // 失败不回写、notifyOnCompletion 提前发、once 任务在真正执行前就从存储删除）。
        await this.fireViaMessage(task, provider, model)
        await withStoreLock(async () => {
          const store = await readTasks()
          const t = store.tasks.find(x => x.id === task.id)
          if (t) {
            let next = computeNextRun(t)
            if (!next || new Date(next).getTime() <= Date.now()) {
              // once/过期调度：推 1 小时后（与预算拦截分支一致，避免每 tick 重复注入）
              next = new Date(Date.now() + 3600 * 1000).toISOString()
            }
            t.nextRun = next
            await writeTasks(store)
          }
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const exitCode = (err as { exitCode?: number }).exitCode ?? 1
      const outputLen = (err as { outputLen?: number }).outputLen ?? 0
      const errClass = classifyError(message, exitCode)

      await appendRun({
        ts: new Date().toISOString(), taskId: task.id, taskName: task.name,
        model, provider, result: 'failed', durationMs: Date.now() - startedAt,
        outputLen, estCost: estimateCost(provider, model, task.prompt.length, outputLen),
        errClass,
      })

      // 审计 LOW：decide 此前用 fireTask 入参的 failCount 快照，与 updateTaskAfterRun
      // 递增后的存储值差一档（suspendAfter/failoverAfter 阈值晚一拍触发）。决策前从
      // store 重读最新任务；本次失败即将由 updateTaskAfterRun 记账，failCount 预 +1 对齐
      let latest = task
      try {
        const fresh = (await readTasks()).tasks.find(x => x.id === task.id)
        if (fresh) latest = fresh
      } catch { /* 重读失败退回入参快照 */ }
      const action = decide({ ...latest, failCount: (latest.failCount ?? 0) + 1 }, errClass, config.policy, config.fallbackModels, {
        stderr: message,
        exitCode,
        promptLen: task.prompt.length,
        outputLen,
        durationMs: Date.now() - startedAt,
      })

      switch (action.type) {
        case 'retry':
        case 'fail':
          await updateTaskAfterRun(task.id, 'failed', action.note, Date.now() - startedAt)
          break
        case 'failover': {
          const plan = await planFailover(config.fallbackModels, provider, model)
          await updateTaskAfterRun(task.id, 'failed', `failover: ${action.note}`, Date.now() - startedAt)
          if (!plan.target) break
          // 审计 MEDIUM：failover 目标模型须过预算复查——checkBudget 只在 fireTask 入口
          // 校验 currentModel()，此处不复查则 executeFailover 写 set_model 可静默绕过
          // allowedModels / maxCostPerDay。拦截时不切换：任务已记 failed 且 nextRun 已推进，
          // 下次入口检查同样拦截（skipped 防抖已有），连续 failover 另有 failoverCount 熔断。
          if (config.enabled) {
            const fb = await checkBudget(config.budget, plan.target.model)
            if (!fb.allowed) {
              await sendWebhook(task, 'skipped', `failover 目标被预算拦截: ${fb.reason}`)
              break
            }
          }
          // 递增熔断计数：连续 failover 达到 maxFailovers 后 decide() 会熔断为 suspend_task
          await withStoreLock(async () => {
            const store = await readTasks()
            const t = store.tasks.find(x => x.id === task.id)
            if (t) { t.failoverCount = (t.failoverCount ?? 0) + 1; t.updatedAt = isoNow(); await writeTasks(store) }
          })
          await sendWebhook(task, 'failed', `触发 failover → ${plan.target.provider}/${plan.target.model}: ${plan.reason}`)
          const msg = await executeFailover(plan.target, plan.reason, false)
          console.log(`[pi-autopilot] ${msg}`)
          // 设计取舍（审计 MEDIUM 定性）：此处无 UI 确认直接重启——failover 是无人值守自愈手段，
          // headless 下加确认将永不生效；TUI 下用户会被打断但 wrapper 读 set_model restart
          // request 后拉起新实例并 --continue，会话上下文不丢（与 watchdog restart_hang 同路径）。
          // 与 tools.ts admin_set_model 的差异：那是用户主动操作、有对话上下文可弹窗；此处相反。
          try { (this.pi as unknown as { shutdown?: () => void }).shutdown?.() } catch { /* ignore */ }
          // 审计 LOW：exit 前释放会话锁，避免残留至下次启动依赖 PID 死亡检测自愈
          try { await releaseSessionLock() } catch { /* ignore */ }
          process.exit(0)
          break
        }
        case 'suspend_task':
          await updateTask(task.id, { enabled: false })
          await updateTaskAfterRun(task.id, 'failed', action.note, Date.now() - startedAt)
          await sendWebhook(task, 'suspended', action.note)
          break
      }
    } finally {
      this.firing.delete(task.id)
    }
  }

  private async fireViaMessage(task: Task, _provider: string, _model: string): Promise<void> {
    const label = `[Scheduler] ${task.name}`
    touchActivity()
    // 审计 MEDIUM 修复：置位到登记 injectedIds 之间若插入 agent_settled 的
    // clearAllPending，会把刚置位的 pendingInject 清掉（崩溃恢复保护丢失）。
    // 同步守卫集在任何 await 之前登记，agent_settled 据此跳过正在注入的任务。
    this.injectingIds.add(task.id)
    try {
      await markPendingInjected(task.id, true)
      // 注入动作失败（sendUserMessage 不可用/抛错）必须抛错：否则会被记 success 并删除
      // once 任务（updateTaskAfterRun 的 once 分支 splice），提醒任务从未真正交付就消失
      if (!this.pi.sendUserMessage) {
        await clearPending(task.id)
        throw new Error('sendUserMessage 不可用（主会话未挂载），任务注入失败')
      }
      try {
        await this.pi.sendUserMessage(`${label}: ${renderPrompt(task.prompt)}`)
      } catch (e) {
        // 审计 MEDIUM：抛错前 markPendingInjected(true) 已置位——失败必须复位，
        // 否则暂停期 tick 跳过该任务（!pendingInject 过滤）且崩溃恢复会把未交付
        // 任务重注入，停顿一回合且无恢复提示
        await clearPending(task.id)
        throw e
      }
    } finally {
      this.injectingIds.delete(task.id)
    }
    // 注：不在此发 success webhook——注入成功 ≠ 执行成功（审计 MEDIUM 修复），
    // 完成回写由 agent_settled → finalizeInjected 统一处理（commit 补闭环）
    this.injectedIds.add(task.id)
  }

  /** 崩溃恢复重注入旁路（index.ts session_start）登记——与 fireViaMessage 共用 finalizeInjected 闭环 */
  markInjected(taskId: string): void {
    this.injectedIds.add(taskId)
  }

  /** index.ts 在 agent_end 时回写：尾部 assistant stopReason==='aborted' 即为中止回合 */
  markRunAborted(v: boolean): void {
    this.lastRunAborted = v
  }

  /**
   * 注入式任务最终化（主会话回合结束 agent_settled 时调用，补 d323ab9 半闭环）：
   * 注入后 sendUserMessage 返回仅代表消息已发，主会话处理该轮后才视为交付完成。
   * 对每个本轮注入的任务：
   *  - once：updateTaskAfterRun success → 自动 splice 删除（此前每小时重复注入、永不删除）
   *  - interval/cron：回写 lastRun/lastResult、重置 failCount/failoverCount、
   *    nextRun=computeNextRun（覆盖 fireTask 的 +1h 防重入缓冲）
   *  - notifyOnCompletion：与 subagent 路径对齐补发 success webhook
   * 单任务失败不阻塞其余；任务已被删除/改型时 updateTaskAfterRun 内部安全跳过。
   */
  async finalizeInjected(): Promise<void> {
    const ids = [...this.injectedIds]
    this.injectedIds.clear()
    // 实测（2026-08-25）：宿主 finally 无条件发 agent_settled，abort 回合也到达此处。
    // 中止 ≠ 完成：不记 success、不删 once、不发成功 webhook——仅推进 nextRun 防
    // 每 tick 重复注入（同预算拦截语义，不消耗重试次数）；once 保留待手动触发。
    if (this.lastRunAborted) {
      this.lastRunAborted = false
      for (const id of ids) {
        try {
          await withStoreLock(async () => {
            const store = await readTasks()
            const t = store.tasks.find((x) => x.id === id)
            if (!t || !t.enabled) return
            let next = computeNextRun(t)
            if (!next || new Date(next).getTime() <= Date.now()) {
              next = new Date(Date.now() + 3600 * 1000).toISOString()
            }
            t.nextRun = next
            await writeTasks(store)
          })
          if (this.firing.has(id)) this.firing.delete(id)
        } catch { /* 单任务失败忽略 */ }
      }
      return
    }
    for (const id of ids) {
      try {
        const t = (await readTasks()).tasks.find((x) => x.id === id)
        if (!t || !t.enabled) continue
        await updateTaskAfterRun(id, 'success', '注入式任务完成（主会话回合结束回写）', 0)
        await maybeTriggerSummarizer()
        // 审计 MEDIUM：注入式成功此前不写 telemetry——todayRuns/成本预算只统计
        // subagent 与失败运行，注入任务日预算被系统性低估。交付完成即补记成功。
        const { provider, model } = currentModel()
        await appendRun({
          ts: new Date().toISOString(), taskId: id, taskName: t.name,
          model, provider, result: 'success', durationMs: 0,
          outputLen: 0, estCost: estimateCost(provider, model, t.prompt.length, 0),
          errClass: null,
        })
        if (t.notifyOnCompletion) {
          await sendWebhook(t, 'success', '调度任务执行完成（注入式）')
        }
      } catch {
        /* 单任务失败/已删：忽略，不阻塞其余 */
      }
    }
  }

  private async fireViaSubagent(task: Task, provider: string, model: string): Promise<void> {
    // 上下界钳位：负值/0 → setTimeout 立即触发误杀；≥2^31ms → Node 钳位 1ms 同样立即超时
    const raw = task.maxRunTime || 300
    const safe = Math.min(Math.max(raw, 5), 24 * 3600) // 5s ~ 24h
    const timeout = safe * 1000
    const label = `[Scheduler] ${task.name}`
    touchActivity()

    await new Promise<void>((resolve, reject) => {
      const controller = new AbortController()
      // 超时：abort 后补 SIGKILL 兜底——子进程忽略 SIGTERM 时 close 永不触发会永久挂起；
      // 置 timedOut 标志使 close 回调按 exitCode=124 分类（classifyError 的 timeout 分支
      // 依赖 exitCode===124，abort 产生的 code=null 会被误归为 unknown）
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        // 审计 MEDIUM 修复（2026-08-18）：SIGKILL 只杀直接子进程——pi -p 派生出的
        // 孙进程（bash 等）不在同一进程组会孤儿化残留。detached 使子进程成为
        // 进程组组长，-pid 杀整个组；Windows 用 taskkill /T（进程树）
        if (process.platform === 'win32') {
          try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        } else {
          try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* 进程可能已退出 */ } }
        }
      }, timeout)
      const { cmd, args } = resolvePiSpawn()
      const proc = spawn(cmd, [...args, '-p', renderPrompt(task.prompt)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
        cwd: process.cwd(),
        detached: process.platform !== 'win32',
      })
      // 审计 MEDIUM：subagent 长任务心跳——subagent 是独立 pi -p 进程，主会话
      // 无 turn_start 不置 busy 豁免，超长任务（>maxIdleMinutes）会被 isHanging
      // 误判挂死触发重启；每 60s 续活直至子进程结束
      const heartbeat = setInterval(() => touchActivity(), 60_000)
      let stderr = ''
      let stdout = ''
      // 审计 LOW：无界累积——失控子进程输出可耗尽内存；按需截断（与 sendWebhook 1000 对齐）
      const MAX_CAPTURE = 64 * 1024
      proc.stderr.on('data', (data: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += data.toString().slice(0, MAX_CAPTURE - stderr.length) })
      proc.stdout.on('data', (data: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += data.toString().slice(0, MAX_CAPTURE - stdout.length) })
      proc.on('close', async (code) => {
        clearTimeout(timer)
        clearInterval(heartbeat)
        if (code === 0) {
          if (task.notifyOnCompletion) {
            await sendWebhook(task, 'success', stdout.slice(0, 1000))
          }
          // 后台会话任务完成 → 把 stdout 尾部（任务收尾报告）注入主会话（2026-08-24）
          if (task.notifyMain) {
            const tail = stdout.trim().slice(-1500)
            if (tail) {
              try {
                await this.pi.sendUserMessage?.(`[Scheduler] ${task.name} 已完成\n\n${tail}`)
              } catch { /* 主会话不可用时静默 */ }
            }
          }
          resolve()
        } else {
          const err = new Error(stderr.trim() || (timedOut ? `超时（${timeout / 1000}s）` : `exit ${code}`)) as Error & { exitCode?: number; outputLen?: number }
          err.exitCode = timedOut ? 124 : code
          err.outputLen = stdout.length
          reject(err)
        }
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        clearInterval(heartbeat)
        reject(err)
      })
    })
  }
}
