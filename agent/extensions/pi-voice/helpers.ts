/**
 * pi-voice helpers — environment detection, patch detection, UI utilities
 */
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const OUTPUT_CUSTOM_TYPE = 'cmd-output'
export const ENTER_DEBOUNCE_MS = 800
export const REPLY_RETRY_DELAY_MS = 1000
export const REPLY_RETRY_LIMIT = 10
export const WHISPER_MODELS: Record<string, string> = {
  tiny: '最快，准确率一般',
  base: '默认，速度/准确率均衡',
  small: '更准，速度较慢',
  medium: '准确，手机 CPU 较慢',
  'large-v3': '最准，手机 CPU 极慢，不推荐',
}
export const ENTER_PATCH_MARKER = 'Patch (patch-voice-enter.mjs)'

/** 检测当前是否为 Termux 环境 */
export function detectIsTermux(): boolean {
  try {
    execFileSync('which', ['termux-microphone-record'], { stdio: 'ignore' })
    return true
  } catch {
    // 不存在
  }
  if (process.env.PREFIX?.includes('com.termux')) return true
  if (existsSync('/data/data/com.termux')) return true
  return false
}

/**
 * 探测核心补丁是否已应用（scripts/patch-voice-enter.mjs）。
 */
export function enterPatchApplied(): boolean {
  try {
    const dist = detectDistFromPath(process.env.PI_DIST)
    const target = join(dist, 'modes', 'interactive', 'interactive-mode.js')
    if (!existsSync(target)) return false
    return readFileSync(target, 'utf-8').includes(ENTER_PATCH_MARKER)
  } catch {
    return false
  }
}

export function detectDistFromPath(explicit?: string): string {
  if (explicit && existsSync(join(explicit, 'modes', 'interactive', 'interactive-mode.js'))) return explicit

  try {
    const piNodeDir = join(homedir(), '.local', 'share', 'pi-node')
    if (existsSync(piNodeDir)) {
      for (const d of readdirSync(piNodeDir)) {
        const cand = join(piNodeDir, d, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
        if (existsSync(join(cand, 'modes', 'interactive', 'interactive-mode.js'))) return cand
      }
    }
  } catch {
    // fall through
  }

  try {
    let bin: string
    if (process.platform === 'win32') {
      bin = execFileSync('where', ['pi'], { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0]
    } else {
      bin = execFileSync('which', ['pi'], { encoding: 'utf-8' }).trim()
    }

    if (bin) {
      let resolved: string
      if (process.platform === 'win32') {
        try {
          const escapedBin = bin.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          const psCmd = '(Get-Item "' + escapedBin + '").Target'
          resolved = execFileSync(
            'powershell',
            ['-NoProfile', '-Command', psCmd],
            { encoding: 'utf-8', windowsHide: true }
          ).trim()
          if (!resolved || !existsSync(resolved)) resolved = bin
        } catch {
          resolved = bin
        }
      } else {
        resolved = execFileSync('readlink', ['-f', bin], { encoding: 'utf-8' }).trim()
      }

      const m = resolved.match(/(.*node_modules\/@earendil-works\/pi-coding-agent\/)/)
      if (m && existsSync(join(m[1], 'dist', 'modes', 'interactive', 'interactive-mode.js'))) {
        return join(m[1], 'dist')
      }
    }
  } catch {
    // fall through
  }

  const envDist = process.env.PI_DIST
  if (envDist && existsSync(join(envDist, 'modes', 'interactive', 'interactive-mode.js'))) {
    return envDist
  }

  return '/nonexistent'
}

export function reply(api: ExtensionAPI, text: string): void {
  const send = (): boolean => {
    try {
      api.sendMessage({ customType: OUTPUT_CUSTOM_TYPE, content: text, display: true })
      return true
    } catch {
      return false
    }
  }
  if (send()) return
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    if (send() || attempts >= REPLY_RETRY_LIMIT) clearInterval(timer)
  }, REPLY_RETRY_DELAY_MS)
  timer.unref()
}

export function withStatus(api: ExtensionAPI, ctx: ExtensionContext, message: string, autoSetTts: (enabled: boolean) => void): void {
  if (message.startsWith('🎤')) {
    ctx.ui.setStatus('pi-voice', '⏳ 启动麦克风中…')
    autoSetTts(true)
  } else {
    ctx.ui.setStatus('pi-voice', undefined)
  }
  reply(api, message)
}
