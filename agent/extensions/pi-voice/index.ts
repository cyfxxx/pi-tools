/**
 * pi-voice — 语音交流扩展（Termux + 本地 Whisper + 系统 TTS）
 *
 * /voice            无参数：切换开始/停止录音并转写
 * /voice start      开始录音
 * /voice stop       停止、转写并处理（autoSend 时直发，否则粘贴输入框）
 * /voice cancel     取消录音（丢弃音频）
 * /voice doctor     诊断录音/转写/朗读依赖
 * /tts on|off       开关自动朗读回复（/tts 无参数也切换；状态持久化）
 * /tts speak [文本]  手动朗读（缺省朗读最近一条回复）
 * /tts status       朗读与后端状态
 *
 * 快捷键 Ctrl+Shift+R 等价于 /voice（录音期间再次按即停止转写）；
 * Ctrl+R 为 pi 内置（app.session.rename），不可占用。
 *
 * 架构：状态机在 dictation.ts（纯逻辑，可单测）；本文件只做命令/快捷键/
 * 事件注册与 UI 接线（notify/setStatus/pasteToEditor/sendUserMessage）。
 * 隐私：录音文件转写后立即删除（即用即弃），启动与退出时清理残留。
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
  deleteAudioPair,
  cleanupStaleAudio,
  speak,
  extractAssistantText,
  doctor,
} from './core'

let lastAssistantText = ''
let lastAutoDictation = ''
let ttsEnabled: boolean
let dictation: Dictation

export default function (pi: ExtensionAPI): void {
  const config = loadConfig()
  ttsEnabled = config.ttsEnabled
  // 启动即清理超过 24h 的残留录音文件（隐私：不长期留存音频）
  cleanupStaleAudio(config)

  dictation = createDictation(
    config,
    { startRecording, stopRecording, convertToWav, transcribe, deleteAudioPair },
    {
      // 录音进程自行退出（超时）的自动转写完成：无调用方 UI 上下文，
      // autoSend 时直发，否则暂存供查询，绝不落盘音频。
      onAutoComplete: (r) => {
if (r.text) {
          lastAutoDictation = r.text
          if (config.autoSend) pi.sendUserMessage(r.text, { deliverAs: 'nextTurn' })
        }
      },
    },
  )

  pi.registerCommand('voice', {
    description: '语音输入：开始/停止录音并转写',
    usage: 'voice [start|stop|cancel|doctor]',
    handler: async (args, ctx) => {
      const cmd = args.trim()
      if (cmd === 'start') {
        return withStatus(ctx, dictation.start())
      }
      if (cmd === 'stop') {
        const r = await dictation.stop()
        return deliverResult(pi, ctx, r)
      }
      if (cmd === 'cancel') {
        return withStatus(ctx, dictation.cancel())
      }
      if (cmd === 'doctor') return cmdDoctor(ctx, config)
      if (dictation.isRecording()) {
        const r = await dictation.stop()
        return deliverResult(pi, ctx, r)
      }
      return withStatus(ctx, dictation.start())
    },
  })

  pi.registerCommand('tts', {
    description: '语音朗读：on/off/status/speak [文本]',
    usage: 'tts [on|off|status|speak [文本]]',
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/)
      switch (cmd) {
        case 'on':
          return setTts(pi, ctx, true)
        case 'off':
          return setTts(pi, ctx, false)
        case 'status':
          return `TTS ${ttsEnabled ? '开启' : '关闭'}；最近回复 ${lastAssistantText ? `${lastAssistantText.length} 字符` : '无'}；自动转写暂存 ${lastAutoDictation ? '有' : '无'}；转写服务 ${await whisperStatus(config)}`
        case 'speak': {
          const text = rest.join(' ') || lastAssistantText
          if (!text) return '暂无朗读内容'
          const res = await speak(config, text)
          return res.code === 0 ? '已朗读' : `朗读失败: ${res.stderr}`
        }
        default:
          return setTts(pi, ctx, !ttsEnabled)
      }
    },
  })

  pi.registerShortcut(Key.ctrlShift('r'), {
    description: '语音录制/停止转写',
    handler: (ctx) => {
      if (dictation.isRecording() || dictation.isTranscribing()) {
        void dictation.stop().then((r) => deliverResult(pi, ctx, r)).catch(() => {})
      } else {
        withStatus(ctx, dictation.start())
      }
    },
  })

  // 自动朗读 assistant 回复（仅文本部分，异步不阻塞）
  pi.on('message_end', (event) => {
    if (!ttsEnabled) return
    const msg = event?.message
    if (!msg || msg.role !== 'assistant') return
    const text = extractAssistantText(msg.content)
    if (!text) return
    lastAssistantText = text
    void speak(config, text).catch(() => {})
  })

  // 退出/重载时清理录音进程与残留文件（隐私兜底）
  pi.on('session_shutdown', () => {
    dictation.cleanup()
    cleanupStaleAudio(config)
  })
}

function withStatus(ctx: ExtensionContext, message: string): string {
  if (message.startsWith('🎤')) {
    ctx.ui.setStatus('pi-voice', '🎤 录音中')
  } else {
    ctx.ui.setStatus('pi-voice', undefined)
  }
  return message
}

/** 转写结果交付：autoSend 直发，否则粘贴输入框供确认；不落盘音频。 */
function deliverResult(pi: ExtensionAPI, ctx: ExtensionContext, r: StopResult): string {
  const cfg = loadConfig()
  if (r.text) {
    if (cfg.autoSend) {
      pi.sendUserMessage(r.text, { deliverAs: 'nextTurn' })
      ctx.ui.notify('已发送语音指令')
      return `已发送：${r.text}`
    }
    ctx.ui.setStatus('pi-voice', undefined)
    ctx.ui.pasteToEditor(r.text + ' ')
    ctx.ui.notify('转写完成，已插入输入框')
  } else {
    ctx.ui.setStatus('pi-voice', undefined)
  }
  return r.message
}

function setTts(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): string {
  ttsEnabled = enabled
  try {
    persistConfig({ ttsEnabled }, process.env)
  } catch {
    // 持久化失败不阻塞开关
  }
  ctx.ui.notify(`TTS ${enabled ? '已开启' : '已关闭'}`)
  return `TTS ${enabled ? '已开启' : '已关闭'}`
}

async function cmdDoctor(ctx: ExtensionCommandContext, config: VoiceConfig): Promise<string> {
  const lines = await doctor(config)
  ctx.ui.setStatus('pi-voice', undefined)
  return lines.join('\n')
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