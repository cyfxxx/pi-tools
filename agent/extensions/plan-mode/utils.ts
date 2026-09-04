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
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
  // git 写引用/配置类（审计 MEDIUM）：branch 新建、remote 写子命令、show/diff/log --output 落盘
  // --ext-diff/--textconv 显式 flag 由恶意仓库配置驱动任意执行（审计 MEDIUM；textconv 默认开启的
  // 配置驱动风险需仓库信任层管理，此处拦显式 flag fail-closed）
  /\bgit\b[^\n;|&]*\s--(no-)?(ext-diff|textconv)\b/i,
  // branch 删除/改名/拷贝等 - 开头写操作由 SAFE 白名单枚举拦截（见下方 branch 只读参数集）
  /\bgit\s+branch\s+[^-\s]/i,
  /\bgit\s+remote\s+(add|rename|set-url|remove|prune|update)/i,
  /\bgit\s+(show|diff|log)\b[^\n;|&]*--output/i,
  // find 的破坏性动作：-delete 删除、-exec/-ok 系列执行、-fls/-fprint/-fprint0/-fprintf 写文件。
  // 审计同类缺口：尾部 \b 使 -fprint0 漏拦（t 与 0 均为词字符无边界）——去尾 \b 改前缀匹配（fail-closed），
  // 同时补齐 -execdir/-okdir 执行变体与 -fls 写文件变体
  /\bfind\b[^\n;|&]*\s(-delete|-exec(dir)?|-ok(dir)?|-fls|-fprint0?|-fprintf)/i,
  // less/more 启动命令 +cmd/+!cmd 可执行任意 shell（非 LESSSECURE 环境；审计同类缺口）
  /\b(less|more)\b[^\n;|&]*\s\+\S/i,
  // bat --pager=<cmd> 任意进程执行（同 rg --pre 类；审计同类缺口）
  /\bbat\b[^\n;|&]*\s--pager(\s|=)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  // curl/wget 落盘即破坏（curl -o/-O/--output=/--output 写文件、wget 非 -O - 时写文件）
  /\bcurl\b[^\n;|&]*\s(-o\s|-o\S|--output\s|--output=|-O\s|--remote-name)/i,
  /\bwget\b(?!\s+-O\s*-)/i,
  // date 改系统时钟（审计 LOW：root 下影响缓存 TTL/调度）
  /\bdate\s+(-[^\s]*s|--set)/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  // sed w 命令写文件：地址+[0-9,$,/]w file 或独立 w file（GNU sed 仅 -n 只读放行）
  // 审计 MEDIUM：flags 含字母组合（gw/pw/Iw…）时 w 前是词字符致 \bw 失效——字符类扩入 a-z
  /\bsed\b[^\n;|&]*([0-9,$/a-z]*w\s|\bw\s)\S/i,
  // sed 执行类（审计 HIGH）：e 命令执行 shell（GNU sed -n 不抑制 e）；s///e flag 将 replacement 作 shell 命令执行
  /\bsed\b[^\n;|&]*([0-9,$/}]+e\s|\be\s)\S/i,
  /\bsed\b[^\n;|&]*s[/|,#][^'"\n]*[/|,#][^'"\n]*[/|,#][a-z,]*e[a-z,]*/i,
  // rg --pre 执行预处理命令（任意进程执行；审计 HIGH：白名单含 rg 但未拦执行类 flag）
  /\brg\b[^\n;|&]*\s(--pre|--pre-glob)(\s|=)/i,
  // fd -x/-X/--exec/--exec-batch 对每个结果执行命令（任意进程执行，同上）
  /\bfd\b[^\n;|&]*\s(-x|-X|--exec|--exec-batch)(\s|=)/i,
  // tree --infofile <f> 可落盘写文件
  /\btree\b[^\n;|&]*\s--infofile(\s|=)/i,
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
  /^\s*git\s+(status|log|diff|show|config\s+--get)/i,
  // branch 仅放行只读参数集（审计 HIGH：裸放行使 git branch -D/-m/--force 绕过删改分支）
  /^\s*git\s+branch(\s+(-a|-r|-v|-vv|--all|--list(\s+\S+)?|--show-current|--contains\s+\S+|--no-contains\s+\S+|--merged(\s+\S+)?|--no-merged(\s+\S+)?))*\s*$/i,
  // remote 仅放行只读子命令（prune/update 会按配置清理本地跟踪引用，不在此列）
  /^\s*git\s+remote(\s+-v|\s+--verbose|\s+show\s+\S+|\s+get-url\s+\S+)*\s*$/i,
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

/** 只读管道右侧允许的切片命令（无写文件能力；sed -w/sort -o 等一律不放行） */
const PIPE_TAIL_RE = /^\s*(head|tail|less|more|wc|uniq|cat|grep)\b([ \t].*)?$/;

/** 单条只读段判定：无分隔符/命令替换/换行/重定向，且命中白名单、不命中破坏性。 */
function isReadOnlyCmd(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // 单条：无 ; && | <(进程替换) >写 `< >( 重定向) 或 反引号/$() 或 换行
  if (/[;&|<>]|`|\$\(|\n|\r/.test(t)) return false;
  return !DESTRUCTIVE_PATTERNS.some((p) => p.test(t)) && SAFE_PATTERNS.some((p) => p.test(t));
}

/**
 * 规划模式 bash 只读校验。
 * 借鉴 opencode 的"模式只是提示词、机制要可预期"思路，放宽高频误拦：
 *  1. `cd <目录> && <单条白名单命令>` 前缀（模型习惯性打包导航）
 *  2. 命令尾部 `2>/dev/null`（丢弃 stderr，非落盘）
 *  3. 单一只读管道：`<只读命令> | <无写切片>`（如 curl GET URL | head，右侧限无写能力）
 * 其余复合（`;`、多管道、`&&` 多重、命令替换、重定向到文件、写落盘切片）一律拒绝。
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
  // 审计 HIGH：cd 参数先剥离后检查，参数内命令替换（$(touch)/`touch`/"$(… )"）逃过 $()/反引号
  // 检查被 shell 真实执行——剥离前先对 cd 参数本体做分隔符/替换扫描
  const cdMatch = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(core0);
  if (cdMatch && /[;&|&]|`|\$\(|\n|\r|<\(/.test(cdMatch[1])) return false;
  const core = /* cd 前缀剥离 */ cdMatch ? core0.slice(cdMatch[0].length).trim() : core0;
  if (cdMatch && core.includes("&&")) return false;

  // 单一只读管道特判：<只读单命令> | <无写切片>（左右各自单条、无写、无分隔）
  // 其余管道形态落入下面的分隔符拒绝
  const pipeIdx = core.indexOf("|");
  const singlePipe = pipeIdx >= 0 && !core.includes("|", pipeIdx + 1);
  let readOnlyPipe = false;
  if (singlePipe) {
    const lhs = core.slice(0, pipeIdx);
    const rhs = core.slice(pipeIdx + 1);
    // 审计 HIGH：RHS 仅匹配 PIPE_TAIL_RE 时尾参任意——`ls | grep $(bash x)` 命中 grep
    // 且无 > 即放行并跳过分隔符拒绝。RHS 追加 isReadOnlyCmd 全量检查（拒 $()/反引号/
    // 分号/换行），PIPE_TAIL_RE 保留为"右侧限无写切片命令"的语义约束。
    readOnlyPipe = isReadOnlyCmd(lhs) && PIPE_TAIL_RE.test(rhs.trim()) && isReadOnlyCmd(rhs);
  }
  if (!readOnlyPipe) {
    // 核心不得出现分隔符/命令替换（管道、分号、多个 &&、反引号、$()、换行）
    // 换行注入（审计实测）：'ls\nbash /tmp/x.sh' 以白名单命令开头时整串放行，
    // 换行后的第二条命令不受任何白名单约束
    if (/[;&|&]|`|\$\(|\n|\r/.test(core)) return false;
  }

  // awk 白名单存在任意执行/读文件形态（审计实测 system(...) 放行）——
  // 收紧：禁止 system/getline（含无括号语句形态）与重定向
  if (/^\s*awk\b/i.test(core) && /\b(system|getline)\b|>\s*\S/.test(core)) return false;

  // curl 白名单存在外传形态（审计实测 -T/--upload-file、-d @file、-F file=@ 均放行；
  // 审计 MEDIUM：--data-urlencode/--data-raw/--data-json/--data-ascii 此前漏拦——
  // --data 前缀后跟 `-` 不匹配 (\s|=) 锚定）——收紧为 GET-only 查询；
  // 审计 MEDIUM 同类：URL 内裸 $VAR 经 shell 展开可将环境秘密拼入查询串外带（$() 已被
  // 分隔符拒绝，剩余裸 $ 即变量展开）——curl/wget GET 段一律禁 $
  // 审计 MEDIUM：-K/--config（配置文件内 output=/data=@file 绕过命令行拦截）与独立 --json
  // （curl≥7.76 @file 读文件 POST）补拦；wget -O - 形态的 --post-file/--post-data/--method
  // 可读文件外带（wget DESTRUCTIVE 已拦非 -O - 形态，此处补 -O - 形态的外传 flag）
  if (/^\s*curl\b/i.test(core) && /(^|\s)(-T|--upload-file|--data(?:-urlencode|-raw|-json|-ascii)?|--data-binary|-d|--form|-F|-K|--config|--json)(\s|=)/.test(core)) return false;
  if (/^\s*wget\b/i.test(core) && /(^|\s)(--post-file|--post-data|--body-file|--body-string|--method)(\s|=)/.test(core)) return false;
  if (/^\s*(curl|wget)\b/i.test(core) && /\$/.test(core)) return false;

  // 进程替换 <(...)（审计实测：`diff <(python3 -c '写文件') <(echo x)` 曾放行——
  // 核心分隔符检查只拦 $()/反引号，< 不在列；>( 已被重定向拦截，<( 是唯一漏网入口）
  if (/<\(/.test(core)) return false;

  // sort -o/--output 可写文件（审计实测：sort 在白名单且 DESTRUCTIVE 无 -o 拦截）；
  // --compress-program=CMD 对排序块执行任意程序（审计 MEDIUM：引号内空格不含分隔符即放行）
  if (/^\s*sort\b/i.test(core) && /(^|\s)(-o|--output|--compress-program)(\s|=)/.test(core)) return false;

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
  // scout（只读调研）和 reviewer（只读审阅）均允许在规划模式使用
  const ALLOWED_IN_PLAN = new Set(["scout", "reviewer"]);
  if (names.some((n) => !ALLOWED_IN_PLAN.has(n))) {
    return `规划模式: subagent 仅允许 scout（调研）和 reviewer（审阅）（未指定或 worker 均不可用，未指定会落到可写的 general-purpose）。使用 subagent agent="scout" 或 agent="reviewer"，或退出规划模式。`;
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
