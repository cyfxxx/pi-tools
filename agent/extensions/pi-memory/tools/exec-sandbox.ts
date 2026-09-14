import { spawn } from 'node:child_process'
import { recordToolUsage, estimateTokens } from '../../../lib/context-budget.ts'
import { recordOutput, pruneToolOutput } from '../../../lib/prune.ts'

const LANGUAGES: Record<string, { cmd: string; args: string[] }> = {
  js: { cmd: process.argv[0], args: ['-e'] },
  ts: { cmd: process.argv[0], args: ['-e'] },
  python: { cmd: 'python3', args: ['-c'] },
  shell: { cmd: 'bash', args: ['-c'] },
}

function detectLanguage(code: string): string {
  const firstLine = code.trim().split('\n')[0] || ''
  if (/^#!/.test(firstLine)) {
    if (/\bpython/.test(firstLine)) return 'python'
    if (/\bbash\b/.test(firstLine) || /\bsh\b/.test(firstLine)) return 'shell'
    if (/\bnode\b/.test(firstLine)) return 'js'
  }
  return 'js'
}

async function execLanguageAsync(
  language: string,
  code: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; status: number | null; error?: string }> {
  const lang = LANGUAGES[language]
  if (!lang) {
    return {
      stdout: '',
      stderr: '',
      status: null,
      error: `Unsupported language: "${language}". Supported: ${Object.keys(LANGUAGES).join(', ')}`,
    }
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(
    () => timeoutController.abort(new Error(`Timeout after ${timeout}ms`)),
    timeout,
  )
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  try {
    const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>(
      (resolve, reject) => {
        const proc = spawn(lang.cmd, [...lang.args, code], {
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: combinedSignal,
        })

        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

        proc.on('close', status => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status }))
        proc.on('error', err => reject(err))
      },
    )
    return result
  } catch (err: unknown) {
    return { stdout: '', stderr: '', status: null, error: (err as Error).message }
  } finally {
    clearTimeout(timeoutId)
  }
}

export function registerExecTool(pi: { registerTool: (def: unknown) => void }): void {
  pi.registerTool({
    name: 'ctx_exec',
    label: 'Execute Code',
    description:
      '在子进程中执行代码（JS/TS/Python/Shell），仅 stdout 进入上下文。适合聚合处理多个文件后打印结果，代替逐个读文件。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to execute' },
        language: {
          type: 'string',
          description: "Language: 'js' (default), 'python', 'shell'. Auto-detected from shebang if omitted.",
        },
        description: { type: 'string', description: 'Brief description of what this does' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
        max_output: { type: 'number', description: 'Max output chars (default 2000). Use 0 for unlimited.' },
      },
    },
    async execute(_id: unknown, params: Record<string, unknown>, signal: AbortSignal | undefined) {
      const maxOutput = params.max_output as number | undefined
      const cap = maxOutput === undefined ? 2000 : maxOutput === 0 ? Infinity : maxOutput
      const code = params.code as string
      const timeout = (params.timeout as number | undefined) ?? 30000
      const language = (params.language as string | undefined) || detectLanguage(code)
      const { stdout, stderr, status, error } = await execLanguageAsync(language, code, timeout, signal)
      if (error) {
        return { content: [{ type: 'text', text: `Error: ${error}` }], details: null, isError: true }
      }
      if (status !== 0) {
        return { content: [{ type: 'text', text: `Exit code ${status}\n${stderr || stdout}` }], details: null, isError: true }
      }
      let output = stdout || '(no output)'
      if (Number.isFinite(cap) && output.length > cap) {
        const ratio = Math.round((cap / output.length) * 100)
        output = `${output.slice(0, cap)}\n\n[truncated: ${output.length} chars → ${cap} chars (${ratio}%)]`
      }
      const pruned = pruneToolOutput(output, 'ctx_exec')
      recordToolUsage('ctx_exec', estimateTokens(pruned))
      recordOutput('ctx_exec', pruned.length)
      return { content: [{ type: 'text', text: pruned }], details: { stderr: stderr || undefined } }
    },
  })
}
