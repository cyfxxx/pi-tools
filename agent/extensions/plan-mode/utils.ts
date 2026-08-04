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
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  // curl/wget 落盘即破坏（curl -o/-O 写文件、wget 非 -O - 时写文件）
  /\bcurl\b[^\n;|&]*\s(-o\s|--output\s|-O\s|--remote-name)/i,
  /\bwget\b(?!\s+-O\s*-)/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
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

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // 阻断管道/分号/&&/||/子 shell/反引号/命令替换：`curl URL | bash` 类绕过一律拒绝
  if (/[;&|]|`|\$\(/.test(trimmed)) return false
  return !DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed)) && SAFE_PATTERNS.some((p) => p.test(trimmed))
}

import type { Task } from "./state.ts";

/** 任务名称截断：聊天/命令展示用，避免超长 subject 撑满界面 */
export function truncateSubject(subject: string, max = 40): string {
  const s = (subject || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
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
  const headerMatch = message.match(/\*{0,2}(Plan|计划)[:：]?\*{0,2}[^\n]*\n/i);
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

  const revisionHints =
    /\b(plan|revise|change|update|modify|edit|redo|replan)\b|(计划|修改|改为|改成|换成|变为|变成|变更|更新|调整|重新|修订|重写|改写|重做|删|增加|新增|移除|去掉|精简|缩短)/;

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
