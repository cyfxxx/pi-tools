const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  // find 的破坏性动作：-delete 删除、-exec/-ok 执行、-fprint/-fprintf 写文件
  /\bfind\b[^\n;|&]*\s(-delete|-exec|-execdir|-ok|-fprint|-fprintf)\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  // curl/wget 落盘即破坏（curl -o/-O/--output=/--output 写文件、wget 非 -O - 时写文件）
  /\bcurl\b[^\n;|&]*\s(-o\s|-o\S|--output\s|--output=|-O\s|--remote-name)/i,
  /\bwget\b(?!\s+-O\s*-)/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  // sed w 命令写文件：地址+[0-9,$,/]w file 或独立 w file（GNU sed 仅 -n 只读放行）
  /\bsed\b[^\n;|&]*([0-9,$/]+w\s|\bw\s)\S/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*lsblk\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

/**
 * 规划模式 bash 只读校验。
 * 借鉴 opencode 的"模式只是提示词、机制要可预期"思路，放宽两处高频误拦：
 *  1. `cd <目录> && <单条白名单命令>` 前缀（模型习惯性打包导航）
 *  2. 命令尾部 `2>/dev/null`（丢弃 stderr，非落盘）
 * 其余复合（`;`、管道、`&&` 多重、命令替换、重定向到文件）一律拒绝。
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 尾部 2>/dev/null：允许且仅允许这一种重定向形态
  const withStderrDiscard = /\s*2\s*>\s*\/dev\/null\s*$/.test(trimmed);
  const core0 = withStderrDiscard ? trimmed.replace(/\s*2\s*>\s*\/dev\/null\s*$/, "").trimEnd() : trimmed;
  if (!withStderrDiscard) {
    // 未剥离的其它重定向一律拒绝（> / >> / 2> 非 /dev/null / 2>&1 等）
    if (/>|>>/.test(core0)) return false;
  }
  // 剥离后不得再出现重定向（如 `ls 2>/dev/null > out`）
  if (withStderrDiscard && />|>>/.test(core0)) return false;

  // cd 前缀：cd <dir> && <核心命令>（核心命令仍须整体单条白名单）
  const cdMatch = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(core0);
  const core = /* cd 前缀剥离 */ cdMatch ? core0.slice(cdMatch[0].length).trim() : core0;
  if (cdMatch && core.includes("&&")) return false;

  // 核心不得出现分隔符/命令替换（管道、分号、多个 &&、反引号、$()、换行）
  // 换行注入（审计实测）：'ls\nbash /tmp/x.sh' 以白名单命令开头时整串放行，
  // 换行后的第二条命令不受任何白名单约束
  if (/[;&|&]|`|\$\(|\n|\r/.test(core)) return false;

  // awk 白名单存在任意执行/读文件形态（审计实测 system(...) 放行）——
  // 收紧：禁止 system/getline（含无括号语句形态）与重定向
  if (/^\s*awk\b/i.test(core) && /\b(system|getline)\b|>\s*\S/.test(core)) return false;

  // curl 白名单存在外传形态（审计实测 -T/--upload-file、-d @file、-F file=@ 均放行）——
  // 收紧为 GET-only 查询
  if (/^\s*curl\b/i.test(core) && /(^|\s)(-T|--upload-file|--data|--data-binary|-d|--form|-F)(\s|=)/.test(core)) return false;

  return !DESTRUCTIVE_PATTERNS.some((p) => p.test(core)) && SAFE_PATTERNS.some((p) => p.test(core))
}

/**
 * 规划模式 subagent 拦截判定（参考 opencode explore 只读隔离模式）。
 * 已启用：PLAN_MODE_TOOLS/NORMAL_MODE_TOOLS 均含 subagent，tool_call 拦截处调用本函数。
 * 参数形状对齐 subagent 工具
 * single { agent?, task } / parallel { tasks[] } / chain { chain[] }。
 */
export function assertPlanSubagentAllowed(input: unknown): string | null {
  const arg = (input ?? {}) as { agent?: unknown; tasks?: unknown; chain?: unknown };
  const agents: unknown[] = [];
  if (Array.isArray(arg.tasks)) agents.push(...arg.tasks.map((t) => (t as { agent?: unknown })?.agent));
  else if (Array.isArray(arg.chain)) agents.push(...arg.chain.map((t) => (t as { agent?: unknown })?.agent));
  else agents.push(arg.agent);
  const names = agents.map((a) => (typeof a === "string" ? a : ""));
  if (names.some((n) => n !== "scout")) {
    return `规划模式: subagent 仅允许显式指定只读的 scout 子代理（未指定或 worker/reviewer 均不可用，未指定会落到可写的 general-purpose）。使用 subagent agent="scout" 或退出规划模式。`;
  }
  return null;
}

import type { Task, TaskState } from "./state.ts";

/** 任务名称截断：聊天/命令展示用，避免超长 subject 撑满界面 */
export function truncateSubject(subject: string, max = 40): string {
  const s = (subject || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 规范化任务标题：小写、去标点、折叠空白。用于任务匹配与去重。
 */
export function normalizeSubject(subject: string): string {
  return (subject || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 字符串相似度（Dice 系数，bigram 集合） */
function diceSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Map<string, number> => {
    const out = new Map<string, number>();
    if (s.length < 2) {
      out.set(s, 1);
      return out;
    }
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  for (const [g, n] of ga) {
    inter += Math.min(n, gb.get(g) ?? 0);
  }
  const total =
    [...ga.values()].reduce((x, y) => x + y, 0) +
    [...gb.values()].reduce((x, y) => x + y, 0);
  return total === 0 ? 0 : (2 * inter) / total;
}

const MIN_MATCH_LENGTH = 2;
const MIN_SIMILARITY_LENGTH = 4;
const MATCH_SIMILARITY = 0.6;

/**
 * 将新版计划步骤合并进现有任务列表（修订替换语义）：
 * - 未完成任务（pending/in_progress/blocked）与新步骤按 subject 匹配：
 *   匹配 → 保留原 id 与状态，subject 更新为新文本；
 *   未匹配的 pending → 移除；未匹配的 in_progress → 降为 pending 保留；blocked → 保留原状态。
 * - completed/deleted 始终保留（完成历史不清除）。
 * - 新步骤追加新 id。
 * 返回合并结果与 added/removed 明细（供提示消息使用）。
 */
export function mergePlanRevision(
  state: TaskState,
  newSteps: Task[],
): { tasks: Task[]; nextId: number; added: Task[]; removed: Task[] } {
  const completed = state.tasks.filter(
    (t) => t.status === "completed" || t.status === "deleted",
  );
  const open = state.tasks.filter(
    (t) => t.status !== "completed" && t.status !== "deleted",
  );

  const openByNorm = new Map<string, Task>();
  for (const t of open) {
    const key = normalizeSubject(t.subject);
    if (key && !openByNorm.has(key)) openByNorm.set(key, t);
  }

  const used = new Set<number>();
  const merged: Task[] = [...completed];
  const added: Task[] = [];
  const removed: Task[] = [];
  let nextId = state.nextId;

  for (const step of newSteps) {
    const norm = normalizeSubject(step.subject);
    let match: Task | undefined;
    if (norm && norm.length >= MIN_MATCH_LENGTH) {
      match = openByNorm.get(norm);
      if (!match) {
        // 子串兜底：一方完整包含另一方（如 "修复登录页样式" vs "修复登录页的样式问题"）
        for (const t of open) {
          if (used.has(t.id)) continue;
          const normT = normalizeSubject(t.subject);
          if (!normT) continue;
          if (normT.length >= MIN_SIMILARITY_LENGTH && (normT.includes(norm) || norm.includes(normT))) {
            match = t;
            break;
          }
        }
      }
      if (!match && norm.length >= MIN_SIMILARITY_LENGTH) {
        // 相似度兜底：选未使用且相似度最高的未完成任务
        let best: Task | undefined;
        let bestScore = MATCH_SIMILARITY;
        for (const t of open) {
          if (used.has(t.id)) continue;
          const s = diceSimilarity(norm, normalizeSubject(t.subject));
          if (s > bestScore) {
            best = t;
            bestScore = s;
          }
        }
        match = best;
      }
    }
    if (match && !used.has(match.id)) {
      used.add(match.id);
      merged.push({ ...match, subject: step.subject });
    } else {
      const task: Task = { id: nextId++, subject: step.subject, status: "pending" };
      added.push(task);
      merged.push(task);
    }
  }

  for (const t of open) {
    if (used.has(t.id)) continue;
    if (t.status === "pending") {
      removed.push(t);
    } else {
      // in_progress 降为 pending（步骤已不在新版计划，清除进行中表单）；blocked 保留原状态
      merged.push(
        t.status === "in_progress"
          ? { ...t, status: "pending", activeForm: undefined }
          : t,
      );
    }
  }

  return { tasks: merged, nextId, added, removed };
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}

export function extractTodoItems(message: string): Task[] {
  const items: Task[] = [];
  // Plan 头须后跟冒号/空白/行尾（星号可闭合），避免 "**plan-mode 修订语义**" 类复合词误命中
  const headerMatch = message.match(/\*{0,2}(?:Plan|计划)\*{0,2}(?:[:：]|\s|$)[^\n]*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(
    message.indexOf(headerMatch[0]) + headerMatch[0].length,
  );
  const numberedPattern = /^\s*(\d+)(?:[.)]\s+|[、．]\s*)\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (isValidStepText(text)) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({
          id: items.length + 1,
          subject: cleaned,
          status: "pending",
        });
      }
    }
  }

  if (items.length > 0) return items;

  // 无编号时尝试 checklist 格式（- [ ] / - / • / ☐）
  const checklistPattern = /^\s*(?:[-*•☐]\s+)(?:\[[ xX]\]\s+)?([^\n]+)/gm;
  for (const match of planSection.matchAll(checklistPattern)) {
    const text = match[1].trim().replace(/\*{1,2}$/, "").trim();
    if (isValidStepText(text)) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({
          id: items.length + 1,
          subject: cleaned,
          status: "pending",
        });
      }
    }
  }
  return items;
}

function isValidStepText(text: string): boolean {
  return (
    text.length > 5 &&
    !text.startsWith("`") &&
    !text.startsWith("/") &&
    !text.startsWith("-")
  );
}

export function isPlanRevisionIntent(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  // plan-mode 自身消息副本（plan-revise/plan-progress/plan-todo-list/plan-complete）
  // 被用户转发/引用时不作为修订意图（它们本身含"修订"等词）
  if (/^\*\*计划(已修订|进度|步骤|完成)/.test(normalized)) {
    return false;
  }

  const revisionHints =
    /\b(plan|revise|change|update|modify|edit|redo|replan|remove|drop|delete|add|expand|shorten|tighten)\b|(计划|修改|改为|改成|换成|变为|变成|变更|更新|调整|重新|修订|重写|改写|重做|删|增加|新增|移除|去掉|精简|缩短)/;

  if (normalized.length < 100 && !revisionHints.test(normalized)) {
    return false;
  }

  const explicitRevision =
    /\b(revise|revision|update|change|modify|edit|adjust|rework|rewrite|regenerate|redo|replan|amend)\b/.test(
      normalized,
    ) ||
    /\b(add|include|incorporate|remove|exclude|drop|expand|shorten|tighten)\b/.test(
      normalized,
    ) ||
    /\b(plan should|new plan|another plan|updated plan|revised plan)\b/.test(
      normalized,
    ) ||
    /(修改|改为|改成|换成|变为|变成|变更|更新|调整|重新(计划|规划|制定|做|写)|修订|重做|改写|重写|重新生成|改(一)?下|改一改|增加|加入|加上|新增|移除|删除|去掉|删掉|扩展|扩大|精简|缩短|收紧|计划应该|新计划|另一个计划|新方案|新版本)/.test(
      normalized,
    );

  if (!explicitRevision) return false;

  const clarificationOnly =
    /\b(why|what|how|explain|clarify|question|rationale|tell me|help me understand)\b/.test(
      normalized,
    ) ||
    /(为什么|是什么|怎么|如何|解释一下|说明一下|疑问|原因|理由|告诉我|帮我看看|能不能解释)/.test(
      normalized,
    );

  return !clarificationOnly;
}
