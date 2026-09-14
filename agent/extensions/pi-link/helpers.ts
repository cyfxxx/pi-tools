/**
 * pi-link helpers — shared utilities
 */
import type { LinkConfig } from './config.ts'

export function fmtResult(r: { ok: boolean; reply?: string; turns: number; tools: number; durationSec: number; error?: string; model?: string }): string {
  const head = `[完成] ${r.durationSec}s, ${r.turns} 轮工具交互, ${r.tools} 次工具调用${r.model ? `, 模型 ${r.model}` : ''}`
  if (!r.ok) return `${head}\n错误: ${r.error}`
  return `${head}\n${r.reply}`
}

export function cfgPathOf(): string {
  return process.env.PI_LINK_CONFIG ?? ''
}

export function ok(text: string, details?: unknown) {
  return { content: [{ type: 'text' as const, text }], details: details ?? null }
}

export function err(text: string) {
  return { content: [{ type: 'text' as const, text }], details: null, isError: true }
}

export function listDevices(cfg: LinkConfig): string {
  return Object.keys(cfg.devices).join(', ') || '(无)'
}

export function helpText(): string {
  return [
    'pi-link 多设备互联：让本机 pi 与其他设备（局域网/Tailscale）的 pi 通信',
    '',
    '用法:',
    '  /link send <设备> <消息>   向目标设备的 pi 发送消息并等待回复（无人值守拒绝）',
    '  /link watch <设备> [--lines N]   观察远程 pi 会话尾部（模型间沟通可见）',
    '  /link attach <设备> [--force] <文本>   介入远程 pi 输入框（busy 拒绝/--force）',
    '  /link status               设备清单与连通性探测',
    '  /link inbox <设备>         读取远程信箱（远程自主完成的回复记录）',
    '  /link export-card         生成本机设备卡片（含 IP/用户）',
    '  /link import-card <JSON>  导入设备卡片并写入配置',
    '  /link help                 本帮助',
    '',
    '工具:',
    '  link_send(device, message, timeoutSec?)  — 同上，供模型直接调用',
    '  link_status()                            — 设备清单与连通性',
    '',
    '边界:',
    '  单条确定性命令请直接用 ssh 执行（更快更省 token）；',
    '  link_send 用于需要远程 pi 自主多步处理的任务（判断/纠错/报告）',
    '',
    '配置 ~/.pi/pi-link.json（示例）:',
    '  { "devices": { "phone": { "host": "100.101.102.103", "user": "u0_a123",',
    '      "port": 8022, "timeoutSec": 600 } } }',
    '',
    '安全:',
    '  · 走 SSH 密钥认证（建议 Tailscale 私有网络内使用）',
    '  · 远程默认 --no-extensions 启动（不暴露远程记忆、不触发 plan-mode/autopilot）',
    '  · 加固可选: 目标设备 authorized_keys 用 command="~/.pi/scripts/pi-link-entry.sh" 限制',
  ].join('\n')
}
