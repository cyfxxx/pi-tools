/**
 * pi-voice — 语音交流扩展（Termux + 本地 Whisper + 系统 TTS）
 *
 * /voice            无参数：切换开始/停止录音并转写
 * /voice start      开始录音
 * /voice stop       停止、转写并处理（autoSend 时直发，否则粘贴输入框）
 * /voice cancel     取消录音（丢弃音频）
 * /voice doctor     诊断录音/转写/朗读依赖
 * /voice model      列出模型；/voice model <名> 切换（重启 whisper 服务）
 * /voice bench      录 5s 测转写速度（RTF）并给换模型建议
 * /tts on|off       开关自动朗读回复（/tts 无参数也切换；状态持久化）
 * /tts speak [文本]  手动朗读（缺省朗读最近一条回复）
 * /tts status       朗读与后端状态
 *
 * 快捷键 Ctrl+Shift+R 等价于 /voice（录音期间再次按即停止转写）；
 * Ctrl+R 为 pi 内置（app.session.rename），不可占用。
 * 听写模式：录音中按回车 = 切段转写 + 自动续录；快捷键/命令停止为正常退出（不续录）。
 * 回车条件拦截依赖核心补丁 scripts/patch-voice-enter.mjs（pi update 后需重跑）。
 *
 * 架构：状态机在 dictation.ts（纯逻辑，可单测）；本文件只做命令/快捷键/
 * 事件注册与 UI 接线（notify/setStatus/pasteToEditor/sendUserMessage）。
 * 隐私：录音文件转写后立即删除（即用即弃），启动与退出时清理残留。
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { Key } from '@earendil-works/pi-tui'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { loadConfig, persistConfig, type VoiceConfig } from './config'
import { createDictation } from './dictation'
import type { Dictation, StopResult } from './dictation'
import {
  startRecording,
  stopRecording,
  convertToWav,
  transcribe,
  deleteAudioPair,
  fileExists,
  cleanupStaleAudio,
  speak,
  extractAssistantText,
  isSpeechWorthy,
  doctor,
  benchmark,
  runCommand,
} from './core'

let lastAssistantText = ''
let lastAutoDictation = ''
let ttsEnabled: boolean
let dictation: Dictation

/** 可用 whisper 模型（faster-whisper）与设备说明 */
const WHISPER_MODELS: Record<string, string> = {
  tiny: '最快，准确率一般',
  base: '默认，速度/准确率均衡',
  small: '更准，速度较慢',
  medium: '准确，手机 CPU 较慢',
  'large-v3': '最准，手机 CPU 极慢，不推荐',
}

const ENTER_PATCH_MARKER = 'Patch (patch-voice-enter.mjs)'

/**
 * 探测核心补丁是否已应用（scripts/patch-voice-enter.mjs）。
 * 未打补丁时 onExtensionShortcut 对匹配按键"无条件消费"：
 * 注册 Key.enter 会吞掉全部回车（输入提交/菜单选择失效），
 * 故必须仅在补丁已应用时才注册 enter 快捷键。
 * 探测失败（无法定位 dist）视为未打补丁，宁可禁用听写也不吞回车。
 */
function enterPatchApplied(): boolean {
  try {
    const known =
      '/root/.local/share/pi-node/node-v22.23.1-linux-arm64/lib/node_modules/@earendil-works/pi-coding-agent/dist'
    const dist = existsSync(join(known, 'modes', 'interactive', 'interactive-mode.js'))
      ? known
      : detectDistFromPath(process.env.PI_DIST)
    const target = join(dist, 'modes', 'interactive', 'interactive-mode.js')
    if (!existsSync(target)) return false
    return readFileSync(target, 'utf-8').includes(ENTER_PATCH_MARKER)
  } catch {
    return false
  }
}

function detectDistFromPath(explicit?: string): string {
  if (explicit && existsSync(join(explicit, 'modes', 'interactive', 'interactive-mode.js'))) return explicit
  try {
    const bin = execFileSync('which', ['pi'], { encoding: 'utf-8' }).trim()
    if (bin) {
      const resolved = execFileSync('readlink', ['-f', bin], { encoding: 'utf-8' }).trim()
      const m = resolved.match(/(.*node_modules\/@earendil-works\/pi-coding-agent\/)/)
      if (m && existsSync(join(m[1], 'dist', 'modes', 'interactive', 'interactive-mode.js'))) return join(m[1], 'dist')
    }
  } catch {
    // fall through
  }
  return '/nonexistent'
}

export default function (pi: ExtensionAPI): void {
  const config = loadConfig()
  ttsEnabled = config.ttsEnabled
  // 启动即清理超过 24h 的残留录音文件（隐私：不长期留存音频）
  cleanupStaleAudio(config)
  // 清理重启/崩溃遗留的孤儿录音进程（幂等：无录音时 -q 输出 No recording to stop 且 exit 0），
  // 否则 termux-microphone-record 单实例占用会导致“只能开不能关”
  void stopRecording(config).catch(() => undefined)

  dictation = createDictation(
    config,
    { startRecording, stopRecording, convertToWav, transcribe, deleteAudioPair, fileExists },
    {
      // 录音进程自行退出（超时/启动失败）的自动完成：无调用方 UI 上下文，
      // 有文本时 autoSend 直发，否则暂存供查询；失败/无文本时也要展示原因，绝不静默。
      onAutoComplete: (r) => {
        if (r.text) {
          lastAutoDictation = r.text
          if (config.autoSend) pi.sendUserMessage(r.text, { deliverAs: 'steer' })
        } else if (r.message) {
          lastAutoDictation = ''
          pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: r.message, display: true })
        }
      },
    },
  )

  pi.registerCommand('voice', {
    description: '语音输入：开始/停止录音并转写',
    handler: async (args, ctx) => {
      const cmd = args.trim()
      if (cmd === 'start') {
        withStatus(pi, ctx, dictation.start())
      } else if (cmd === 'stop') {
        const r = await dictation.stop()
        deliverResult(pi, ctx, r)
      } else if (cmd === 'cancel') {
        withStatus(pi, ctx, dictation.cancel())
      } else if (cmd === 'doctor') {
        await cmdDoctor(pi, ctx, config)
      } else if (cmd === 'model' || cmd.startsWith('model ')) {
        await cmdModel(pi, ctx, config, cmd === 'model' ? '' : cmd.slice('model '.length).trim())
      } else if (cmd === 'bench') {
        await cmdBench(pi, ctx, config)
      } else if (dictation.isRecording()) {
        await stopAndDeliver(pi, ctx, false)
      } else {
        withStatus(pi, ctx, dictation.start())
      }
    },
  })

  pi.registerCommand('tts', {
    description: '语音朗读：on/off/status/speak [文本]',
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/)
      switch (cmd) {
        case 'on':
          setTts(pi, ctx, true)
          break
        case 'off':
          setTts(pi, ctx, false)
          break
        case 'status':
          reply(pi, `TTS ${ttsEnabled ? '开启' : '关闭'}；最近回复 ${lastAssistantText ? `${lastAssistantText.length} 字符` : '无'}；自动转写暂存 ${lastAutoDictation ? '有' : '无'}；转写服务 ${await whisperStatus(config)}`)
          break
        case 'speak': {
          const text = rest.join(' ') || lastAssistantText
          if (!text) {
            reply(pi, '暂无朗读内容')
            break
          }
          const res = await speak(config, text)
          reply(pi, res.code === 0 ? '已朗读' : `朗读失败: ${res.stderr}`)
          break
        }
        default:
          setTts(pi, ctx, !ttsEnabled)
      }
    },
  })

  const toggleRecording = (ctx: ExtensionContext): void => {
    if (dictation.isRecording() || dictation.isTranscribing()) {
      void stopAndDeliver(pi, ctx, false)
    } else {
      withStatus(pi, ctx, dictation.start())
    }
  }

  // 主快捷键 Ctrl+Shift+R；Ctrl+Alt+R 为备选（Android 软键盘无 Shift 键时仍可按键）
  pi.registerShortcut(Key.ctrlShift('r'), {
    description: '语音录制/停止转写',
    handler: toggleRecording,
  })
  pi.registerShortcut(Key.ctrlAlt('r'), {
    description: '语音录制/停止转写（备选，软键盘可用）',
    handler: toggleRecording,
  })

  // 听写模式：录音中按回车 = 结束当前段并转写，完成后自动续录；
  // 未录音/转写中返回 false 放行（依赖核心补丁 patch-voice-enter.mjs，否则 enter 被无条件拦截）。
  // 类型断言：核心补丁读取运行时返回值 false，ts 类型仅允许 void | Promise<void>。
  // 未检测到补丁时不注册：避免吞掉所有回车（输入提交/菜单选择失效）。
  const enterReady = enterPatchApplied()
  if (enterReady) {
    pi.registerShortcut(Key.enter, {
      description: '录音中回车：切段转写并自动续录',
      handler: ((ctx: ExtensionContext) => {
        if (!dictation.isRecording()) return false
        ctx.ui.setStatus('pi-voice', '⚙ 转写中…')
        void dictation.stop().then((r) => {
          deliverResult(pi, ctx, r, true)
          // 转写成功才自动续录（失败不进入死循环）；续录静默，仅状态条提示
          if (r.text && !dictation.isTranscribing()) {
            const m = dictation.start()
            if (m.startsWith('🎤')) {
              ctx.ui.setStatus('pi-voice', '🎤 录音中')
            } else {
              reply(pi, m)
            }
          }
        }).catch(() => {})
        return true
      }) as (ctx: ExtensionContext) => void,
    })
  } else {
    reply(pi, '⚠ 回车快速听写未启用：核心补丁未检测到。请执行：node ~/.pi/scripts/patch-voice-enter.mjs（其他语音功能不受影响）')
  }

  // 自动朗读 assistant 回复（仅最终回复的文本部分，异步不阻塞）
  // 中间轮（stopReason=toolUse）与 JSON/结构化摘要不朗读，避免语音轰炸与朗读垃圾内容
  pi.on('message_end', (event) => {
    if (!ttsEnabled) return
    const msg = event?.message
    if (!msg || msg.role !== 'assistant') return
    if (msg.stopReason !== 'stop') return
    const text = extractAssistantText(msg.content)
    if (!text || !isSpeechWorthy(text)) return
    lastAssistantText = text
    void speak(config, text).catch(() => {})
  })

  // 退出/重载时清理录音进程与残留文件（隐私兜底）
  pi.on('session_shutdown', () => {
    dictation.cleanup()
    cleanupStaleAudio(config)
  })
}

const OUTPUT_CUSTOM_TYPE = 'cmd-output'

function reply(api: ExtensionAPI, text: string): void {
  api.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: text, display: true })
}

function withStatus(api: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (message.startsWith('🎤')) {
    ctx.ui.setStatus('pi-voice', '🎤 录音中')
  } else {
    ctx.ui.setStatus('pi-voice', undefined)
  }
  reply(api, message)
}

/** 停止录音并转写：先显示转写中提示，完成后交付。 */
async function stopAndDeliver(pi: ExtensionAPI, ctx: ExtensionContext, dictating: boolean): Promise<void> {
  if (dictation.isRecording()) ctx.ui.setStatus('pi-voice', '⚙ 转写中…')
  const r = await dictation.stop()
  deliverResult(pi, ctx, r, dictating)
}

/**
 * 转写结果交付：autoSend 直发，否则粘贴输入框供确认；不落盘音频。
 * dictating（听写模式）时无论 autoSend 一律粘贴输入框（逐段累积、统一修改后发送），
 * 且成功不 reply（避免每段刷屏），失败仍提示。
 */
function deliverResult(pi: ExtensionAPI, ctx: ExtensionContext, r: StopResult, dictating = false): void {
  const cfg = loadConfig()
  if (r.text && !dictating) {
    if (cfg.autoSend) {
      pi.sendUserMessage(r.text, { deliverAs: 'steer' })
      ctx.ui.notify('已发送语音指令')
      reply(pi, `已发送：${r.text}`)
      return
    }
    ctx.ui.setStatus('pi-voice', undefined)
    ctx.ui.pasteToEditor(r.text + ' ')
    if (dictating) {
      ctx.ui.notify('已插入输入框，可继续口述')
    } else {
      ctx.ui.notify('转写完成，已插入输入框')
    }
  } else {
    ctx.ui.setStatus('pi-voice', undefined)
  }
  if (!dictating || !r.text) reply(pi, r.message)
}

function setTts(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  ttsEnabled = enabled
  try {
    persistConfig({ ttsEnabled }, process.env)
  } catch {
    // 持久化失败不阻塞开关
  }
  ctx.ui.notify(`TTS ${enabled ? '已开启' : '已关闭'}`)
  reply(pi, `TTS ${enabled ? '已开启' : '已关闭'}`)
}

async function cmdDoctor(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig): Promise<void> {
  const lines = await doctor(config)
  ctx.ui.setStatus('pi-voice', undefined)
  reply(api, lines.join('\n'))
}

/** /voice model [name]：列出或切换 whisper 模型（切换需重启服务，加载耗时）。 */
async function cmdModel(
  api: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: VoiceConfig,
  want: string,
): Promise<void> {
  if (want === '') {
    const current = await whisperModel(config)
    const list = Object.entries(WHISPER_MODELS)
      .map(([name, note]) => `  ${name}${name === config.whisperModel ? '（当前）' : ''} — ${note}`)
      .join('\n')
    reply(api, `当前模型：${config.whisperModel}（服务端实际：${current ?? '不可达'}）\n可用模型：\n${list}\n切换：/voice model <名称>`)
    return
  }
  if (!(want in WHISPER_MODELS)) {
    reply(api, `未知模型：${want}。可用：${Object.keys(WHISPER_MODELS).join(' / ')}`)
    return
  }
  if (want === config.whisperModel) {
    reply(api, `已在使用模型 ${want}`)
    return
  }
  if (dictation.isRecording() || dictation.isTranscribing()) {
    reply(api, '请先停止录音/等待转写完成再切换模型')
    return
  }
  try {
    persistConfig({ whisperModel: want }, process.env)
  } catch (e) {
    reply(api, `配置写入失败：${(e as Error).message}`)
    return
  }
  ctx.ui.setStatus('pi-voice', '⚙ 切换模型并重启服务…')
  reply(api, `正在切换到 ${want}（首次使用需下载模型，可能耗时较长）…`)
  const res = await runCommand('bash', [join(homedir(), '.pi', 'scripts', 'pi-whisper.sh'), 'restart'], { timeoutMs: 120000 })
  ctx.ui.setStatus('pi-voice', undefined)
  if (res.code !== 0) {
    reply(api, `服务重启命令失败：${res.stderr || res.stdout}`)
    return
  }
  // 轮询 health 直到新模型加载完成（最多 120s）
  const deadline = Date.now() + 120000
  let ok = false
  while (Date.now() < deadline) {
    const m = await whisperModel(config)
    if (m === want) {
      ok = true
      break
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  reply(api, ok ? `模型已切换为 ${want}，服务就绪` : `模型切换中（服务加载较慢），可用 /voice doctor 查看状态`)
}

/** /voice bench：录 5s 音频测转写速度，输出 RTF 与换模型建议。 */
async function cmdBench(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig): Promise<void> {
  if (dictation.isRecording() || dictation.isTranscribing()) {
    reply(api, '请先停止录音/等待转写完成再测试')
    return
  }
  ctx.ui.setStatus('pi-voice', '🎙 基准测试中（录音 5 秒）')
  reply(api, `基准测试开始（模型 ${config.whisperModel}）：请对麦克风正常说话 5 秒…`)
  const r = await benchmark(config)
  ctx.ui.setStatus('pi-voice', undefined)
  reply(api, r.lines.join('\n'))
}

async function whisperModel(cfg: VoiceConfig): Promise<string | null> {
  try {
    const headers: Record<string, string> = {}
    if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
    const res = await fetch(`${cfg.whisperEndpoint}/health`, { headers, signal: AbortSignal.timeout(3000) })
    const data = (await res.json()) as { ok?: boolean; model?: string }
    return data.ok ? (data.model ?? null) : null
  } catch {
    return null
  }
}

async function whisperStatus(cfg: VoiceConfig): Promise<string> {
  try {
    const headers: Record<string, string> = {}
    if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
    const res = await fetch(`${cfg.whisperEndpoint}/health`, { headers, signal: AbortSignal.timeout(3000) })
    const data = (await res.json()) as { ok?: boolean }
    return data.ok ? '运行中' : '启动中'
  } catch {
    return '不可达（运行 ~/.pi/scripts/pi-whisper.sh start）'
  }
}