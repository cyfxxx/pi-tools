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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { loadConfig, persistConfig, type VoiceConfig } from './config'
import { platformOf, gpuSwitchBlockReason } from './core'
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

/** 听写回车防抖窗口（ms）：连击只处理一次 */
const ENTER_DEBOUNCE_MS = 800
/** reply 兜底重试：加载期/会话替换窗口 runtime 未绑定，sendMessage 抛桩错——延迟补发，超限丢弃 */
const REPLY_RETRY_DELAY_MS = 1000
const REPLY_RETRY_LIMIT = 10

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
/** 听写待续录：回车转写成功后等待用户确认（再次回车清空输入框后开始新录音）。 */
let awaitingResume = false
let dictation: Dictation
let ttsQueue: TtsDispatcher
let wakeSession: WakeSession | null = null

/** 可用 whisper 模型（faster-whisper）与设备说明 */
const WHISPER_MODELS: Record<string, string> = {
  tiny: '最快，准确率一般',
  base: '默认，速度/准确率均衡',
  small: '更准，速度较慢',
  medium: '准确，手机 CPU 较慢',
  'large-v3': '最准，手机 CPU 极慢，不推荐',
}

const ENTER_PATCH_MARKER = 'Patch (patch-voice-enter.mjs)'

/** 补丁未检测到（加载期只置标志，不 reply——stub 会炸；首次 /voice 命令时提示）。 */
let enterPatchMissing = false

/**
 * 探测核心补丁是否已应用（scripts/patch-voice-enter.mjs）。
 * 未打补丁时 onExtensionShortcut 对匹配按键"无条件消费"：
 * 注册 Key.enter 会吞掉全部回车（输入提交/菜单选择失效），
 * 故必须仅在补丁已应用时才注册 enter 快捷键。
 * 探测失败（无法定位 dist）视为未打补丁，宁可禁用听写也不吞回车。
 */
function enterPatchApplied(): boolean {
  try {
    const dist = detectDistFromPath(process.env.PI_DIST)
    const target = join(dist, 'modes', 'interactive', 'interactive-mode.js')
    if (!existsSync(target)) return false
    return readFileSync(target, 'utf-8').includes(ENTER_PATCH_MARKER)
  } catch {
    return false
  }
}

function detectDistFromPath(explicit?: string): string {
  if (explicit && existsSync(join(explicit, 'modes', 'interactive', 'interactive-mode.js'))) return explicit
  // 兜底：扫描本机 pi-node 安装目录（避免硬编码路径跨机失效）
  try {
    const piNodeDir = join(homedir(), '.local', 'share', 'pi-node')
    for (const d of readdirSync(piNodeDir)) {
      const cand = join(piNodeDir, d, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
      if (existsSync(join(cand, 'modes', 'interactive', 'interactive-mode.js'))) return cand
    }
  } catch {
    // fall through
  }
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
  // 审计 MEDIUM（2026-08-24）：staleMs 用 5s 小窗口而非 0——单进程重启语义不变
  // （重启后无进行中，旧残留 mtime 必远超 5s），但同宿主其它 pi 进程刚写入的文件不会被误删
  cleanupStaleAudio(config, 5_000)
  void stopRecording(config).catch(() => undefined)
  // 清理 TTS 僵尸进程（平台相关：termux 为 termux-tts-speak / termux-api TextToSpeech；linux 为 espeak-ng / paplay）
  for (const pat of platformOf(config).tts.zombiePatterns()) {
    // pkill -x 精确进程名，收敛误杀面（-f 全命令行匹配会误杀同宿主其它用途的
    // espeak-ng/paplay 进程，审计 MEDIUM/2026-08-24）
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
      startRecording, stopRecording, queryRecording, fileExists, convertToWav, transcribe: transcribeByBackend, deleteAudioPair, waitForFileStable, detectAudioLevel,
      micLabel: spec.recorder.micLabel,
      micInstallHint: spec.recorder.installHint,
      micPermissionHint: spec.recorder.permissionHint,
    },
    {
      // 录音进程自行退出（超时/启动失败）的自动完成：无调用方 UI 上下文，
      // 用 sendMessage(display) 主动展示结果，成功失败都不静默。
      onAutoComplete: (r) => {
        if (r.text) {
          lastAutoDictation = r.text
          // 区分自动停止原因：timer = 已到上限；exit = 进程意外提前退出（服务不稳定），附实际时长
          const head =
            r.autoReason === 'exit'
              ? `⚠️ 录音异常提前结束（${r.autoSec ?? '?'}s），已自动转写`
              : '⏰ 已达录音时长上限，已自动转写'
          if (config.autoSend) {
            pi.sendUserMessage(r.text, { deliverAs: 'steer' })
            pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `${head}并发送：${r.text}`, display: true })
          } else if (lastCtx) {
            // 与手动停止一致的交付：清状态条 + 转写文本进输入框供确认
            lastCtx.ui.setStatus('pi-voice', undefined)
            lastCtx.ui.pasteToEditor(r.text + ' ')
            lastCtx.ui.notify(`${head}，已插入输入框`, 'info')
          } else {
            pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: `${head}（暂存，可 /voice tts speak 朗读）：${r.text}`, display: true })
          }
        } else if (r.message) {
          lastAutoDictation = ''
          // 失败/空转写也清除状态条（录音中提示不应残留）
          lastCtx?.ui.setStatus('pi-voice', undefined)
          pi.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: r.message, display: true })
        }
      },
      // 文件实际生成（麦克风真在录，启动延迟实测 1-2s）："初始化中"→"录音中"
      onReady: () => {
        if (dictation.isRecording()) lastCtx?.ui.setStatus('pi-voice', '🎤 录音中')
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
    '/voice backend [whisper|sherpa]  查看/切换转写后端（sherpa = SenseVoice 端侧模型）',
    '/voice wake <on|off|status|auto>  唤醒监听（说“开启语音输入”开始录音；auto 控制启动自动监听）',
    '/voice model [名称]      查看/切换 whisper 模型',
    '/voice device [cpu|gpu|auto]  查看/切换推理设备（GPU 被占用时切 cpu）',
    '/voice doctor             诊断录音/转写/朗读依赖',
    '/voice bench              录 5 秒测转写速度',
    '/voice help               显示本帮助',
    '（Tab 补全：/voice + 两次 Tab 显示子命令；子命令随输入过滤，如 tts s → status）',
    '（录音中按回车 = 切段转写并自动续录）',
  ].join('\n')

  pi.registerCommand('voice', {
    description: '语音：录音转写与朗读（/voice help 查看用法）',
    // 多级补全：pi 传入完整参数前缀（含多级与空格），按第一级子命令分发
    getArgumentCompletions: (prefix) => {
      const first = (prefix.trim().split(/\s+/)[0] ?? '').toLowerCase()
      // 前缀过滤（与 /link 同款）：不匹配返回空数组 → 补全弹窗关闭 →
      // 回车正常提交命令。2026-08-15 用户报告：原实现无过滤，输入
      // '/voice tts speak 你好' 时弹窗永不关闭，回车被劫持成接受选中项
      // （变 'tts on'）
      const pick = (items: { value: string; label: string; description: string }[]) => {
        const t = prefix.trim()
        // 完整匹配也排除（'/voice tts on' 回车应直接提交而非停在弹窗）
        return items.filter((i) => i.value.startsWith(t) && i.value !== t)
      }
      // 注意：参数补全的 value 是整体替换参数前缀（pi 的 applyCompletion 用
      // beforePrefix + item.value），必须含完整参数（'tts on'），否则会变
      // 成 '/voice on' 之类的错命令；speak 是自由文本命令不入补全列表
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
      // 补丁缺失提示（加载期不 reply 的延迟输出）：/voice 命令或快捷键进入语音时提示一次
      maybeWarnEnterPatch(pi)
      const [cmd, ...rest] = args.trim().split(/\s+/)
      switch (cmd) {
        case '':
          if (dictation.isRecording()) {
            await stopAndDeliver(pi, ctx, false)
          } else {
            void prewarmStt(config).catch(() => {})
            withStatus(pi, ctx, dictation.start())
          }
          break
        case 'start':
          awaitingResume = false
          void prewarmStt(config).catch(() => {})
          withStatus(pi, ctx, dictation.start())
          break
        case 'stop': {
          awaitingResume = false
          // 与 stopAndDeliver 一致：停止期间先显示转写中，避免状态条残留'录音中'
          if (dictation.isRecording()) ctx.ui.setStatus('pi-voice', '⚙ 转写中…')
          const r = await dictation.stop()
          deliverResult(pi, ctx, r)
          break
        }
        case 'cancel':
          awaitingResume = false
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
        case 'backend':
          await cmdBackend(pi, ctx, config, rest.join(' '))
          break
        case 'wake':
          await cmdWake(pi, ctx, config, rest.join(' '))
          break
        case 'model':
          await cmdModel(pi, ctx, config, rest.join(' '))
          break
        case 'device':
          await cmdDevice(pi, ctx, config, rest.join(' '))
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
    // 快捷键路径同样提示补丁缺失（Windows 用户可能全程用快捷键，/voice 命令不触发）
    maybeWarnEnterPatch(pi)
    if (dictation.isRecording() || dictation.isTranscribing()) {
      awaitingResume = false // 手动停止：不进入听写待续录
      void stopAndDeliver(pi, ctx, false).catch((e) => console.warn('[pi-voice] 停止转写失败:', (e as Error)?.message ?? e))
    } else {
      awaitingResume = false // 手动开始：退出待续录状态
      void prewarmStt(config).catch(() => {})
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
  // 键位说明：不能注册 'enter'——tui.input.submit 默认绑 enter 且属保留键
  // （RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS），扩展注册会被静默丢弃
  // （实测 shortcuts 快照无 enter）。改用 'return'：matchesKey 的 case enter/return
  // 同一分支，'\r' 命中；shift+enter 覆盖 Termux TTY ICRNL（'\n'）与 Kit yy 解析场景。
  const enterReady = enterPatchApplied()
  if (enterReady) {
    const enterTapHandler = ((ctx: ExtensionContext) => {
      if (!dictation.isRecording()) {
        // 竞态兜底：录音进程刚达时长上限自行退出、正在自动转写时，吞掉回车并提示，
        // 避免回车被放行当作普通输入提交（否则用户按回车中断，看到的却是"录音超时"提示）。
        if (dictation.isTranscribing()) {
          ctx.ui.notify('录音已达时长上限，自动转写中…', 'warning')
          return true
        }
        // 听写待续录：输入框为空 → 开始新录音；有内容 → 放行（pi 正常提交发送，
        // 不再清空输入框——用户转写后按回车期望的是发送，不是丢字）
        if (awaitingResume) {
          const hasContent = (ctx.ui.getEditorText() ?? '').trim() !== ''
          if (!hasContent) {
            awaitingResume = false
            const m = dictation.start()
            if (m.startsWith('🎤')) {
              // 初始化延迟提示：onReady 回调会切换为录音中
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
        // 转写成功 → 待续录（不自动开始）；用户再次回车清空输入框后开始下一段。
        // 失败/空转写不置位（回车恢复普通提交行为）。
        if (r.text && !dictation.isTranscribing()) {
          awaitingResume = true
        }
      }).catch(() => {})
      return true
    }) as (ctx: ExtensionContext) => void
    // 'return' 匹配键盘栏回车（'\r'）；shift+enter 匹配 ICRNL/Kitty（'\n'）路径
    pi.registerShortcut(Key.return, {
      description: '录音中回车：切段转写并自动续录',
      handler: enterTapHandler,
    })
    pi.registerShortcut(Key.shift('enter'), {
      description: '录音中回车（ICRNL/Kitty 路径）：切段转写并自动续录',
      handler: enterTapHandler,
    })
  } else {
    // 加载期不能调 reply/pi.sendMessage（扩展 runtime 未绑定，stub 直接抛错——
    // Windows 便携环境未打补丁时实测崩溃："Extension runtime not initialized"）。
    // 只置标志，首次 /voice 命令时提示（信息不丢、不炸）。
    enterPatchMissing = true
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
    const msg = event?.message
    if (!msg || msg.role !== 'assistant') return
    if (msg.stopReason !== 'stop') return
    const text = extractAssistantText(msg.content)
    if (!text || !isSpeechWorthy(text)) return
    // 最近回复先记录（TTS 关闭期间也记录）：/voice tts speak 缺省朗读最近一条有效回复
    lastAssistantText = text
    if (!ttsEnabled) return
    ttsQueue.enqueue(text)
  })

  // 退出/重载时清理录音进程、唤醒监听与残留文件（隐私兜底）
  pi.on('session_shutdown', () => {
    dictation.cleanup()
    wakeSession?.stop()
    wakeSession = null
    // 与启动清理一致用 5s 小窗口，避免并发进程刚写入的数据被全量删除（审计 MEDIUM）
    cleanupStaleAudio(config, 5_000)
  })

  // 自动唤醒：配置 autoWake=true 时启动即后台监听（无需手动 /voice wake on）。
  // 前置：linux + sherpa 后端；sherpa 服务若未运行会自动拉起。
  // 关闭：/voice wake off（本次退出）或 /voice wake auto off（持久关闭）。
  // 不能加载期直接启动：bindCore 前 sendMessage 是抛错桩，launchWakeSession 的
  // onStatus/onHit 与错误分支里的 reply 会崩整个进程（实测 "Extension runtime
  // not initialized"）。session_start 是绑定后首个事件（startup/reload 均触发，
  // reload 前先 session_shutdown 清理，语义正确）。
  if (config.autoWake) {
    pi.on('session_start', () => {
      void launchWakeSession(pi, null, config)
    })
  }
}

const OUTPUT_CUSTOM_TYPE = 'cmd-output'

/** 补丁缺失提示（幂等，仅提示一次）：/voice 命令与 Ctrl+Alt+R 快捷键共用 */
function maybeWarnEnterPatch(api: ExtensionAPI): void {
  if (enterPatchMissing) {
    enterPatchMissing = false
    reply(api, '⚠ 回车快速听写未启用：核心补丁未检测到。请执行：node ~/.pi/scripts/patch-voice-enter.mjs（其他语音功能不受影响）')
  }
}

function reply(api: ExtensionAPI, text: string): void {
  const send = (): boolean => {
    try {
      api.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: text, display: true })
      return true
    } catch {
      return false
    }
  }
  if (send()) return
  // sendMessage 抛桩错/stale ctx 错时不崩进程：延迟补发，超限丢弃（提示消息非关键路径）
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    if (send() || attempts >= REPLY_RETRY_LIMIT) clearInterval(timer)
  }, REPLY_RETRY_DELAY_MS)
  timer.unref()
}

function withStatus(api: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  // 所有录音开始入口（快捷键/命令）都会经过这里：刷新 UI 上下文，
  // 保证超时自动转写（无调用方 ctx）时能清状态条、粘贴进输入框
  lastCtx = ctx
  if (message.startsWith('🎤')) {
    // 麦克风初始化有延迟（文件生成实测 1-2s）：先提示初始化中，
    // 文件实际生成后 onReady 回调切换为录音中（避免初始化窗口说话丢开头）
    ctx.ui.setStatus('pi-voice', '⏳ 启动麦克风中…')
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
    // busy（转写进行中 stop）：info 提示即可，不误报“语音转写失败”
    if (r.busy) {
      ctx.ui.notify(r.message || '正在转写，请稍候', 'info')
      return
    }
    // 审计 LOW：未在录音的 stop 是无害 no-op，info 提示而非误报失败
    // （仅 /voice stop 子命令触发；快捷键 toggle 有 isRecording 守卫）
    if (r.message && r.message.includes('未在录音')) {
      ctx.ui.notify(r.message, 'info')
      return
    }
    // 审计 LOW：非错误空转写结果（未检测到声音信号/未识别到语音内容）
    // 属正常完成但无内容，info 提示 + 回显说明，不标“语音转写失败”
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

/** /voice backend [whisper|sherpa]：查看或切换转写后端（sherpa = SenseVoice 端侧模型）。
 *  仅影响转写路径；录音/ TTS 等不受影响。whisper 为默认后端，切换前行为不变。 */
async function cmdBackend(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig, arg: string): Promise<void> {
  const name = arg.trim().toLowerCase()
  if (name === 'whisper' || name === 'sherpa') {
    if (name === config.sttBackend) {
      reply(api, `转写后端已是 ${name === 'sherpa' ? 'sherpa（SenseVoice）' : 'whisper（faster-whisper）'}`)
      return
    }
    config.sttBackend = name
    try {
      persistConfig({ sttBackend: name }, process.env)
    } catch {
      // 持久化失败不阻塞（下次 /voice backend 再试）
    }
    reply(api, `转写后端已切换为 ${name === 'sherpa' ? 'sherpa（SenseVoice 端侧模型）' : 'whisper（faster-whisper）'}，下次录音转写生效。${name === 'sherpa' ? '\n提示：首次使用会自动拉起 sherpa 服务（端口 18768）；可 /voice doctor 检查两后端就绪状态。' : ''}`)
    return
  }
  if (name) {
    reply(api, `未知后端: ${name}（可用 whisper | sherpa）`)
    return
  }
  const cur = config.sttBackend
  ctx.ui.setStatus('pi-voice', undefined)
  reply(
    api,
    `当前转写后端：${cur === 'sherpa' ? 'sherpa（SenseVoice 端侧模型）' : 'whisper（faster-whisper）'}` +
      `\n切换：/voice backend whisper|sherpa` +
      `\n说明：默认 whisper（行为不变）；sherpa 用端侧 SenseVoice，中文准确率更高、CPU 更快。` +
      `\n两后端就绪状态用 /voice doctor 查看。`,
  )
}

/** /voice wake <on|off|status|auto>：唤醒监听（Linux）。
 *  on：持续采麦克风 PCM → 轮询 sherpa /wake；命中唤醒词自动开始录音。
 *  auto：控制“启动 pi 后后台自动监听”（持久化到配置）。
 *  需 { sttBackend: 'sherpa' }（SenseVoice 后端）。Termux 录音 API 无实时流，不支持。 */
async function cmdWake(api: ExtensionAPI, ctx: ExtensionCommandContext, config: VoiceConfig, want: string): Promise<void> {
  const arg = want.trim().toLowerCase()
  if (arg === 'auto' || arg.startsWith('auto ')) {
    const sub = arg === 'auto' ? '' : arg.slice(5).trim()
    if (sub === '') {
      reply(api, `自动监听（启动 pi 后在后台运行唤醒）：${config.autoWake ? '已开启' : '已关闭'}；${wakeSession?.isRunning() ? '当前正在监听' : '当前未监听'}\n开启：/voice wake auto on；关闭：/voice wake auto off（持久）或 /voice wake off（仅本次）`)
      return
    }
    if (sub === 'on') {
      // 对齐其余调用点：持久化失败不阻塞开关，但需明确告知（否则下次启动静默不生效）
      let warn = ''
      try {
        persistConfig({ autoWake: true }, process.env)
      } catch {
        warn = '\n⚠ 配置写入失败：本次已开启，但下次启动 pi 不会自动监听'
      }
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
      try {
        persistConfig({ autoWake: false }, process.env)
      } catch {
        warn = '\n⚠ 配置写入失败：本次已关闭，但下次启动仍按旧配置自动监听'
      }
      stopWakeSession(api, ctx)
      reply(api, `自动监听已关闭（下次启动 pi 不再自动监听）${warn}`)
      return
    }
    reply(api, `用法：/voice wake auto <on|off>`)
    return
  }
  if (arg === 'off') {
    stopWakeSession(api, ctx)
    return
  }
  if (arg === 'status' || arg === '') {
    reply(api, wakeSession?.isRunning()
      ? `唤醒监听中，已命中唤醒词 ${wakeSession.hits()} 次（说“开启语音输入”开始录音；/voice wake off 停止）`
      : `唤醒监听未启用（可用 /voice wake on）${config.autoWake ? '；自动监听已开启（下次启动生效，/voice wake auto off 关闭）' : ''}`)
    return
  }
  if (arg === 'on') {
    await launchWakeSession(api, ctx, config)
    return
  }
  reply(api, `未知参数：${want}。用法：/voice wake <on|off|status|auto>`)
}

/** 启动唤醒监听（命令与激活 autoWake 共用；ctx null = 激活场景，状态条/通知降级为 sendMessage）。
 *  前置校验 sherpa 后端；服务未运行自动拉起（脚本幂等，已在运行直接返回）。 */
async function launchWakeSession(api: ExtensionAPI, ctx: ExtensionCommandContext | null, cfg: VoiceConfig): Promise<void> {
  if (wakeSession?.isRunning()) {
    reply(api, '已在监听中')
    return
  }
  if (cfg.sttBackend !== 'sherpa') {
    reply(api, '唤醒监听依赖 sherpa 转写后端（SenseVoice），请先切换：/voice backend sherpa')
    return
  }
  // 确保 sherpa 服务在线（激活场景服务可能未起；脚本幂等）
  const svc = await runCommand('bash', [cfg.sherpaScript, 'start'], { timeoutMs: 60000 }).catch((e: unknown) => ({ code: 1, stdout: '', stderr: (e as Error).message }))
  if (svc.code !== 0) {
    reply(api, `sherpa 服务不可用：${svc.stderr || svc.stdout}（可手动 bash ${cfg.sherpaScript} start）`)
    return
  }
  try {
    wakeSession = createWakeSession(cfg, {
      onHit: (kw) => {
        wakeSession?.stop()
        wakeSession = null
        if (ctx) {
          ctx.ui.setStatus('pi-voice', undefined)
          ctx.ui.notify(`已唤醒：${kw}`, 'warning')
        }
        reply(api, `已唤醒「${kw}」，开始录音（/voice wake on 可再次进入监听）`)
        if (!dictation.isRecording() && !dictation.isTranscribing()) {
          void prewarmStt(cfg).catch(() => {})
          if (ctx) {
            withStatus(api, ctx, dictation.start())
          } else {
            const m = dictation.start()
            if (!m.startsWith('🎤')) reply(api, m)
          }
        }
      },
      onStatus: (s) => {
        if (ctx) ctx.ui.setStatus('pi-voice', s.startsWith('🎧') ? s : undefined)
        reply(api, s)
      },
    })
    await wakeSession.start()
  } catch (e) {
    wakeSession = null
    reply(api, `唤醒监听不可用：${(e as Error).message}`)
  }
}

/** 停止监听并返回消息（命令与 auto 关闭共用；ctx null = 激活场景降级展示）。 */
function stopWakeSession(api: ExtensionAPI, ctx: ExtensionCommandContext | null): string {
  const msg = wakeSession?.stop() ?? '唤醒监听未启用'
  wakeSession = null
  if (ctx) ctx.ui.setStatus('pi-voice', undefined)
  reply(api, msg)
  return msg
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
  if (config.sttBackend === 'sherpa') {
    reply(api, '当前转写后端为 sherpa（SenseVoice），模型设置仅对 whisper 后端生效。如需调整请先 /voice backend whisper 切换后再操作。')
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

/** /voice device [cpu|gpu|auto]：查看或切换推理设备（GPU 被游戏/渲染占用时切 CPU 保稳定）。 */
async function cmdDevice(
  api: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: VoiceConfig,
  want: string,
): Promise<void> {
  const DEVICE_NAMES: Record<string, string> = { auto: '自动检测', cuda: 'NVIDIA GPU', cpu: 'CPU' }
  if (want !== '' && config.sttBackend === 'sherpa') {
    reply(api, '当前转写后端为 sherpa（SenseVoice），设备设置仅对 whisper 后端生效。如需调整请先 /voice backend whisper 切换后再操作。')
    return
  }
  const actual = await whisperDevice(config)
  if (want === '') {
    const list = Object.entries(DEVICE_NAMES)
      .map(([name, note]) => `  ${name}${name === config.whisperDevice ? '（当前）' : ''} — ${note}`)
      .join('\n')
    reply(
      api,
      `推理设备：${DEVICE_NAMES[config.whisperDevice] ?? config.whisperDevice}（配置）\n服务端实际：${actual ?? '不可达'}\n可用设备：\n${list}\n切换：/voice device <cpu|gpu|auto>`,
    )
    return
  }
  const target = want === 'gpu' ? 'cuda' : want === 'cpu' ? 'cpu' : want === 'auto' ? 'auto' : null
  if (!target) {
    reply(api, `未知设备：${want}。可用：cpu / gpu / auto`)
    return
  }
  if (target === config.whisperDevice) {
    reply(api, `已在使用 ${want} 推理`)
    return
  }
  if (target === 'cuda') {
    // GPU 预检：安卓直接拒绝；linux/windows 需 nvidia-smi 可见（2026-08-15 用户报告：
    // 安卓切 gpu 空转重启后才发现不可达）
    const kind = platformOf(config).kind
    const hasNvidiaSmi = kind === 'termux' ? false : (await runCommand('nvidia-smi', [], { timeoutMs: 5000 })).code === 0
    const reason = gpuSwitchBlockReason(kind, hasNvidiaSmi)
    if (reason) {
      reply(api, reason)
      return
    }
  }
  if (dictation.isRecording() || dictation.isTranscribing()) {
    reply(api, '请先停止录音/等待转写完成再切换设备')
    return
  }
  try {
    persistConfig({ whisperDevice: target as VoiceConfig['whisperDevice'] }, process.env)
  } catch (e) {
    reply(api, `配置写入失败：${(e as Error).message}`)
    return
  }
  ctx.ui.setStatus('pi-voice', '⚙ 切换推理设备并重启服务…')
  reply(api, `正在切换到 ${want}（重启服务）…`)
  const res = await runCommand('bash', [config.whisperScript, 'restart'], { timeoutMs: 120000 })
  ctx.ui.setStatus('pi-voice', undefined)
  if (res.code !== 0) {
    reply(api, `服务重启命令失败：${res.stderr || res.stdout}`)
    return
  }
  config = loadConfig()
  // 轮询 health 直到服务端实际设备匹配（auto = 任意已加载设备）
  const deadline = Date.now() + 120000
  let ok = false
  while (Date.now() < deadline) {
    const d = await whisperDevice(config)
    if (d && (target === 'auto' || d === target)) {
      ok = true
      break
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  reply(api, ok ? `推理设备已切换为 ${want}（服务端 ${ok ? (target === 'auto' ? '已加载' : target) : ''}），服务就绪` : `设备切换中（服务加载较慢），可用 /voice doctor 查看状态`)
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
    const data = (await res.json()) as { ok?: boolean; model?: string; device?: string }
    return data.ok ? (data.model ?? null) : null
  } catch {
    return null
  }
}

/** 查询服务端实际推理设备（health 返回 device；服务端加载后才有值）。 */
async function whisperDevice(cfg: VoiceConfig): Promise<string | null> {
  try {
    const headers: Record<string, string> = {}
    if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
    const res = await fetch(`${cfg.whisperEndpoint}/health`, { headers, signal: AbortSignal.timeout(3000) })
    const data = (await res.json()) as { device?: string }
    return data.device ?? null
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
