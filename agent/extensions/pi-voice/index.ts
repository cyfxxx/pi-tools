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
 * /tts speak [文本]  手动朗读（缺省朗读最近一条回复；JSON 等结构化内容会过滤并提示）
 * /tts status       朗读与后端状态
 *
 * 架构：状态机在 dictation.ts（纯逻辑，可单测）；本文件只做命令/快捷键/
 * 事件注册与 UI 接线（notify/setStatus/pasteToEditor/sendUserMessage）。
 *
 * TTS 自动朗读语义（2026-08 起）：
 * - 默认关闭（非语音状态不朗读），持久化 ttsEnabled=false
 * - 语音输入（录音转写直发/听写发送）后自动开启朗读，形成语音对话闭环
 * - 键盘输入自动关闭朗读；仅"自动模式"下才自动切换，手动 /tts on|off 后不再自动切换
 * - 只朗读最终回复（stopReason=stop），且过滤 JSON/结构化摘要
 * - 串行队列：同时只保留一条待读文本（新文本替换旧的），一次只朗读一条
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { Key } from '@earendil-works/pi-tui'
import { loadConfig, persistConfig, type VoiceConfig } from './config'
import { createDictation } from './dictation'
import type { Dictation, StopResult } from './dictation'
import {
  startRecording,
  stopRecording,
  convertToWav,
  transcribe,
  transcribeByBackend,
  prewarmStt,
  createWakeSession,
  deleteAudioPair,
  waitForFileStable,
  cleanupStaleAudio,
  speak,
  extractAssistantText,
  isSpeechWorthy,
  doctor,
  benchmark,
  runCommand,
  detectAudioLevel,
  queryRecording,
  fileExists,
  createTtsDispatcher,
  type TtsDispatcher,
  type WakeSession,
} from './core'
import { platformOf, gpuSwitchBlockReason } from './core'
import {
  detectIsTermux,
  enterPatchApplied,
  reply,
  OUTPUT_CUSTOM_TYPE,
  ENTER_DEBOUNCE_MS,
  WHISPER_MODELS,
} from './helpers'
import { whisperModel, whisperDevice, whisperStatus } from './whisper'

let config: VoiceConfig
let lastAssistantText = ''
let lastAutoDictation = ''
let lastCtx: ExtensionContext | null = null
let ttsEnabled: boolean
let ttsManual = false
let lastEnterAt = 0
let awaitingResume = false
let dictation: Dictation
let ttsQueue: TtsDispatcher
let wakeSession: WakeSession | null = null
let enterPatchMissing = false

const VOICE_USAGE = [
  '/voice                    录音中则停止转写，否则开始录音',
  '/voice start              开始录音',
  '/voice stop               停止录音并转写（不自动续录）',
  '/voice cancel             取消录音并丢弃音频',
  '/voice tts <on|off>       开关自动朗读回复',
  '/voice tts status         查看朗读/转写状态',
  '/voice tts speak [文本]   手动朗读（缺省朗读最近回复）',
  '/voice backend [whisper|sherpa]  查看/切换转写后端（sherpa = SenseVoice 端侧模型）',
  '/voice wake <on|off|status|auto>  唤醒监听（说"开启语音输入"开始录音；auto 控制启动自动监听）',
  '/voice model [名称]      查看/切换 whisper 模型',
  '/voice device [cpu|gpu|auto]  查看/切换推理设备（GPU 被占用时切 cpu）',
  '/voice doctor             诊断录音/转写/朗读依赖',
  '/voice bench              录 5 秒测转写速度',
  '/voice help               显示本帮助',
  '（Tab 补全：/voice + 两次 Tab 显示子命令；子命令随输入过滤，如 tts s → status）',
  '（录音中按回车 = 切段转写并自动续录）',
].join('\n')

export default function (pi: ExtensionAPI): void {
  config = loadConfig()

  if (config.platform === 'termux' || (config.platform === 'auto' && detectIsTermux())) {
    return
  }

  ttsEnabled = config.ttsEnabled
  cleanupStaleAudio(config, 5_000)
  void stopRecording(config).catch(() => undefined)
  for (const pat of platformOf(config).tts.zombiePatterns()) {
    void runCommand('pkill', ['-x', pat], { timeoutMs: 5000 }).catch(() => undefined)
  }

  ttsQueue = createTtsDispatcher({
    speakFn: (text) => speak(config, text),
    onError: (message) => {
      pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `⚠ 朗读失败：${message}`, display: true })
    },
  })

  const spec = platformOf(config)
  dictation = createDictation(
    config,
    {
      startRecording, stopRecording, queryRecording, fileExists, convertToWav, transcribe: transcribeByBackend, deleteAudioPair, waitForFileStable,
      detectAudioLevel: (wav) => detectAudioLevel(wav, config.ffmpegBin),
      micLabel: spec.recorder.micLabel,
      micInstallHint: spec.recorder.installHint,
      micPermissionHint: spec.recorder.permissionHint,
    },
    {
      onAutoComplete: (r) => {
        if (r.text) {
          lastAutoDictation = r.text
          const head =
            r.autoReason === 'exit'
              ? `⚠️ 录音异常提前结束（${r.autoSec ?? '?'}s），已自动转写`
              : '⏰ 已达录音时长上限，已自动转写'
          if (config.autoSend) {
            pi.sendUserMessage(r.text, { deliverAs: 'steer' })
            pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `${head}并发送：${r.text}`, display: true })
          } else if (lastCtx) {
            lastCtx.ui.setStatus('pi-voice', undefined)
            lastCtx.ui.pasteToEditor(r.text + ' ')
            lastCtx.ui.notify(`${head}，已插入输入框`, 'info')
          } else {
            pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `${head}（暂存，可 /voice tts speak 朗读）：${r.text}`, display: true })
          }
        } else if (r.message) {
          lastAutoDictation = ''
          lastCtx?.ui.setStatus('pi-voice', undefined)
          pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: r.message, display: true })
        }
      },
      onReady: () => {
        if (dictation.isRecording()) lastCtx?.ui.setStatus('pi-voice', '🎤 录音中')
      },
    },
  )

  pi.registerCommand('voice', {
    description: '语音：录音转写与朗读（/voice help 查看用法）',
    getArgumentCompletions: (prefix) => {
      const first = (prefix.trim().split(/\s+/)[0] ?? '').toLowerCase()
      const pick = (items: { value: string; label: string; description: string }[]) => {
        const t = prefix.trim()
        return items.filter((i) => i.value.startsWith(t) && i.value !== t)
      }
      if (first === 'tts') {
        return pick([
          { value: 'tts on', label: 'tts on', description: '开启自动朗读' },
          { value: 'tts off', label: 'tts off', description: '关闭自动朗读' },
          { value: 'tts status', label: 'tts status', description: '查看朗读/转写状态' },
        ])
      }
      if (first === 'model') {
        return pick(
          Object.entries(WHISPER_MODELS).map(([name, desc]) => ({
            value: `model ${name}`,
            label: `model ${name}`,
            description: desc,
          })),
        )
      }
      if (first === 'device') {
        return pick([
          { value: 'device cpu', label: 'device cpu', description: 'CPU 推理（GPU 被占用时稳定）' },
          { value: 'device gpu', label: 'device gpu', description: 'NVIDIA GPU 推理' },
          { value: 'device auto', label: 'device auto', description: '自动检测（默认）' },
        ])
      }
      if (first === 'backend') {
        return pick([
          { value: 'backend whisper', label: 'backend whisper', description: 'whisper（faster-whisper，默认）' },
          { value: 'backend sherpa', label: 'backend sherpa', description: 'sherpa（SenseVoice 端侧）' },
        ])
      }
      if (first === 'wake') {
        return pick([
          { value: 'wake on', label: 'wake on', description: '开启唤醒监听（Linux）' },
          { value: 'wake off', label: 'wake off', description: '停止监听' },
          { value: 'wake status', label: 'wake status', description: '查看监听状态' },
          { value: 'wake auto', label: 'wake auto', description: '自动监听开关（启动 pi 后后台监听）' },
          { value: 'wake auto on', label: 'wake auto on', description: '开启自动监听（持久）' },
          { value: 'wake auto off', label: 'wake auto off', description: '关闭自动监听（持久）' },
        ])
      }
      return pick([
        { value: 'start', label: 'start', description: '开始录音' },
        { value: 'stop', label: 'stop', description: '停止录音并转写' },
        { value: 'cancel', label: 'cancel', description: '取消录音并丢弃音频' },
        { value: 'tts', label: 'tts', description: '朗读：on/off/status/speak' },
        { value: 'doctor', label: 'doctor', description: '诊断依赖' },
        { value: 'backend', label: 'backend', description: '查看/切换转写后端' },
        { value: 'wake', label: 'wake', description: '唤醒监听（Linux）' },
        { value: 'model', label: 'model', description: '查看/切换 whisper 模型' },
        { value: 'device', label: 'device', description: '查看/切换推理设备' },
        { value: 'bench', label: 'bench', description: '转写速度基准' },
        { value: 'help', label: 'help', description: '显示用法' },
      ])
    },
    handler: async (args, ctx) => {
      maybeWarnEnterPatch(pi)
      const [cmd, ...rest] = args.trim().split(/\s+/)
      switch (cmd) {
        case '':
          if (dictation.isRecording()) {
            await stopAndDeliver(pi, ctx, false)
          } else {
            void prewarmStt(config).catch(() => {})
            withStatusLocal(pi, ctx, dictation.start())
          }
          break
        case 'start':
          awaitingResume = false
          void prewarmStt(config).catch(() => {})
          withStatusLocal(pi, ctx, dictation.start())
          break
        case 'stop': {
          awaitingResume = false
          if (dictation.isRecording()) ctx.ui.setStatus('pi-voice', '⚙ 转写中…')
          const r = await dictation.stop()
          deliverResult(pi, ctx, r)
          break
        }
        case 'cancel':
          awaitingResume = false
          withStatusLocal(pi, ctx, dictation.cancel())
          break
        case 'tts': {
          const [sub, ...subRest] = rest
          switch (sub) {
            case 'on':
              setTts(pi, ctx, true)
              break
            case 'off':
              setTts(pi, ctx, false)
              break
            case 'status':
              reply(pi, `TTS ${ttsEnabled ? '开启' : '关闭'}${ttsManual ? '（手动）' : '（自动）'}；朗读队列 ${ttsQueue.pendingCount()} 待读${ttsQueue.isSpeaking() ? ' + 朗读中' : ''}；最近回复 ${lastAssistantText ? `${lastAssistantText.length} 字符` : '无'}；自动转写暂存 ${lastAutoDictation ? '有' : '无'}；转写服务 ${await whisperStatus(config)}`)
              break
            case 'speak': {
              const text = subRest.join(' ') || lastAssistantText
              if (!text) {
                reply(pi, '暂无朗读内容')
                break
              }
              if (!isSpeechWorthy(text)) {
                reply(pi, '内容为结构化数据（JSON/纯符号），已跳过朗读')
                break
              }
              ttsQueue.enqueue(text)
              reply(pi, '已加入朗读队列')
              break
            }
            default:
              reply(pi, sub
                ? `未知子命令: /voice tts ${sub}\n用法: /voice tts <on|off|status|speak [文本]>`
                : `用法: /voice tts <on|off|status|speak [文本]>（当前 TTS ${ttsEnabled ? '开启' : '关闭'}）`)
          }
          break
        }
        case 'doctor': {
          const lines = await doctor(config)
          ctx.ui.setStatus('pi-voice', undefined)
          reply(pi, lines.join('\n'))
          break
        }
        case 'backend': {
          const name = rest.join(' ').trim().toLowerCase()
          if (name === 'whisper' || name === 'sherpa') {
            if (name === config.sttBackend) {
              reply(pi, `转写后端已是 ${name === 'sherpa' ? 'sherpa（SenseVoice）' : 'whisper（faster-whisper）'}`)
              break
            }
            config.sttBackend = name
            try { persistConfig({ sttBackend: name }, process.env) } catch {}
            reply(pi, `转写后端已切换为 ${name === 'sherpa' ? 'sherpa（SenseVoice 端侧模型）' : 'whisper（faster-whisper）'}，下次录音转写生效。${name === 'sherpa' ? '\n提示：首次使用会自动拉起 sherpa 服务（端口 18768）；可 /voice doctor 检查两后端就绪状态。' : ''}`)
          } else if (name) {
            reply(pi, `未知后端: ${name}（可用 whisper | sherpa）`)
          } else {
            const cur = config.sttBackend
            ctx.ui.setStatus('pi-voice', undefined)
            reply(pi, `当前转写后端：${cur === 'sherpa' ? 'sherpa（SenseVoice 端侧模型）' : 'whisper（faster-whisper）'}\n切换：/voice backend whisper|sherpa\n说明：默认 whisper（行为不变）；sherpa 用端侧 SenseVoice，中文准确率更高、CPU 更快。\n两后端就绪状态用 /voice doctor 查看。`)
          }
          break
        }
        case 'wake':
          await cmdWake(pi, ctx, config, rest.join(' '))
          break
        case 'model':
          await cmdModel(pi, ctx, config, rest.join(' '))
          break
        case 'device':
          await cmdDevice(pi, ctx, config, rest.join(' '))
          break
        case 'bench': {
          if (dictation.isRecording() || dictation.isTranscribing()) {
            reply(pi, '请先停止录音/等待转写完成再测试')
            break
          }
          ctx.ui.setStatus('pi-voice', '🎙 基准测试中（录音 5 秒）')
          reply(pi, `基准测试开始（模型 ${config.whisperModel}）：请对麦克风正常说话 5 秒…`)
          const r = await benchmark(config)
          ctx.ui.setStatus('pi-voice', undefined)
          reply(pi, r.lines.join('\n'))
          break
        }
        case 'help':
        case '-h':
        case '--help':
          reply(pi, VOICE_USAGE)
          break
        default:
          reply(pi, `未知子命令: /voice ${cmd}\n\n${VOICE_USAGE}`)
      }
    },
  })

  const toggleRecording = (ctx: ExtensionContext): void => {
    maybeWarnEnterPatch(pi)
    if (dictation.isRecording() || dictation.isTranscribing()) {
      awaitingResume = false
      void stopAndDeliver(pi, ctx, false).catch((e) => console.warn('[pi-voice] 停止转写失败:', (e as Error)?.message ?? e))
    } else {
      awaitingResume = false
      void prewarmStt(config).catch(() => {})
      withStatusLocal(pi, ctx, dictation.start())
    }
  }

  pi.registerShortcut(Key.ctrlAlt('r'), {
    description: '语音录制/停止转写（备选，软键盘可用）',
    handler: toggleRecording,
  })

  const enterReady = enterPatchApplied()
  if (enterReady) {
    const enterTapHandler = ((ctx: ExtensionContext) => {
      if (!dictation.isRecording()) {
        if (dictation.isTranscribing()) {
          ctx.ui.notify('录音已达时长上限，自动转写中…', 'warning')
          return true
        }
        if (awaitingResume) {
          const hasContent = (ctx.ui.getEditorText() ?? '').trim() !== ''
          if (!hasContent) {
            awaitingResume = false
            const m = dictation.start()
            if (m.startsWith('🎤')) {
              ctx.ui.setStatus('pi-voice', '⏳ 启动麦克风中…')
            } else {
              reply(pi, m)
            }
            return true
          }
          return false
        }
        return false
      }
      const now = Date.now()
      if (now - lastEnterAt < ENTER_DEBOUNCE_MS) return true
      lastEnterAt = now
      if (dictation.isTranscribing()) {
        ctx.ui.notify('正在转写中，请稍候…', 'warning')
        return true
      }
      ctx.ui.setStatus('pi-voice', '⚙ 转写中…')
      void dictation.stop().then((r) => {
        deliverResult(pi, ctx, r, true)
        if (r.text && !dictation.isTranscribing()) {
          awaitingResume = true
        }
      }).catch(() => {})
      return true
    }) as (ctx: ExtensionContext) => void
    pi.registerShortcut(Key.return, {
      description: '录音中回车：切段转写并自动续录',
      handler: enterTapHandler,
    })
    pi.registerShortcut(Key.shift('enter'), {
      description: '录音中回车（ICRNL/Kitty 路径）：切段转写并自动续录',
      handler: enterTapHandler,
    })
  } else {
    enterPatchMissing = true
  }

  pi.on('input', (event, ctx) => {
    lastCtx = ctx
    if (event.source === 'interactive') {
      if (!ttsManual && ttsEnabled) autoSetTts(false)
      if (dictation.isRecording() || dictation.isTranscribing()) {
        pi.sendMessage({
          customType: OUTPUT_CUSTOM_TYPE,
          content: dictation.isTranscribing() ? '正在转写中，请稍候（按 Ctrl+Alt+R 可查看状态）' : '正在录音中，请先停止录音（Ctrl+Alt+R）再输入文字',
          display: true,
        })
        return { action: 'handled' }
      }
    }
    return { action: 'continue' }
  })

  pi.on('message_end', (event, ctx) => {
    lastCtx = ctx
    const msg = event?.message
    if (!msg || msg.role !== 'assistant') return
    if (msg.stopReason !== 'stop') return
    const text = extractAssistantText(msg.content)
    if (!text || !isSpeechWorthy(text)) return
    lastAssistantText = text
    if (!ttsEnabled) return
    ttsQueue.enqueue(text)
  })

  pi.on('session_shutdown', () => {
    dictation.cleanup()
    wakeSession?.stop()
    wakeSession = null
    cleanupStaleAudio(config, 5_000)
  })

  if (config.autoWake) {
    pi.on('session_start', () => {
      void launchWakeSession(pi, null, config)
    })
  }
}

// ── Local helpers ──

function maybeWarnEnterPatch(api: ExtensionAPI): void {
  if (enterPatchMissing) {
    enterPatchMissing = false
    reply(api, '⚠ 回车快速听写未启用：核心补丁未检测到。请执行：node ~/.pi/scripts/patch-voice-enter.mjs（其他语音功能不受影响）')
  }
}

function withStatusLocal(api: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  lastCtx = ctx
  if (message.startsWith('🎤')) {
    ctx.ui.setStatus('pi-voice', '⏳ 启动麦克风中…')
    autoSetTts(true)
  } else {
    ctx.ui.setStatus('pi-voice', undefined)
  }
  reply(api, message)
}

async function stopAndDeliver(pi: ExtensionAPI, ctx: ExtensionContext, dictating: boolean): Promise<void> {
  if (dictation.isRecording()) ctx.ui.setStatus('pi-voice', '⚙ 转写中…')
  const r = await dictation.stop()
  deliverResult(pi, ctx, r, dictating)
}

function deliverResult(pi: ExtensionAPI, ctx: ExtensionContext, r: StopResult, dictating = false): void {
  ctx.ui.setStatus('pi-voice', undefined)
  if (!r.text) {
    if (r.busy) {
      ctx.ui.notify(r.message || '正在转写，请稍候', 'info')
      return
    }
    if (r.message && r.message.includes('未在录音')) {
      ctx.ui.notify(r.message, 'info')
      return
    }
    if (r.message && (r.message.includes('未检测到声音信号') || r.message.includes('未识别到语音内容'))) {
      ctx.ui.notify(r.message, 'info')
      reply(pi, r.message)
      return
    }
    ctx.ui.notify('语音转写失败', 'error')
    reply(pi, r.message)
    return
  }
  if (dictating) {
    ctx.ui.pasteToEditor(r.text + ' ')
    ctx.ui.notify('已插入输入框，按回车开始下一段')
    return
  }
  if (config.autoSend) {
    pi.sendUserMessage(r.text, { deliverAs: 'steer' })
    ctx.ui.notify('已发送语音指令')
    reply(pi, `已发送：${r.text}`)
    autoSetTts(true)
    return
  }
  ctx.ui.pasteToEditor(r.text + ' ')
  ctx.ui.notify('转写完成，已插入输入框')
}

function autoSetTts(enabled: boolean): void {
  if (ttsManual || ttsEnabled === enabled) return
  ttsEnabled = enabled
}

function setTts(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  ttsManual = true
  ttsEnabled = enabled
  try { persistConfig({ ttsEnabled }, process.env) } catch {}
  ctx.ui.notify(`TTS ${enabled ? '已开启' : '已关闭'}（手动，不再自动切换）`)
  reply(pi, `TTS ${enabled ? '已开启' : '已关闭'}（手动，不再自动切换）`)
}

async function cmdWake(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig, want: string): Promise<void> {
  const arg = want.trim().toLowerCase()
  if (arg === 'auto' || arg.startsWith('auto ')) {
    const sub = arg === 'auto' ? '' : arg.slice(5).trim()
    if (sub === '') {
      reply(api, `自动监听（启动 pi 后在后台运行唤醒）：${config.autoWake ? '已开启' : '已关闭'}；${wakeSession?.isRunning() ? '当前正在监听' : '当前未监听'}\n开启：/voice wake auto on；关闭：/voice wake auto off（持久）或 /voice wake off（仅本次）`)
      return
    }
    if (sub === 'on') {
      let warn = ''
      try { persistConfig({ autoWake: true }, process.env) } catch { warn = '\n⚠ 配置写入失败：本次已开启，但下次启动 pi 不会自动监听' }
      if (wakeSession?.isRunning()) {
        reply(api, `自动监听已开启（已在监听中）${warn}`)
      } else {
        reply(api, `自动监听已开启，正在启动监听…${warn}`)
        await launchWakeSession(api, ctx, config)
      }
      return
    }
    if (sub === 'off') {
      let warn = ''
      try { persistConfig({ autoWake: false }, process.env) } catch { warn = '\n⚠ 配置写入失败：本次已关闭，但下次启动仍按旧配置自动监听' }
      stopWakeSessionLocal(api, ctx)
      reply(api, `自动监听已关闭（下次启动 pi 不再自动监听）${warn}`)
      return
    }
    reply(api, `用法：/voice wake auto <on|off>`)
    return
  }
  if (arg === 'off') { stopWakeSessionLocal(api, ctx); return }
  if (arg === 'status' || arg === '') {
    reply(api, wakeSession?.isRunning()
      ? `唤醒监听中，已命中唤醒词 ${wakeSession.hits()} 次（说"开启语音输入"开始录音；/voice wake off 停止）`
      : `唤醒监听未启用（可用 /voice wake on）${config.autoWake ? '；自动监听已开启（下次启动生效，/voice wake auto off 关闭）' : ''}`)
    return
  }
  if (arg === 'on') { await launchWakeSession(api, ctx, config); return }
  reply(api, `未知参数：${want}。用法：/voice wake <on|off|status|auto>`)
}

async function launchWakeSession(api: ExtensionAPI, ctx: ExtensionCommandContext | null, cfg: VoiceConfig): Promise<void> {
  if (wakeSession?.isRunning()) { reply(api, '已在监听中'); return }
  if (cfg.sttBackend !== 'sherpa') { reply(api, '唤醒监听依赖 sherpa 转写后端（SenseVoice），请先切换：/voice backend sherpa'); return }
  const svc = await runCommand('bash', [cfg.sherpaScript, 'start'], { timeoutMs: 60000 }).catch((e: unknown) => ({ code: 1, stdout: '', stderr: (e as Error).message }))
  if (svc.code !== 0) { reply(api, `sherpa 服务不可用：${svc.stderr || svc.stdout}（可手动 bash ${cfg.sherpaScript} start）`); return }
  try {
    wakeSession = createWakeSession(cfg, {
      onHit: (kw) => {
        wakeSession?.stop(); wakeSession = null
        if (ctx) { ctx.ui.setStatus('pi-voice', undefined); ctx.ui.notify(`已唤醒：${kw}`, 'warning') }
        reply(api, `已唤醒「${kw}」，开始录音（/voice wake on 可再次进入监听）`)
        if (!dictation.isRecording() && !dictation.isTranscribing()) {
          void prewarmStt(cfg).catch(() => {})
          if (ctx) { withStatusLocal(api, ctx, dictation.start()) } else { const m = dictation.start(); if (!m.startsWith('🎤')) reply(api, m) }
        }
      },
      onStatus: (s) => { if (ctx) ctx.ui.setStatus('pi-voice', s.startsWith('🎧') ? s : undefined); reply(api, s) },
    })
    await wakeSession.start()
  } catch (e) { wakeSession = null; reply(api, `唤醒监听不可用：${(e as Error).message}`) }
}

function stopWakeSessionLocal(api: ExtensionAPI, ctx: ExtensionCommandContext | null): string {
  const msg = wakeSession?.stop() ?? '唤醒监听未启用'
  wakeSession = null
  if (ctx) ctx.ui.setStatus('pi-voice', undefined)
  reply(api, msg)
  return msg
}

async function cmdModel(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig, want: string): Promise<void> {
  if (want === '') {
    const current = await whisperModel(config)
    const list = Object.entries(WHISPER_MODELS).map(([name, note]) => `  ${name}${name === config.whisperModel ? '（当前）' : ''} — ${note}`).join('\n')
    reply(api, `当前模型：${config.whisperModel}（服务端实际：${current ?? '不可达'}）\n可用模型：\n${list}\n切换：/voice model <名称>`)
    return
  }
  if (config.sttBackend === 'sherpa') { reply(api, '当前转写后端为 sherpa（SenseVoice），模型设置仅对 whisper 后端生效。如需调整请先 /voice backend whisper 切换后再操作。'); return }
  if (!(want in WHISPER_MODELS)) { reply(api, `未知模型：${want}。可用：${Object.keys(WHISPER_MODELS).join(' / ')}`); return }
  if (want === config.whisperModel) { reply(api, `已在使用模型 ${want}`); return }
  if (dictation.isRecording() || dictation.isTranscribing()) { reply(api, '请先停止录音/等待转写完成再切换模型'); return }
  try { persistConfig({ whisperModel: want }, process.env) } catch (e) { reply(api, `配置写入失败：${(e as Error).message}`); return }
  ctx.ui.setStatus('pi-voice', '⚙ 切换模型并重启服务…')
  reply(api, `正在切换到 ${want}（首次使用需下载模型，可能耗时较长）…`)
  const res = await runCommand('bash', [config.whisperScript, 'restart'], { timeoutMs: 120000 })
  ctx.ui.setStatus('pi-voice', undefined)
  if (res.code !== 0) { reply(api, `服务重启命令失败：${res.stderr || res.stdout}`); return }
  config = loadConfig()
  const deadline = Date.now() + 120000
  let ok = false
  while (Date.now() < deadline) { const m = await whisperModel(config); if (m === want) { ok = true; break }; await new Promise((r) => setTimeout(r, 2000)) }
  reply(api, ok ? `模型已切换为 ${want}，服务就绪` : `模型切换中（服务加载较慢），可用 /voice doctor 查看状态`)
}

async function cmdDevice(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig, want: string): Promise<void> {
  const DEVICE_NAMES: Record<string, string> = { auto: '自动检测', cuda: 'NVIDIA GPU', cpu: 'CPU' }
  if (want !== '' && config.sttBackend === 'sherpa') { reply(api, '当前转写后端为 sherpa（SenseVoice），设备设置仅对 whisper 后端生效。如需调整请先 /voice backend whisper 切换后再操作。'); return }
  const actual = await whisperDevice(config)
  if (want === '') {
    const list = Object.entries(DEVICE_NAMES).map(([name, note]) => `  ${name}${name === config.whisperDevice ? '（当前）' : ''} — ${note}`).join('\n')
    reply(api, `推理设备：${DEVICE_NAMES[config.whisperDevice] ?? config.whisperDevice}（配置）\n服务端实际：${actual ?? '不可达'}\n可用设备：\n${list}\n切换：/voice device <cpu|gpu|auto>`)
    return
  }
  const target = want === 'gpu' ? 'cuda' : want === 'cpu' ? 'cpu' : want === 'auto' ? 'auto' : null
  if (!target) { reply(api, `未知设备：${want}。可用：cpu / gpu / auto`); return }
  if (target === config.whisperDevice) { reply(api, `已在使用 ${want} 推理`); return }
  if (target === 'cuda') {
    const kind = platformOf(config).kind
    const hasNvidiaSmi = kind === 'termux' ? false : (await runCommand('nvidia-smi', [], { timeoutMs: 5000 })).code === 0
    const reason = gpuSwitchBlockReason(kind, hasNvidiaSmi)
    if (reason) { reply(api, reason); return }
  }
  if (dictation.isRecording() || dictation.isTranscribing()) { reply(api, '请先停止录音/等待转写完成再切换设备'); return }
  try { persistConfig({ whisperDevice: target as VoiceConfig['whisperDevice'] }, process.env) } catch (e) { reply(api, `配置写入失败：${(e as Error).message}`); return }
  ctx.ui.setStatus('pi-voice', '⚙ 切换推理设备并重启服务…')
  reply(api, `正在切换到 ${want}（重启服务）…`)
  const res = await runCommand('bash', [config.whisperScript, 'restart'], { timeoutMs: 120000 })
  ctx.ui.setStatus('pi-voice', undefined)
  if (res.code !== 0) { reply(api, `服务重启命令失败：${res.stderr || res.stdout}`); return }
  config = loadConfig()
  const deadline = Date.now() + 120000
  let ok = false
  while (Date.now() < deadline) { const d = await whisperDevice(config); if (d && (target === 'auto' || d === target)) { ok = true; break }; await new Promise((r) => setTimeout(r, 2000)) }
  reply(api, ok ? `推理设备已切换为 ${want}（服务端 ${ok ? (target === 'auto' ? '已加载' : target) : ''}），服务就绪` : `设备切换中（服务加载较慢），可用 /voice doctor 查看状态`)
}
