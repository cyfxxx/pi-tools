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
 * 快捷键 Ctrl+Alt+R 等价于 /voice（录音期间再次按即停止转写）；
 * Ctrl+R 为 pi 内置（app.session.rename），不可占用。
 * 听写模式：录音中按回车 = 切段转写 + 自动续录；快捷键/命令停止为正常退出（不续录）。
 * 回车条件拦截依赖核心补丁 scripts/patch-voice-enter.mjs（pi update 后需重跑）。
 *
 * 架构：状态机在 dictation.ts（纯逻辑，可单测）；本文件只做命令/快捷键/
 * 事件注册与 UI 接线（notify/setStatus/pasteToEditor/sendUserMessage）。
 * 隐私：录音文件转写后立即删除（即用即弃），启动与退出时清理残留。
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
  waitForFileStable,
  cleanupStaleAudio,
  speak,
  extractAssistantText,
  isSpeechWorthy,
  doctor,
  benchmark,
  runCommand,
  detectAudioLevel,
  createTtsDispatcher,
  type TtsDispatcher,
} from './core'

/** 听写回车防抖窗口（ms）：连击只处理一次 */
const ENTER_DEBOUNCE_MS = 800

let config: VoiceConfig
let lastAssistantText = ''
let lastAutoDictation = ''
/** 最近一次 UI 上下文（input/message_end 事件更新）：超时自动转写无调用方 ctx，
 *  需要它来清状态条、粘贴转写文本进输入框。会话存活期间事件频繁触发，引用基本实时。 */
let lastCtx: ExtensionContext | null = null
let ttsEnabled: boolean
/** 用户是否手动设置过 TTS（true 后不再被自动切换覆盖） */
let ttsManual = false
let lastEnterAt = 0
let dictation: Dictation
let ttsQueue: TtsDispatcher

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
  config = loadConfig()
  ttsEnabled = config.ttsEnabled
  // 启动即清理残留：进程重启后必然无进行中录音，tmpDir 全部残留（m4a/wav）立即删除；
  // 另清理重启/崩溃遗留的孤儿录音进程（幂等：无录音时 -q 输出 No recording to stop 且 exit 0），
  // 否则 termux-microphone-record 单实例占用会导致“只能开不能关”
  cleanupStaleAudio(config, 0)
  void stopRecording(config).catch(() => undefined)
  // 清理 TTS 僵尸进程（此前自动朗读崩溃遗留的 termux-tts-speak / termux-api TextToSpeech）
  void runCommand('pkill', ['-f', 'termux-tts-speak'], { timeoutMs: 5000 }).catch(() => undefined)
  void runCommand('pkill', ['-f', 'termux-api TextToSpeech'], { timeoutMs: 5000 }).catch(() => undefined)

  ttsQueue = createTtsDispatcher({
    speakFn: (text) => speak(config, text),
    onError: (message) => {
      pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `⚠ 朗读失败：${message}`, display: true })
    },
  })

  dictation = createDictation(
    config,
    { startRecording, stopRecording, convertToWav, transcribe, deleteAudioPair, waitForFileStable, detectAudioLevel },
    {
      // 录音进程自行退出（超时/启动失败）的自动完成：无调用方 UI 上下文，
      // 用 sendMessage(display) 主动展示结果，成功失败都不静默。
      onAutoComplete: (r) => {
        if (r.text) {
          lastAutoDictation = r.text
          if (config.autoSend) {
            pi.sendUserMessage(r.text, { deliverAs: 'steer' })
            pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `⏰ 已达录音时长上限，已自动转写并发送：${r.text}`, display: true })
          } else if (lastCtx) {
            // 与手动停止一致的交付：清状态条 + 转写文本进输入框供确认
            lastCtx.ui.setStatus('pi-voice', undefined)
            lastCtx.ui.pasteToEditor(r.text + ' ')
            lastCtx.ui.notify('⏰ 已达录音时长上限，转写完成，已插入输入框', 'info')
          } else {
            pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `⏰ 已达录音时长上限，已自动转写（暂存，可 /voice tts speak 朗读）：${r.text}`, display: true })
          }
        } else if (r.message) {
          lastAutoDictation = ''
          // 失败/空转写也清除状态条（录音中提示不应残留）
          lastCtx?.ui.setStatus('pi-voice', undefined)
          pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: r.message, display: true })
        }
      },
    },
  )

  const VOICE_USAGE = [
    '/voice                    录音中则停止转写，否则开始录音',
    '/voice start              开始录音',
    '/voice stop               停止录音并转写（不自动续录）',
    '/voice cancel             取消录音并丢弃音频',
    '/voice tts <on|off>       开关自动朗读回复',
    '/voice tts status         查看朗读/转写状态',
    '/voice tts speak [文本]   手动朗读（缺省朗读最近回复）',
    '/voice doctor             诊断录音/转写/朗读依赖',
    '/voice model [名称]       查看/切换 whisper 模型',
    '/voice bench              录 5 秒测转写速度',
    '/voice help               显示本帮助',
    '（录音中按回车 = 切段转写并自动续录）',
  ].join('\n')

  pi.registerCommand('voice', {
    description: '语音：录音转写与朗读（/voice help 查看用法）',
    // 多级补全：pi 传入完整参数前缀（含多级与空格），按第一级子命令分发
    getArgumentCompletions: (prefix) => {
      const first = (prefix.trim().split(/\s+/)[0] ?? '').toLowerCase()
      if (first === 'tts') {
        return [
          { value: 'on', label: 'tts on', description: '开启自动朗读' },
          { value: 'off', label: 'tts off', description: '关闭自动朗读' },
          { value: 'status', label: 'tts status', description: '查看朗读/转写状态' },
          { value: 'speak', label: 'tts speak [文本]', description: '手动朗读（缺省朗读最近回复）' },
        ]
      }
      if (first === 'model') {
        return Object.entries(WHISPER_MODELS).map(([name, desc]) => ({
          value: name,
          label: `model ${name}`,
          description: desc,
        }))
      }
      return [
        { value: 'start', label: 'start', description: '开始录音' },
        { value: 'stop', label: 'stop', description: '停止录音并转写' },
        { value: 'cancel', label: 'cancel', description: '取消录音并丢弃音频' },
        { value: 'tts', label: 'tts', description: '朗读：on/off/status/speak' },
        { value: 'doctor', label: 'doctor', description: '诊断依赖' },
        { value: 'model', label: 'model', description: '查看/切换 whisper 模型' },
        { value: 'bench', label: 'bench', description: '转写速度基准' },
        { value: 'help', label: 'help', description: '显示用法' },
      ]
    },
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/)
      switch (cmd) {
        case '':
          if (dictation.isRecording()) {
            await stopAndDeliver(pi, ctx, false)
          } else {
            withStatus(pi, ctx, dictation.start())
          }
          break
        case 'start':
          withStatus(pi, ctx, dictation.start())
          break
        case 'stop': {
          const r = await dictation.stop()
          deliverResult(pi, ctx, r)
          break
        }
        case 'cancel':
          withStatus(pi, ctx, dictation.cancel())
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
        case 'doctor':
          await cmdDoctor(pi, ctx, config)
          break
        case 'model':
          await cmdModel(pi, ctx, config, rest.join(' '))
          break
        case 'bench':
          await cmdBench(pi, ctx, config)
          break
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
    if (dictation.isRecording() || dictation.isTranscribing()) {
      void stopAndDeliver(pi, ctx, false)
    } else {
      withStatus(pi, ctx, dictation.start())
    }
  }

  // 仅保留备选快捷键 Ctrl+Alt+R（Android 软键盘有 CTRL/ALT 键）；
  // Ctrl+Shift+R 已移除（与部分终端/输入法冲突，避免误触录音）
  pi.registerShortcut(Key.ctrlAlt('r'), {
    description: '语音录制/停止转写（备选，软键盘可用）',
    handler: toggleRecording,
  })

  // 听写模式：录音中按回车 = 结束当前段并转写，完成后自动续录；
  // 未录音/转写中返回 false 放行（依赖核心补丁 patch-voice-enter.mjs，否则 enter 被无条件拦截）。
  // 类型断言：核心补丁读取运行时返回值 false，ts 类型仅允许 void | Promise<void>。
  // 未检测到补丁时不注册：避免吞掉所有回车（输入提交/菜单选择失效）。
  // 防抖：ENTER_DEBOUNCE_MS 内连击只处理一次；转写中回车给出提示而非静默。
  const enterReady = enterPatchApplied()
  if (enterReady) {
    pi.registerShortcut(Key.enter, {
      description: '录音中回车：切段转写并自动续录',
      handler: ((ctx: ExtensionContext) => {
        if (!dictation.isRecording()) {
          // 竞态兜底：录音进程刚达时长上限自行退出、正在自动转写时，吞掉回车并提示，
          // 避免回车被放行当作普通输入提交（否则用户按回车中断，看到的却是"录音超时"提示）。
          if (dictation.isTranscribing()) {
            ctx.ui.notify('录音已达时长上限，自动转写中…', 'warning')
            return true
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

  // 输入事件：区分语音/键盘输入来源，控制自动 TTS 与防误操作。
  // 键盘输入（interactive）→ 自动模式关闭朗读（语音对话结束）；
  // 录音/转写进行中键盘提交 → 拦截并提示，避免误操作打断语音流程。
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

  // 自动朗读 assistant 回复（仅最终回复的文本部分，异步不阻塞）
  // 中间轮（stopReason=toolUse）与 JSON/结构化摘要不朗读，避免语音轰炸与朗读垃圾内容
  pi.on('message_end', (event, ctx) => {
    lastCtx = ctx
    if (!ttsEnabled) return
    const msg = event?.message
    if (!msg || msg.role !== 'assistant') return
    if (msg.stopReason !== 'stop') return
    const text = extractAssistantText(msg.content)
    if (!text || !isSpeechWorthy(text)) return
    lastAssistantText = text
    ttsQueue.enqueue(text)
  })

  // 退出/重载时清理录音进程与残留文件（隐私兜底）
  pi.on('session_shutdown', () => {
    dictation.cleanup()
    cleanupStaleAudio(config, 0)
  })
}

const OUTPUT_CUSTOM_TYPE = 'cmd-output'

function reply(api: ExtensionAPI, text: string): void {
  api.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: text, display: true })
}

function withStatus(api: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (message.startsWith('🎤')) {
    ctx.ui.setStatus('pi-voice', '🎤 录音中')
    autoSetTts(true)
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
 * dictating（听写模式）时无论 autoSend 一律粘贴输入框（逐段累积、统一修改后发送）。
 * 成功/失败均有明确提示；语音直发时自动开启朗读（语音对话闭环）。
 */
function deliverResult(pi: ExtensionAPI, ctx: ExtensionContext, r: StopResult, dictating = false): void {
  ctx.ui.setStatus('pi-voice', undefined)
  if (!r.text) {
    ctx.ui.notify('语音转写失败', 'error')
    reply(pi, r.message)
    return
  }
  if (dictating) {
    ctx.ui.pasteToEditor(r.text + ' ')
    ctx.ui.notify('已插入输入框，可继续口述')
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

/** 自动模式下的 TTS 开关（不持久化；仅语音输入时开启、键盘输入时关闭）。 */
function autoSetTts(enabled: boolean): void {
  if (ttsManual || ttsEnabled === enabled) return
  ttsEnabled = enabled
}

function setTts(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  ttsManual = true
  ttsEnabled = enabled
  try {
    persistConfig({ ttsEnabled }, process.env)
  } catch {
    // 持久化失败不阻塞开关
  }
  ctx.ui.notify(`TTS ${enabled ? '已开启' : '已关闭'}（手动，不再自动切换）`)
  reply(pi, `TTS ${enabled ? '已开启' : '已关闭'}（手动，不再自动切换）`)
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
  const res = await runCommand('bash', [config.whisperScript, 'restart'], { timeoutMs: 120000 })
  ctx.ui.setStatus('pi-voice', undefined)
  if (res.code !== 0) {
    reply(api, `服务重启命令失败：${res.stderr || res.stdout}`)
    return
  }
  // 重新加载配置（模型已切换，避免快照旧值误判"已在使用"）
  config = loadConfig()
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
