/**
 * secrets.ts — 密钥/敏感信息脱敏工具
 *
 * 从 pi-memory/storage.ts 提取的通用脱敏函数，
 * 供 note-store、pi-memory 等模块共用。
 */

/** 敏感信息正则模式列表 */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // GitHub token（ghp_ 个人 / gho_ OAuth / ghu_ 用户级 / ghs_ 服务器 / ghr_ 刷新 / github_pat_ 精细）
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  // OpenAI/DeepSeek 风格 API key（允许中缀连字符/下划线，如 sk-proj-xxx）
  [/\bsk-[A-Za-z0-9_-]{15,}\b/g, '[REDACTED:api-key]'],
  // AWS Access Key ID
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  // JWT（eyJ 开头三段点分隔）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  // Authorization Bearer 头
  [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, '[REDACTED:bearer-token]'],
  // PEM 私钥/证书块（RSA/EC/OpenSSH/DSA/加密私钥），可跨行；防对话中粘贴私钥原文入库（审计 MEDIUM）
  [/\b-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----\b/g, '[REDACTED:private-key]'],
  // 密码/令牌键值形态: password/secret/api_key/token/access_key = 或 :（保守长值防误伤）
  [/\b(password|passwd|secret|api[_-]?key|token|access[_-]?key)\s*[=:]\s*['\"]?[^\s'\",;\x5b]{8,}/gi, '$1=[REDACTED]'],
  // JSON 序列化形态（审计 MEDIUM）："api_key": "长值"——键后引号致上一条 [=:] 紧邻要求漏检；保留引号结构。
  // 负向前瞻跳过已脱敏值（前缀规则先行时避免二次改写丢失具体类别标记）
  [/("(?:password|passwd|secret|api[_-]?key|token|access[_-]?key)"\s*:\s*")(?!\[REDACTED)([^"]{8,})(")/gi, '$1[REDACTED]$3'],
  // Google API key（审计 LOW：AIza 前缀定长 35）
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  // Slack token（审计 LOW：xox[baprs]- 前缀）
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED:slack-token]'],
  // 注：AWS secret access key 无前缀特征（40 位裸串），裸拦误伤面大，靠上方键值/JSON 形态规则覆盖
]

/**
 * 脱敏：将文本中的敏感信息替换为 [REDACTED] 标记
 */
export function scrubSecrets(text: string): string {
  let out = text
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}
