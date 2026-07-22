import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { spawn } from "node:child_process"
import { recordToolUsage, estimateTokens } from "../../lib/token-budget.ts"
import { recordOutput, pruneToolOutput } from "../../lib/prune.ts"
import {
  DATA_DIR,
  NOTES_FILE,
  CHECKPOINTS_DIR,
  ensureDir,
  loadNotes,
  saveNotes,
  clearCompactionFlag,
  MAX_NOTES_SIZE,
  getTotalSize,
} from "../../lib/note-store.ts"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { join } from "node:path"

const MAX_CHECKPOINTS_LIST = 100

const LANGUAGES: Record<string, { cmd: string; args: string[] }> = {
  js: { cmd: process.argv[0], args: ["-e"] },
  ts: { cmd: process.argv[0], args: ["-e"] },
  python: { cmd: "python3", args: ["-c"] },
  shell: { cmd: "bash", args: ["-c"] },
}

interface SnapData {
  timestamp: number
  notes: Record<string, string>
  compaction?: boolean
}

function detectLanguage(code: string): string {
  const firstLine = code.trim().split("\n")[0] || ""
  if (/^#!/.test(firstLine)) {
    if (/\bpython/.test(firstLine)) return "python"
    if (/\bbash\b/.test(firstLine) || /\bsh\b/.test(firstLine)) return "shell"
    if (/\bnode\b/.test(firstLine)) return "js"
  }
  return "js"
}

async function execLanguageAsync(
	language: string,
	code: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; status: number | null; error?: string }> {
	const lang = LANGUAGES[language]
	if (!lang) {
		return { stdout: "", stderr: "", status: null, error: `Unsupported language: "${language}". Supported: ${Object.keys(LANGUAGES).join(", ")}` }
	}

	const timeoutController = new AbortController()
	const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Timeout after ${timeout}ms`)), timeout)
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal

	try {
		const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
			const proc = spawn(lang.cmd, [...lang.args, code], {
				env: { ...process.env, NODE_NO_WARNINGS: "1" },
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
				signal: combinedSignal,
			})

			let stdout = ""
			let stderr = ""
			proc.stdout.on("data", (data: Buffer) => { stdout += data.toString() })
			proc.stderr.on("data", (data: Buffer) => { stderr += data.toString() })

			proc.on("close", (status) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status }))
			proc.on("error", (err) => reject(err))
		})
		return result
	} catch (err: any) {
		return { stdout: "", stderr: "", status: null, error: err.message }
	} finally {
		clearTimeout(timeoutId)
	}
}

export default function (pi: ExtensionAPI) {
  ensureDir()

  // ── ctx_exec — execute code in a child process ──
  pi.registerTool({
    name: "ctx_exec",
    label: "Execute Code",
    description:
      "Execute code (JS/TS/Python/Shell) in a child process. Only stdout enters the context window. " +
      "Use this instead of reading many files — write a script to aggregate data and print the result.",
    parameters: Type.Object({
      code: Type.String({ description: "Code to execute" }),
      language: Type.Optional(
        Type.String({
          description: "Language: 'js' (default), 'python', 'shell'. Auto-detected from shebang if omitted.",
        }),
      ),
      description: Type.Optional(Type.String({ description: "Brief description of what this does" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)" })),
      max_output: Type.Optional(
        Type.Number({ description: "Max output chars (default 2000). Use 0 for unlimited." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const maxOutput = params.max_output as number | undefined
      const cap = maxOutput === undefined ? 2000 : maxOutput === 0 ? Infinity : maxOutput
      const { code, timeout = 30000 } = params
      const language = params.language || detectLanguage(code)
      const { stdout, stderr, status, error } = await execLanguageAsync(language, code, timeout, signal)
      if (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
          details: {},
        }
      }
      if (status !== 0) {
        return {
          content: [{ type: "text", text: `Exit code ${status}\n${stderr || stdout}` }],
          isError: true,
          details: {},
        }
      }
      let output = stdout || "(no output)"
      if (Number.isFinite(cap) && output.length > cap) {
        const ratio = Math.round((cap / output.length) * 100)
        output = `${output.slice(0, cap)}\n\n[truncated: ${output.length} chars → ${cap} chars (${ratio}%)]`
      }
      recordToolUsage("ctx_exec", estimateTokens(output))
      const pruned = pruneToolOutput(output, "ctx_exec")
      recordOutput("ctx_exec", pruned.length)
      return {
        content: [{ type: "text", text: pruned }],
        details: { stderr: stderr || undefined },
      }
    },
  })

  // ── ctx_note — persistent key-value store ──
  pi.registerTool({
    name: "ctx_note",
    label: "Store Note",
    description:
      "Store a note that survives conversation compaction. Use this to remember " +
      "file edits, task status, user decisions, errors, or any state across compactions. " +
      "Set value to 'null' to delete. Append '@ttl=<ISO timestamp>' to key (e.g. 'task.status@ttl=2026-12-31T23:59:59Z') to auto-expire.",
    parameters: Type.Object({
      key: Type.String({ description: "Note key (dot notation for namespacing, e.g. 'task.current'). Append '@ttl=ISO_TIMESTAMP' for auto-expire." }),
      value: Type.Optional(Type.String({ description: "Value to store. Omit to read. Set to 'null' to delete." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const notes = loadNotes()
      const rawKey = params.key
      let key = rawKey
      let ttl: string | undefined

      // Parse @ttl suffix
      const ttlMatch = rawKey.match(/^(.*)@ttl=(.+)$/)
      if (ttlMatch) {
        key = ttlMatch[1]
        ttl = ttlMatch[2]
      }

      if (params.value === undefined) {
        return {
          content: [{ type: "text", text: notes[key] !== undefined ? notes[key] : `(no note for "${key}")` }],
          details: {},
        }
      }
      if (params.value === "null" || params.value === null) {
        const hadKey = key in notes
        delete notes[key]
        const ttlKey = `__ttl_${key}`
        delete notes[ttlKey]
        saveNotes(notes)
        return {
          content: [{ type: "text", text: hadKey ? `Deleted note "${key}"` : `(no note "${key}" to delete)` }],
          details: {},
        }
      }

      notes[key] = params.value
      // Set TTL if specified
      const ttlKey = `__ttl_${key}`
      if (ttl) {
        notes[ttlKey] = ttl
      } else {
        delete notes[ttlKey]
      }
      saveNotes(notes)

      // Warn if total notes size is large
      const totalSize = getTotalSize(notes)
      const valueKB = (params.value.length / 1024).toFixed(1)
      let msg = `Saved note "${key}" (${valueKB} KB)`
      if (totalSize > MAX_NOTES_SIZE) {
        const sizeMB = (totalSize / (1024 * 1024)).toFixed(1)
        msg += `\nWarning: total notes size ${sizeMB} MB exceeds 1 MB — consider cleaning up with /ctx-lite:cleanup`
      }
      if (ttl) msg += `\nExpires: ${ttl}`
      return { content: [{ type: "text", text: msg }], details: {} }
    },
  })

  // ── ctx_list — list notes ──
  pi.registerTool({
    name: "ctx_list",
    label: "List Notes",
    description: "List all stored note keys with their sizes. Use detail:true to show values.",
    parameters: Type.Object({
      prefix: Type.Optional(Type.String({ description: "Filter by key prefix (e.g. 'task')" })),
      detail: Type.Optional(Type.Boolean({ description: "Show full values (default false)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const notes = loadNotes()
      const allKeys = Object.keys(notes).filter((k) => !k.startsWith("__"))
      const keys = params.prefix
        ? allKeys.filter((k) => k.startsWith(params.prefix!))
        : allKeys
      if (keys.length === 0) {
        return { content: [{ type: "text", text: "(no notes)" }], details: {} }
      }
      const totalSize = getTotalSize(loadNotes())
      const lines = keys.map((k) => {
        const v = notes[k]
        const size = v ? (v.length / 1024).toFixed(1) : "0"
        // Show TTL if present
        const ttlKey = `__ttl_${k}`
        const ttl = notes[ttlKey]
        const ttlStr = ttl ? ` [expires: ${ttl}]` : ""
        if (params.detail) {
          const val = v ? (v.length > 200 ? v.slice(0, 200) + "..." : v) : ""
          return `  ${k}  (${size} KB)${ttlStr}\n    ${val.replace(/\n/g, "\n    ")}`
        }
        return `  ${k}  (${size} KB)${ttlStr}`
      })
      const totalMB = (totalSize / (1024 * 1024)).toFixed(2)
      return {
        content: [{ type: "text", text: `Notes (${keys.length}):\n${lines.join("\n")}\nTotal: ${totalMB} MB` }],
        details: {},
      }
    },
  })

  // ── ctx_snap — manual session checkpoint ──
  pi.registerTool({
    name: "ctx_snap",
    label: "Save Checkpoint",
    description:
      "Save a named checkpoint of current notes + timestamp. " +
      "Use 'restore:<name>' to restore. Use 'list' to see all checkpoints. " +
      "Useful before risky operations or at natural milestones.",
    parameters: Type.Object({
      name: Type.String({
        description: "Checkpoint name (e.g. 'before-refactor'). Use 'restore:<name>' to restore. Use 'list' to list all.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      ensureDir()
      const { name } = params

      if (name === "list") {
        const files = readdirSync(CHECKPOINTS_DIR)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .reverse()
          .slice(0, MAX_CHECKPOINTS_LIST)
        if (files.length === 0) {
          return { content: [{ type: "text", text: "(no checkpoints)" }], details: {} }
        }
        const lines = files.map((f) => {
          const snapName = f.replace(/\.json$/, "")
          try {
            const data: SnapData = JSON.parse(readFileSync(join(CHECKPOINTS_DIR, f), "utf-8"))
            const isAuto = data.compaction ? " [auto]" : ""
            const time = new Date(data.timestamp).toISOString()
            const noteCount = Object.keys(data.notes || {}).length
            const size = statSync(join(CHECKPOINTS_DIR, f)).size
            return `  ${snapName}${isAuto}  (${noteCount} notes, ${(size / 1024).toFixed(1)} KB, ${time})`
          } catch {
            return `  ${snapName}  (corrupted)`
          }
        })
        return {
          content: [{ type: "text", text: `Checkpoints (${files.length}):\n${lines.join("\n")}` }],
          details: {},
        }
      }

      if (name.startsWith("restore:")) {
        const snapName = name.slice(8)
        const snapFile = join(CHECKPOINTS_DIR, `${snapName}.json`)
        if (!existsSync(snapFile)) {
          return { content: [{ type: "text", text: `No checkpoint "${snapName}" found` }], isError: true, details: {} }
        }
        try {
          const data: SnapData = JSON.parse(readFileSync(snapFile, "utf-8"))
          saveNotes(data.notes || {})
          return {
            content: [{ type: "text", text: `Restored checkpoint "${snapName}" (${Object.keys(data.notes || {}).length} notes, from ${new Date(data.timestamp).toISOString()})` }],
            details: {},
          }
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to restore: ${e.message}` }], isError: true, details: {} }
        }
      }

      const notes = loadNotes()
      const snap: SnapData = { timestamp: Date.now(), notes }
      writeFileSync(join(CHECKPOINTS_DIR, `${name}.json`), JSON.stringify(snap, null, 2))
      return {
        content: [{ type: "text", text: `Saved checkpoint "${name}" (${Object.keys(notes).length} notes, ${new Date(snap.timestamp).toISOString()})` }],
        details: {},
      }
    },
  })

  // ── Auto-save notes + mark compaction ──
  pi.on("session_before_compact", async () => {
    const notes = loadNotes()
    // Mark that compaction happened (survives across compaction)
    notes["_ctx.compacted_at"] = new Date().toISOString()
    saveNotes(notes)

    if (Object.keys(notes).filter(k => !k.startsWith("__") && k !== "_ctx.compacted_at").length > 0) {
      const snap: SnapData = { timestamp: Date.now(), notes, compaction: true }
      writeFileSync(join(CHECKPOINTS_DIR, `__compaction_${Date.now()}.json`), JSON.stringify(snap, null, 2))
      const files = readdirSync(CHECKPOINTS_DIR)
        .filter((f) => f.startsWith("__compaction_"))
        .sort()
        .reverse()
      for (const f of files.slice(5)) {
        rmSync(join(CHECKPOINTS_DIR, f))
      }
    }
  })

  // ── Notify on session start + detect compaction recovery ──
  pi.on("session_start", async (_event, ctx) => {
    const notes = loadNotes()
    const count = Object.keys(notes).length

    // Detect recent compaction: _ctx.compacted_at within last 30s
    const compactedAt = notes["_ctx.compacted_at"]
    if (compactedAt) {
      const age = Date.now() - new Date(compactedAt).getTime()
      if (age < 30_000) {
        notes["_ctx.just_compacted"] = "true"
        saveNotes(notes)
      }
    }

    if (count > 0 && ctx.hasUI) {
      const totalSize = getTotalSize(notes)
      const sizeMB = (totalSize / (1024 * 1024)).toFixed(2)
      let msg = `ctx-lite: ${count} notes (${sizeMB} MB)`
      if (totalSize > MAX_NOTES_SIZE) msg += " — OVER 1 MB, consider /ctx-lite:cleanup"
      msg += ", /ctx-lite:status for details"
      ctx.ui.notify(msg, "info")
    }
  })

  // ── /ctx-lite:status ──
  pi.registerCommand("ctx-lite:status", {
    description: "显示 ctx-lite 状态：笔记数、检查点数、数据目录大小、总存储大小",
    handler: async (_args, ctx) => {
      const notes = loadNotes()
      const noteKeys = Object.keys(notes).filter((k) => !k.startsWith("__"))
      const totalSize = getTotalSize(notes)
      const totalKB = (totalSize / 1024).toFixed(1)
      const totalMB = (totalSize / (1024 * 1024)).toFixed(2)
      const checkpoints = existsSync(CHECKPOINTS_DIR)
        ? readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith(".json"))
        : []
      const autoCp = checkpoints.filter((f) => f.startsWith("__compaction_")).length
      const manualCp = checkpoints.length - autoCp

      let dataSize = "?"
      try {
        const entries = readdirSync(DATA_DIR, { recursive: true }) as string[]
        dataSize = `${entries.length} files`
      } catch {
        /* ignore */
      }

      const warn = totalSize > MAX_NOTES_SIZE ? " ⚠ exceeds 1 MB" : ""
      ctx.ui.notify(
        [
          "ctx-lite",
          `  Notes: ${noteKeys.length} (${totalKB} KB / ${totalMB} MB)${warn}`,
          `  Checkpoints: ${checkpoints.length} (auto: ${autoCp}, manual: ${manualCp})`,
          `  Data dir: ${DATA_DIR} (${dataSize})`,
        ].join("\n"),
        "info",
      )
    },
  })

  // ── /ctx-lite:cleanup ──
  pi.registerCommand("ctx-lite:cleanup", {
    description: "清理过期笔记和旧检查点。--keep <N> 保留最近 N 个自动检查点。--dry-run 仅预览不执行",
    handler: async (args, ctx) => {
      const keepMatch = args.match(/--keep\s+(\d+)/)
      const keep = keepMatch ? parseInt(keepMatch[1], 10) : 10
      const dryRun = args.includes('--dry-run')

      // 1. Clean TTL notes via loadNotes
      loadNotes()

      // 2. Prune auto-checkpoints
      const autoFiles = readdirSync(CHECKPOINTS_DIR)
        .filter((f) => f.startsWith("__compaction_"))
        .sort()
        .reverse()
      let removed = 0
      for (const f of autoFiles.slice(keep)) {
        if (!dryRun) rmSync(join(CHECKPOINTS_DIR, f))
        removed++
      }

      // 3. Report
      const notes = loadNotes()
      const noteCount = Object.keys(notes).filter((k) => !k.startsWith("__")).length
      const totalSize = getTotalSize(notes)
      const checkpoints = readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith(".json"))

      ctx.ui.notify(
        [
          `${dryRun ? '[DRY-RUN] ' : ''}Cleanup complete:`,
          `  Notes: ${noteCount} (${(totalSize / 1024).toFixed(1)} KB)`,
          `  Auto-checkpoints kept: ${Math.min(autoFiles.length, keep)}, would remove: ${removed}${dryRun ? ' (skipped)' : ''}`,
          `  Total checkpoints: ${checkpoints.length}`,
        ].join("\n"),
        "info",
      )
    },
  })

  // ── /ctx-lite:forget ──
  pi.registerCommand("ctx-lite:forget", {
    description: "删除所有笔记和检查点",
    handler: async (_args, ctx) => {
      const notes = loadNotes()
      const noteCount = Object.keys(notes).filter((k) => !k.startsWith("__")).length
      const cpCount = existsSync(CHECKPOINTS_DIR)
        ? readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith(".json")).length
        : 0
      const choice = await ctx.ui.confirm(
        "清除所有 ctx-lite 数据？",
        `这将删除 ${noteCount} 条笔记和 ${cpCount} 个检查点。此操作不可撤销。`,
      )
      if (!choice) return
      if (existsSync(CHECKPOINTS_DIR)) rmSync(CHECKPOINTS_DIR, { recursive: true })
      saveNotes({})
      ctx.ui.notify(`Cleared all ctx-lite data (${noteCount} notes, ${cpCount} checkpoints)`, "info")
    },
  })
}
