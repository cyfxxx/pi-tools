#!/usr/bin/env node
/**
 * pi TUI 完整中文化补丁 v9
 * =============================
 * 覆盖范围：命令描述、设置菜单、交互组件、登录、会话管理、
 * 模型选择、资源配置、状态消息、插件命令/提示词/技能/本地化、
 * 浏览器自动化扩展、SearXNG 搜索扩展、用户 skill 描述、
 * ctx-lite 扩展、plan-mode 扩展
 *
 * v9 改進：
 *   - 新增 ctx-lite 扩展命令描述翻译
 *   - 新增 plan-mode 扩展命令/标志描述翻译
 *
 * v8 改進：
 *   - 新增 Default project trust 设置项翻译（label/description/子选项）
 *   - 新增 config-selector 中 Skills/Themes 资源标签翻译
 *   - 新增 interactive-mode 区段标题 + 通用消息翻译
 *   - 新增 session-selector 排序/筛选/确认提示翻译
 *   - 新增 login-dialog fallback 链接提示翻译
 *   - 新增 browser-automation/searxng-search 用户 skill 描述翻译
 *   - 新增 context-mode 全部 8 个技能描述翻译
 *   - 新增 pi-lens lens-tdi/lens-health 命令描述翻译
 *   - 新增 pi-subagents 扩展工具 label/description 翻译
 *   - 新增 pi-lens lens-tools/lens-allow-edit 命令描述翻译
 *   - 新增 context-mode ctx-stats/ctx-doctor 命令描述翻译
 *
 * 用法：node patch-all-zh.mjs
 * 每次 pi update 后执行一次。
 *
 * 特性：
 *   - 自动检测 pi 安装路径（兼容 nvm / npm global / 自定义 prefix）
 *   - 修改前自动备份原文件至 .bak.时间戳
 *   - 增量安全：已翻译的字符串不会被重复替换
 *   - 结构清晰的翻译区段
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(__dirname, "..", ".."); // ~/.pi/
const PINPM_DIR = join(PI_DIR, "npm/node_modules"); // ~/.pi/npm/node_modules

// ============================================================
// 第〇步：自动检测 pi 核心包路径
// ============================================================
function resolvePiPath() {
	const candidates = [
		// 最常见全局安装路径
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		// npm root -g 检测
		...(() => {
			try {
				const { execSync } = _require("child_process");
				const root = execSync("npm root -g", { encoding: "utf-8" }).trim();
				return [join(root, "@earendil-works/pi-coding-agent")];
			} catch {
				return [];
			}
		})(),
		// 通过 import.meta.resolve（Node >= 20.11）
		...(() => {
			try {
				const resolved = _require.resolve("@earendil-works/pi-coding-agent");
				// resolved 是目录路径, 去掉 /package.json 后缀
				const dir = resolved.replace(/\/package\.json$/, "");
				return [dir];
			} catch {
				return [];
			}
		})(),
		// 通过 package main 入口文件推算
		...(() => {
			try {
				const mainEntry = _require.resolve("@earendil-works/pi-coding-agent");
				return [dirname(mainEntry)];
			} catch {
				return [];
			}
		})(),
	];

	for (const p of candidates) {
		const pkgJson = join(p, "package.json");
		if (existsSync(pkgJson)) {
			try {
				const meta = JSON.parse(readFileSync(pkgJson, "utf-8"));
				if (meta.name === "@earendil-works/pi-coding-agent") {
					return p;
				}
			} catch {
				/* skip */
			}
		}
	}

	// 最后兜底：在 node_modules 搜索
	const searchRoots = [
		"/usr/lib",
		"/usr/local/lib",
		process.env.HOME || "/root",
	];
	for (const root of searchRoots) {
		const p = join(root, "node_modules/@earendil-works/pi-coding-agent");
		if (existsSync(join(p, "package.json"))) return p;
	}

	console.error("✗ 未找到 pi 核心包路径。请手动设置 PI 变量。");
	process.exit(1);
}

const PI = resolvePiPath();
const COMMANDS = `${PI}/dist/core/slash-commands.js`;
const SETTINGS = `${PI}/dist/modes/interactive/components/settings-selector.js`;
const INTERACTIVE_MODE = `${PI}/dist/modes/interactive/interactive-mode.js`;
const CONFIG_SELECTOR = `${PI}/dist/modes/interactive/components/config-selector.js`;
const LOGIN_DIALOG = `${PI}/dist/modes/interactive/components/login-dialog.js`;
const SESSION_SELECTOR = `${PI}/dist/modes/interactive/components/session-selector.js`;
const TREE_SELECTOR = `${PI}/dist/modes/interactive/components/tree-selector.js`;
const MODEL_SELECTOR = `${PI}/dist/modes/interactive/components/model-selector.js`;
const OAUTH_SELECTOR = `${PI}/dist/modes/interactive/components/oauth-selector.js`;
const MAIN = `${PI}/dist/main.js`;
const DAXNUTS = `${PI}/dist/modes/interactive/components/daxnuts.js`;

const PLANNATOR = join(PINPM_DIR, "@plannotator/pi-extension/index.ts");
const PI_LENS = join(PINPM_DIR, "pi-lens/index.ts");
const PI_MD_PREVIEW = join(PINPM_DIR, "pi-markdown-preview/index.ts");
const PLANNATOR_HTML = join(
	PINPM_DIR,
	"@plannotator/pi-extension/plannotator.html",
);
const REVIEW_HTML = join(
	PINPM_DIR,
	"@plannotator/pi-extension/review-editor.html",
);

const FIRST_NAMES = [
	COMMANDS,
	SETTINGS,
	INTERACTIVE_MODE,
	CONFIG_SELECTOR,
	LOGIN_DIALOG,
	SESSION_SELECTOR,
	TREE_SELECTOR,
	MODEL_SELECTOR,
	OAUTH_SELECTOR,
	MAIN,
	DAXNUTS,
	PLANNATOR,
	PI_LENS,
	PI_MD_PREVIEW,
];

// ============================================================
// 辅助函数
// ============================================================

/** 备份文件到 .bak.时间戳 */
function backup(file) {
	if (!existsSync(file)) return;
	const bak = `${file}.bak.${Date.now()}`;
	copyFileSync(file, bak);
	return bak;
}

/** 对单个文件执行替换（跳过已翻译的） */
function apply(file, replacements) {
	if (!existsSync(file)) {
		console.warn(`  ! 文件不存在: ${file}`);
		return 0;
	}
	let content = readFileSync(file, "utf-8");
	let changed = 0;
	for (const [from, to] of replacements) {
		// 跳过已翻译的（目标字符串已存在）
		if (content.includes(to)) continue;
		// 精确匹配替换
		const idx = content.indexOf(from);
		if (idx === -1) {
			console.warn(`  ! 未找到原文: ${from.slice(0, 80)}`);
			continue;
		}
		// 用 replace (非 replaceAll) 精确替换一次，避免误伤
		content = content.replace(from, to);
		changed++;
	}
	if (changed > 0) {
		backup(file);
		writeFileSync(file, content, "utf-8");
	}
	return changed;
}

/** 统计翻译覆盖率（仅统计 description/label 模板字面量） */
function coverage(file) {
	if (!existsSync(file))
		return { total: 0, translated: 0, pct: "N/A", name: file };
	const content = readFileSync(file, "utf-8");
	const uiEn =
		[...content.matchAll(/description:\s*`[^`]*[a-z][^`]*`/g)].length +
		[...content.matchAll(/label:\s*`[^`]*[a-z][^`]*`/g)].length;
	const uiZh =
		[...content.matchAll(/description:\s*`[^`]*[\u4e00-\u9fff][^`]*`/g)]
			.length +
		[...content.matchAll(/label:\s*`[^`]*[\u4e00-\u9fff][^`]*`/g)].length;
	const all = uiEn + uiZh;
	return {
		total: all,
		translated: uiZh,
		pct: all > 0 ? `${Math.round((uiZh / all) * 100)}%` : "-",
		name: file.split("/").pop(),
	};
}

// ============================================================
// 分节翻译
// ============================================================

const sections = [];

// ---- [1] 命令描述 ----
sections.push(() => {
	const n = apply(COMMANDS, [
		['"Open settings menu"', "`打开设置菜单`"],
		['"Select model (opens selector UI)"', "`选择模型（打开选择界面）`"],
		[
			'"Enable/disable models for Ctrl+P cycling"',
			"`启用/禁用 Ctrl+P 循环的模型`",
		],
		[
			'"Export session (HTML default, or specify path: .html/.jsonl)"',
			"`导出会话（默认 HTML，可指定路径 .html/.jsonl）`",
		],
		[
			'"Import and resume a session from a JSONL file"',
			"`从 JSONL 文件导入并恢复会话`",
		],
		[
			'"Share session as a secret GitHub gist"',
			"`将会话分享为私密 GitHub Gist`",
		],
		['"Copy last agent message to clipboard"', "`复制上一条助手消息到剪贴板`"],
		['"Set session display name"', "`设置会话显示名称`"],
		['"Show session info and stats"', "`显示会话信息与统计`"],
		['"Show changelog entries"', "`显示更新日志`"],
		['"Show all keyboard shortcuts"', "`显示所有键盘快捷键`"],
		[
			'"Create a new fork from a previous user message"',
			"`从之前的一条用户消息创建新分支`",
		],
		[
			'"Duplicate the current session at the current position"',
			"`在当前位置复制当前会话`",
		],
		['"Navigate session tree (switch branches)"', "`导航会话树（切换分支）`"],
		[
			'"Save project trust decision for future sessions"',
			"`保存项目信任决策以供未来会话使用`",
		],
		['"Configure provider authentication"', "`配置提供商身份认证`"],
		['"Remove provider authentication"', "`移除提供商身份认证`"],
		['"Start a new session"', "`开始新会话`"],
		['"Manually compact the session context"', "`手动压缩会话上下文`"],
		['"Resume a different session"', "`恢复另一个会话`"],
		[
			'"Reload keybindings, extensions, skills, prompts, and themes"',
			"`重新加载键盘绑定、扩展、技能、提示模板和主题`",
		],
		["`Quit ${APP_NAME}`", "`退出 pi`"],
	]);
	return `命令描述 (${n} 条)`;
});

// ---- [2] 设置菜单 ----
sections.push(() => {
	let n = apply(SETTINGS, [
		// 标签
		['label: "Auto-compact"', "label: `自动压缩`"],
		['label: "Steering mode"', "label: `引导模式`"],
		['label: "Follow-up mode"', "label: `跟进模式`"],
		['label: "Transport"', "label: `传输协议`"],
		['label: "HTTP idle timeout"', "label: `HTTP 空闲超时`"],
		['label: "Hide thinking"', "label: `隐藏思考过程`"],
		['label: "Collapse changelog"', "label: `折叠更新日志`"],
		['label: "Quiet startup"', "label: `静默启动`"],
		['label: "Install telemetry"', "label: `安装遥测`"],
		['label: "Double-escape action"', "label: `双击 Esc 动作`"],
		['label: "Tree filter mode"', "label: `树过滤器模式`"],
		['label: "Warnings"', "label: `警告`"],
		['label: "Thinking level"', "label: `思考深度`"],
		['label: "Theme"', "label: `主题`"],
		['label: "Show images"', "label: `显示图片`"],
		['label: "Image width"', "label: `图片宽度`"],
		['label: "Auto-resize images"', "label: `自动缩放图片`"],
		['label: "Block images"', "label: `拦截图片`"],
		['label: "Skill commands"', "label: `技能命令`"],
		['label: "Show hardware cursor"', "label: `显示硬件光标`"],
		['label: "Editor padding"', "label: `编辑器内边距`"],
		['label: "Autocomplete max items"', "label: `自动补全最大显示数`"],
		['label: "Clear on shrink"', "label: `收缩时清空`"],
		['label: "Terminal progress"', "label: `终端进度条`"],
		// 描述
		[
			'description: "Automatically compact context when it gets too large"',
			"description: `上下文过大时自动压缩`",
		],
		[
			"description: \"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.\"",
			'description: `流式输出时按 Enter 排队引导消息。"one-at-a-time"：逐个发送并等待回复；"all"：全部一次发送`',
		],
		[
			'description: "Preferred transport for providers that support multiple transports"',
			"description: `多传输协议提供商的首选传输方式`",
		],
		[
			'description: "Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes."',
			"description: `等待 HTTP 标头或数据块时的最大空闲间隙。本地模型暂停超 5 分钟时请关闭此选项`",
		],
		[
			'description: "Hide thinking blocks in assistant responses"',
			"description: `隐藏助手回复中的思考块`",
		],
		[
			'description: "Show condensed changelog after updates"',
			"description: `更新后显示精简版更新日志`",
		],
		[
			'description: "Disable verbose printing at startup"',
			"description: `启动时不打印详细信息`",
		],
		[
			'description: "Send an anonymous version/update ping after changelog-detected updates"',
			"description: `在检测到更新后发送匿名版本/更新通知`",
		],
		[
			'description: "Action when pressing Escape twice with empty editor"',
			"description: `编辑器为空时双击 Esc 触发的动作`",
		],
		[
			'description: "Default filter when opening /tree"',
			"description: `打开 /tree 时的默认过滤器`",
		],
		[
			'description: "Enable or disable individual warnings"',
			"description: `启用或禁用单个警告`",
		],
		[
			'description: "Reasoning depth for thinking-capable models"',
			"description: `支持思考的模型的推理深度`",
		],
		[
			'description: "Color theme for the interface"',
			"description: `界面颜色主题`",
		],
		[
			'description: "Render images inline in terminal"',
			"description: `在终端内联渲染图片`",
		],
		[
			'description: "Preferred inline image width in terminal cells"',
			"description: `内联图片在终端中的首选宽度（单位：字符列数）`",
		],
		[
			'description: "Resize large images to 2000x2000 max for better model compatibility"',
			"description: `将大图缩放到最大 2000x2000 以提升模型兼容性`",
		],
		[
			'description: "Prevent images from being sent to LLM providers"',
			"description: `阻止图片发送给 LLM 提供商`",
		],
		[
			'description: "Register skills as /skill:name commands"',
			"description: `将技能注册为 /skill:name 命令`",
		],
		[
			'description: "Show the terminal cursor while still positioning it for IME support"',
			"description: `显示终端光标（同时定位以支持 IME）`",
		],
		[
			'description: "Horizontal padding for input editor (0-3)"',
			"description: `输入编辑器的水平内边距（0-3）`",
		],
		[
			'description: "Max visible items in autocomplete dropdown (3-20)"',
			"description: `自动补全下拉列表的最大可见项数（3-20）`",
		],
		[
			'description: "Clear empty rows when content shrinks (may cause flicker)"',
			"description: `内容收缩时清空空行（可能导致闪烁）`",
		],
		[
			'description: "Show OSC 9;4 progress indicators in the terminal tab bar"',
			"description: `在终端标签栏显示 OSC 9;4 进度指示器`",
		],
		// Default project trust (新选项 v0.79+)
		['label: "Default project trust"', "label: `默认项目信任`"],
		[
			'description: "Fallback behavior when no extension or saved trust decision decides project trust"',
			"description: `当扩展或已保存的信任决策未决定项目信任时的回退行为`",
		],
		['ask: "Ask"', 'ask: "询问"'],
		['always: "Always trust"', 'always: "始终信任"'],
		['never: "Never trust"', 'never: "永不信任"'],
		// 警告子菜单
		['label: "Anthropic extra usage"', "label: `Anthropic 额外用量`"],
		[
			'description: "Warn when Anthropic subscription auth may use paid extra usage"',
			"description: `当 Anthropic 订阅认证可能产生付费额外用量时发出警告`",
		],
		// 思考深度
		['off: "No reasoning"', "off: `无推理`"],
		[
			'minimal: "Very brief reasoning (~1k tokens)"',
			"minimal: `极简推理（约 1K token）`",
		],
		['low: "Light reasoning (~2k tokens)"', "low: `轻度推理（约 2K token）`"],
		[
			'medium: "Moderate reasoning (~8k tokens)"',
			"medium: `中等推理（约 8K token）`",
		],
		[
			'high: "Deep reasoning (~16k tokens)"',
			"high: `深度推理（约 16K token）`",
		],
		[
			'xhigh: "Maximum reasoning (~32k tokens)"',
			"xhigh: `最大推理（约 32K token）`",
		],
		// 子菜单标题/提示
		['"Thinking Level"', '"思考深度"'],
		[
			'"Select reasoning depth for thinking-capable models"',
			'"选择支持思考模型的推理深度"',
		],
		['"Theme"', '"主题"'],
		['"Select color theme"', '"选择界面颜色主题"'],
		[
			'"  Enter to select \u00b7 Esc to go back"',
			'"  回车选择 \u00b7 Esc 返回"',
		],
	]);

	// follow-up mode 描述（含模板变量，用正则）
	const setFile = SETTINGS;
	if (existsSync(setFile)) {
		let content = readFileSync(setFile, "utf-8");
		const prevLen = content.length;
		content = content.replace(
			/description:\s*`\$\{followUpKey\}[^`]+`/,
			'description: `跟进消息排队直到代理停止。"one-at-a-time"：逐个发送并等待回复；"all"：全部一次发送`',
		);
		if (content.length !== prevLen) {
			backup(setFile);
			writeFileSync(setFile, content, "utf-8");
			n++;
		}
	}

	return `设置菜单 (${n} 项)`;
});

// ---- [3] 交互模式主组件 ----
sections.push(() => {
	let n = apply(INTERACTIVE_MODE, [
		// 已有翻译的保持不动，新增以下：
		[
			'"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage."',
			'"Anthropic 订阅认证已激活。第三方调用消耗额外用量并按 token 计费，不计入 Claude 套餐限制。在 https://claude.ai/settings/usage 管理额外用量。"',
		],
		['"Working..."', '"处理中..."'],
		['"Thinking..."', '"思考中..."'],
		['"What\'s New"', '"更新内容"'],
		['"Unknown error occurred"', '"发生未知错误"'],
		['"Failed to create session"', '"创建会话失败"'],
		['"Forked to new session"', '"已创建新分支会话"'],
		['"Failed to fork session"', '"创建分支会话失败"'],
		['"Navigated to selected point"', '"已跳转到选定位置"'],
		['"Session cwd not found"', '"会话工作目录不存在"'],
		['"Operation aborted"', '"操作已取消"'],
		['"Context overflow detected, "', '"检测到上下文溢出，"'],
		['"Compaction cancelled"', '"压缩已取消"'],
		['"Auto-compaction cancelled"', '"自动压缩已取消"'],
		['"Unknown error"', '"未知错误"'],
		['"To resume this session:"', '"恢复此会话："'],
		[
			'"Suspend to background is not supported on Windows"',
			'"Windows 不支持挂起到后台"',
		],
		['"No queued messages to restore"', '"没有待恢复的排队消息"'],
		['"Current model does not support thinking"', '"当前模型不支持思考"'],
		['"Only one model in scope"', '"范围内只有一个模型"'],
		['"Only one model available"', '"只有一个可用模型"'],
		[
			'"No editor configured. Set $VISUAL or $EDITOR environment variable."',
			'"未配置编辑器。请设置 $VISUAL 或 $EDITOR 环境变量。"',
		],
		['"Changelog: "', '"更新日志："'],
		['"Context"', '"上下文"'],
		['"User-Agent"', '"用户代理"'],
		// === v7 新增：状态/警告/错误消息 ===
		[
			'"A bash command is already running. Press Esc to cancel it first."',
			'"Bash 命令正在运行，请先按 Esc 取消。"',
		],
		[
			'"This project is not trusted. Project instructions (AGENTS.md/CLAUDE.md), .pi resources, and project packages are ignored. Use /trust to save a trust decision, then restart pi."',
			'"此项目不受信任。项目指令（AGENTS.md/CLAUDE.md）、.pi 资源和项目包被忽略。使用 /trust 保存信任决策，然后重启 pi。"',
		],
		['"Update Available"', '"有可用更新"'],
		['"Package Updates Available"', '"有可用的包更新"'],
		['"Queued message for after compaction"', '"已排队等待压缩后发送的消息"'],
		['"No models available"', '"没有可用模型"'],
		['"Model selection saved to settings"', '"模型选择已保存到设置"'],
		['"No messages to fork from"', '"没有可分支的消息"'],
		['"Nothing to clone yet"', '"暂无内容可克隆"'],
		['"Cloned to new session"', '"已克隆到新会话"'],
		['"No entries in session"', '"会话中没有条目"'],
		['"Already at this point"', '"已在此位置"'],
		['"Branch summarization cancelled"', '"分支汇总已取消"'],
		['"Navigation cancelled"', '"导航已取消"'],
		['"Resumed session"', '"已恢复会话"'],
		['"Resume cancelled"', '"恢复已取消"'],
		['"Resumed session in current cwd"', '"已在当前目录恢复会话"'],
		[
			'"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged."',
			'"没有要移除的已存储凭据。/logout 只移除通过 /login 保存的凭据；环境变量和 models.json 配置不变。"',
		],
		['"No subscription providers available."', '"没有可用的订阅提供商。"'],
		['"No API key providers available."', '"没有可用的 API 密钥提供商。"'],
		[
			'"Amazon Bedrock uses AWS credentials instead of a single API key."',
			'"Amazon Bedrock 使用 AWS 凭据而非单个 API 密钥。"',
		],
		[
			'"Configure an AWS profile, IAM keys, bearer token, or role-based credentials."',
			'"配置 AWS 配置文件、IAM 密钥、Bearer Token 或基于角色的凭据。"',
		],
		['"See:"', '"参见："'],
		[
			'"Wait for the current response to finish before reloading."',
			'"请等待当前回复完成后再重新加载。"',
		],
		[
			'"Wait for compaction to finish before reloading."',
			'"请等待压缩完成后再重新加载。"',
		],
		[
			'"Reloading keybindings, extensions, skills, prompts, themes..."',
			'"正在重新加载键盘绑定、扩展、技能、提示模板、主题..."',
		],
		[
			'"Reloaded keybindings, extensions, skills, prompts, themes; saved project trust"',
			'"已重新加载键盘绑定、扩展、技能、提示模板、主题；已保存项目信任"',
		],
		[
			'"Reloaded keybindings, extensions, skills, prompts, themes"',
			'"已重新加载键盘绑定、扩展、技能、提示模板、主题"',
		],
		['"Import cancelled"', '"导入已取消"'],
		['"Share cancelled"', '"分享已取消"'],
		[
			'"Copied last agent message to clipboard"',
			'"已复制上一条助手消息到剪贴板"',
		],
		['"Usage: /name <name>"', '"用法: /name <名称>"'],
		[
			'"Nothing to compact (no messages yet)"',
			'"没有可压缩的内容（尚无消息）"',
		],
		['"Summarize branch?"', '"是否汇总分支？"'],
		['"No summary"', '"不汇总"'],
		['"Summarize"', '"汇总"'],
		['"Summarize with custom prompt"', '"使用自定义提示词汇总"'],
		['"Custom summarization instructions"', '"自定义汇总说明"'],
		['"Waiting for authentication..."', '"等待认证..."'],
		['"Enter API key:"', '"输入 API 密钥："'],
		// === v8 新增：启动区段标题 + 通用消息 ===
		['"Skills"', '"技能"'],
		['"Prompts"', '"提示词"'],
		['"Extensions"', '"扩展"'],
		['"Themes"', '"主题"'],
		['"Yes"', '"是"'],
		['"No"', '"否"'],
		['"Use a subscription"', '"使用订阅"'],
		['"Select authentication method:"', '"选择认证方式："'],
		['"Amazon Bedrock setup"', '"Amazon Bedrock 设置"'],
		['"Import session"', '"导入会话"'],
		['"Creating gist..."', '"正在创建 Gist..."'],
		['"No agent messages to copy yet."', '"尚无助手消息可复制。"'],
		['"Session Info"', '"会话信息"'],
	]);
	// v8 新增：模板字面量和拼接字符串
	if (existsSync(INTERACTIVE_MODE)) {
		let content = readFileSync(INTERACTIVE_MODE, "utf-8");
		let changed = 0;
		const extraReplacements = [
			[
				"`Replace current session with ${inputPath}?`",
				"`用 ${inputPath} 替换当前会话？`",
			],
			["Package updates are available. Run ", "有可用的包更新。运行 "],
		];
		for (const [from, to] of extraReplacements) {
			if (content.includes(to)) continue;
			if (content.includes(from)) {
				content = content.replace(from, to);
				changed++;
			}
		}
		if (changed > 0) {
			backup(INTERACTIVE_MODE);
			writeFileSync(INTERACTIVE_MODE, content, "utf-8");
			n += changed;
		}
	}
	return `交互模式消息 (${n} 条)`;
});

// ---- [4] 资源配置选择器 ----
sections.push(() => {
	const n = apply(CONFIG_SELECTOR, [
		['"Extensions"', '"扩展"'],
		['"Prompts"', '"提示词"'],
		['skills: "Skills"', 'skills: "技能"'],
		['themes: "Themes"', 'themes: "主题"'],
		['"User (~/.pi/agent/)"', '"用户配置 (~/.pi/agent/)"'],
		['"Project (.pi/)"', '"项目配置 (.pi/)"'],
		['"User settings"', '"用户设置"'],
		['"Project settings"', '"项目设置"'],
		['"Resource Configuration"', '"资源配置"'],
		['"Type to filter resources"', '"输入以筛选资源"'],
	]);
	return `资源配置 (${n} 项)`;
});

// ---- [5] 登录对话框 ----
sections.push(() => {
	const n = apply(LOGIN_DIALOG, [
		['"Login cancelled"', '"登录已取消"'],
		['"Cmd+click to open"', '"Cmd+点击打开"'],
		['"Ctrl+click to open"', '"Ctrl+点击打开"'],
	]);
	return `登录对话框 (${n} 项)`;
});

// ---- [6] 会话选择器 ----
sections.push(() => {
	const n = apply(SESSION_SELECTOR, [
		['"Resume Session (Current Folder)"', '"恢复会话（当前文件夹）"'],
		['"Resume Session (All)"', '"恢复会话（全部）"'],
		['"Threaded"', '"线程视图"'],
		['"Cannot delete the currently active session"', '"不能删除当前活动会话"'],
		['"Current folder"', '"当前文件夹"'],
		['"Session moved to trash"', '"会话已移至回收站"'],
		['"Session deleted"', '"会话已删除"'],
		['"Rename Session"', '"重命名会话"'],
	]);
	return `会话选择器 (${n} 项)`;
});

// ---- [7] 树导航 ----
sections.push(() => {
	const n = apply(TREE_SELECTOR, [
		['"Type to search:"', '"输入搜索："'],
		['"Label (empty to remove):"', '"标签（清空移除）："'],
	]);
	return `树导航 (${n} 项)`;
});

// ---- [8] 模型选择器 ----
sections.push(() => {
	const n = apply(MODEL_SELECTOR, [
		[
			'"Only showing models from configured providers. Use /login to add providers."',
			'"仅显示已配置提供商中的模型。使用 /login 添加提供商。"',
		],
		['"Scope: "', '"范围："'],
	]);
	return `模型选择器 (${n} 项)`;
});

// ---- [9] OAuth 提供商选择器 ----
sections.push(() => {
	const n = apply(OAUTH_SELECTOR, [
		['"Select provider to configure:"', '"选择要配置的提供商："'],
		['"Select provider to logout:"', '"选择要注销的提供商："'],
		['"No providers available"', '"没有可用的提供商"'],
		[
			'"No providers logged in. Use /login first."',
			'"没有已登录的提供商。请先使用 /login。"',
		],
		['"No matching providers"', '"没有匹配的提供商"'],
	]);
	return `OAuth 选择器 (${n} 项)`;
});

// ---- [10] 主 CLI 入口 ----
sections.push(() => {
	const n = apply(MAIN, [
		[
			'"Fork this session into current directory?"',
			'"将此会话分叉到当前目录？"',
		],
		['"Aborted."', '"已中止。"'],
		['"No session selected"', '"未选择会话"'],
		['"Continue"', '"继续"'],
		['"Failed to export session"', '"导出会话失败"'],
		[
			'"Error: @file arguments are not supported in RPC mode"',
			'"错误：RPC 模式不支持 @file 参数"',
		],
		['"Error: --name requires a non-empty value"', '"错误：--name 需要非空值"'],
		[
			'"Error: PI_STARTUP_BENCHMARK only supports interactive mode"',
			'"错误：PI_STARTUP_BENCHMARK 仅支持交互模式"',
		],
		['"Warning"', '"警告"'],
	]);
	return `CLI 主入口 (${n} 项)`;
});

// ---- [11] 启动页脚（daxnuts） ----
sections.push(() => {
	const n = apply(DAXNUTS, [
		['"Powered by daxnuts"', '"由 daxnuts 驱动"'],
		['"Try OpenCode"', '"试试 OpenCode"'],
	]);
	return `启动页脚 (${n} 项)`;
});

// ---- [12] pi-subagents 命令 ----
sections.push(() => {
	const SLASH = join(PINPM_DIR, "pi-subagents/src/slash/slash-commands.ts");
	if (!existsSync(SLASH)) return "subagents 命令 (跳过：不存在)";
	const n = apply(SLASH, [
		[
			'description: "Run a subagent directly: /run agent[output=file] [task] [--bg] [--fork]"',
			"description: `直接运行子代理：/run agent[output=file] [task] [--bg] [--fork]`",
		],
		[
			'description: "Run agents in sequence: /chain scout \\"task\\" -> planner [--bg] [--fork]"',
			'description: `按顺序运行代理：/chain scout "任务" -> planner [--bg] [--fork]`',
		],
		[
			'description: "Run a saved chain: /run-chain chainName -- task [--bg] [--fork]"',
			"description: `运行已保存的链：/run-chain chainName -- task [--bg] [--fork]`",
		],
		[
			'description: "Run agents in parallel: /parallel scout \\"task1\\" -> reviewer \\"task2\\" [--bg] [--fork]"',
			'description: `并行运行代理：/parallel scout "任务1" -> reviewer "任务2" [--bg] [--fork]`',
		],
		[
			'description: "Show subagent diagnostics"',
			"description: `显示子代理诊断信息`",
		],
		// 运行时状态提示
		['"Running subagent..."', '"正在运行子代理..."'],
		['"Subagent failed"', '"子代理失败"'],
		['"Cancelled"', '"已取消"'],
		[
			'"Failed to persist slash session snapshot for export:"',
			'"保存子代理会话快照以供导出失败："',
		],
		[
			'"Subagent session cwd is not initialized yet"',
			'"子代理会话工作目录尚未初始化"',
		],
		['"At least one step must have a task"', '"至少有一个步骤需要任务"'],
		[
			'"Usage: /run <agent> [task] [--bg] [--fork]"',
			'"用法: /run <agent> [task] [--bg] [--fork]"',
		],
		[
			'"Usage: /run-chain <chainName> -- <task> [--bg] [--fork]"',
			'"用法: /run-chain <chainName> -- <task> [--bg] [--fork]"',
		],
		[
			'"Slash subagent bridge did not start within 15s. Ensure the extension is loaded correctly."',
			'"子代理桥接器在 15 秒内未启动。请确保扩展已正确加载。"',
		],
		[
			'"No slash subagent bridge responded. Ensure the subagent extension is loaded correctly."',
			'"没有子代理桥接器响应。请确保子代理扩展已正确加载。"',
		],
	]);
	return `subagents 命令 (${n} 项)`;
});

// ---- [13] pi-subagents 提示词 ----
sections.push(() => {
	const PROMPTS_DIR = join(PINPM_DIR, "pi-subagents/prompts");
	if (!existsSync(PROMPTS_DIR)) return "subagents 提示词 (跳过：不存在)";
	const entries = [
		[
			"gather-context-and-clarify.md",
			"description: Use subagents to gather context, then ask clarifying questions",
			"description: 使用子代理收集上下文，然后提出澄清问题",
		],
		[
			"parallel-cleanup.md",
			"description: Parallel cleanup review",
			"description: 并行清理审查",
		],
		[
			"parallel-context-build.md",
			"description: Parallel context builders for planning handoff",
			"description: 为规划交接构建并行上下文",
		],
		[
			"parallel-handoff-plan.md",
			"description: Parallel research/context builders into an implementation handoff plan",
			"description: 并行研究/上下文构建为实施交接计划",
		],
		[
			"parallel-research.md",
			"description: Parallel subagents research",
			"description: 并行子代理研究",
		],
		[
			"parallel-review.md",
			"description: Parallel subagents review",
			"description: 并行子代理审查",
		],
		[
			"review-loop.md",
			"description: Review/fix loop until clean",
			"description: 审查/修复循环直至干净",
		],
	];
	let total = 0;
	for (const [file, from, to] of entries) {
		const fp = join(PROMPTS_DIR, file);
		if (!existsSync(fp)) continue;
		total += apply(fp, [[from, to]]);
	}
	return `subagents 提示词 (${total} 项)`;
});

// ---- [14] pi-subagents 技能描述 ----
sections.push(() => {
	const SKILL = join(PINPM_DIR, "pi-subagents/skills/pi-subagents/SKILL.md");
	if (!existsSync(SKILL)) return "subagents 技能 (跳过：不存在)";
	const n = apply(SKILL, [
		[
			"description: |\n  Delegate work to builtin or custom subagents with single-agent, chain,\n  parallel, async, forked-context, and intercom-coordinated workflows. Use\n  for advisory review, implementation handoffs, and multi-step tasks where a\n  single agent should stay in control while other agents contribute context,\n  planning, or execution.",
			"description: |\n  将工作委托给内置或自定义子代理，支持单代理、链式、并行、异步、分叉上下文和对讲协调工作流。\n  适用于顾问审查、实施交接和多步骤任务，\n  其中主代理保持控制，其他代理贡献上下文、规划或执行。",
		],
	]);
	return `subagents 技能 (${n} 项)`;
});

// ---- [15] rpiv-todo 命令 ----
sections.push(() => {
	const TODO_TS = join(PINPM_DIR, "@juicesharp/rpiv-todo/todo.ts");
	if (!existsSync(TODO_TS)) return "rpiv-todo 命令 (跳过：不存在)";
	const n = apply(TODO_TS, [
		[
			'description: "Show all todos on the current branch, grouped by status"',
			"description: `显示当前分支上的所有任务，按状态分组`",
		],
	]);
	return `rpiv-todo 命令 (${n} 项)`;
});

// ---- [16] rpiv-todo 本地化 ----
sections.push(() => {
	const RPIV_TODO_DIR = join(PINPM_DIR, "@juicesharp/rpiv-todo");
	const dirs = [join(RPIV_TODO_DIR, "locales")];

	const zhTodo = {
		"status.pending": "待处理",
		"status.in_progress": "进行中",
		"status.completed": "已完成",
		"status.deleted": "已删除",
		"overlay.heading": "任务列表",
		"overlay.more": "更多",
		"command.no_todos": "暂无任务。请让代理添加一些！",
		"command.requires_interactive": "/todos 需要交互模式",
		"command.section.pending": "── 待处理 ──",
		"command.section.in_progress": "── 进行中 ──",
		"command.section.completed": "── 已完成 ──",
	};

	let count = 0;
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const zhPath = join(dir, "zh.json");
		writeFileSync(zhPath, JSON.stringify(zhTodo, null, 2) + "\n", "utf-8");
		count++;
	}
	return `rpiv-todo locale (${count} 文件)`;
});

// ---- [17] @plannotator/pi-extension 命令和标志 ----
sections.push(() => {
	if (!existsSync(PLANNATOR)) return "plannotator 命令 (跳过：不存在)";
	const n = apply(PLANNATOR, [
		[
			'description: "Start in plan mode (restricted exploration and planning)"',
			"description: `以规划模式启动（受限的探索与规划）`",
		],
		[
			'description: "Toggle plannotator planning mode"',
			"description: `切换 plannotator 规划模式`",
		],
		[
			'description: "Show plannotator status"',
			"description: `显示 plannotator 状态`",
		],
		[
			'description: "Open interactive code review for current changes or a PR URL; pass --git to force Git in JJ workspaces"',
			"description: `对当前更改或 PR URL 打开交互式代码审查；传递 --git 在 JJ 工作区强制使用 Git`",
		],
		[
			'description: "Open markdown file or folder in annotation UI"',
			"description: `在批注界面中打开 markdown 文件或文件夹`",
		],
		[
			'description: "Annotate the last assistant message"',
			"description: `批注上一条助手消息`",
		],
		[
			'description: "Browse saved plan decisions"',
			"description: `浏览已保存的计划决策`",
		],
		['description: "Toggle plannotator"', "description: `切换 plannotator`"],
		// Submit Plan 工具的 description
		[
			'description:\n\t\t\t"Submit your Plannotator plan for user review. " +\n\t\t\t"Call this only while Plannotator planning mode is active, after writing your plan as a markdown file anywhere inside the working directory. " +\n\t\t\t"Pass the path to the plan file (e.g. PLAN.md or plans/auth.md). " +\n\t\t\t"The user will review the plan in a visual browser UI and can approve, deny with feedback, or annotate it. " +\n\t\t\t"If denied, edit the same file in place, then call this again with the same path."',
			"description:\n\t\t\t`提交 Plannotator 计划供用户审查。` +\n\t\t\t`仅在 Plannotator 规划模式激活时调用，将计划写入工作目录中的 markdown 文件后。` +\n\t\t\t`传递计划文件路径（例如 PLAN.md 或 plans/auth.md）。` +\n\t\t\t`用户将在可视化浏览器界面中审查计划，可以批准、拒绝并提供反馈或进行批注。` +\n\t\t\t`如果被拒绝，就地编辑同一文件，然后再次调用此工具。`",
		],
		// filePath 参数描述
		[
			'description:\n\t\t\t\t\t"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd."',
			"description:\n\t\t\t\t\t`计划文件的路径，相对于工作目录。必须以 .md 或 .mdx 结尾，且解析后必须在当前工作目录内。`",
		],
		// v7 新增：标签
		['label: "Submit Plan"', 'label: "提交计划"'],
	]);
	return `plannotator 命令 (${n} 条)`;
});

// ---- [18] @plannotator/pi-extension 技能描述 ----
sections.push(() => {
	const SKILL_DIR = join(PINPM_DIR, "@plannotator/pi-extension/skills");
	if (!existsSync(SKILL_DIR)) return "plannotator 技能 (跳过：不存在)";
	const entries = [
		[
			"plannotator-annotate/SKILL.md",
			"description: Open Plannotator's annotation UI for a markdown file, converted HTML file, URL, or folder and then respond to the returned annotations.",
			"description: 打开 Plannotator 的批注界面用于 markdown 文件、转换后的 HTML 文件、URL 或文件夹，然后响应返回的批注。",
		],
		[
			"plannotator-review/SKILL.md",
			"description: Open Plannotator's browser-based code review UI for the current worktree or a pull request URL, then act on the feedback that comes back.",
			"description: 打开 Plannotator 基于浏览器的代码审查界面，用于当前工作树或拉取请求 URL，然后根据返回的反馈采取行动。",
		],
		[
			"plannotator-setup-goal/SKILL.md",
			"description: Turn an idea or objective into a goal package for /goal. Interviews the user, builds a reviewed fact sheet via Plannotator, then explores the codebase to produce an execution plan.",
			"description: 将一个想法或目标转化为 /goal 的目标包。通过访谈用户、使用 Plannotator 构建审查的事实清单，然后探索代码库以生成执行计划。",
		],
		[
			"plannotator-compound/SKILL.md",
			"description: >\n  Analyze a user's Plannotator plan archive to extract denial patterns, feedback\n  taxonomy, evolution over time, and actionable prompt improvements — then produce\n  a polished HTML dashboard report. Falls back to Claude Code ExitPlanMode denial\n  reasons when Plannotator data is unavailable.",
			"description: >\n  分析用户的 Plannotator 计划存档，提取拒绝模式、反馈分类、随时间变化趋势\n  和可操作的提示改进建议——然后生成精美的 HTML 仪表板报告。\n  当 Plannotator 数据不可用时，回退到 Claude Code ExitPlanMode 拒绝原因。",
		],
		[
			"plannotator-last/SKILL.md",
			"description: Open Plannotator on the latest rendered assistant message and use the returned annotations to revise that message or continue.",
			"description: 在最新渲染的助手消息上打开 Plannotator，并使用返回的批注来修订该消息或继续。",
		],
		[
			"plannotator-visual-explainer/SKILL.md",
			"description: >\n  Generate self-contained HTML visualizations with Plannotator theming. Use for implementation\n  plans, PR explainers, architecture diagrams, data tables, slide decks, and any visual\n  explanation of technical concepts. Plans and PR explainers follow Plannotator's prescriptive\n  approach; all other visual content delegates to nicobailon/visual-explainer.",
			"description: >\n  使用 Plannotator 主题生成自包含的 HTML 可视化。用于实施计划、\n  PR 说明、架构图、数据表格、幻灯片以及任何技术概念的可视化说明。\n  计划和 PR 说明遵循 Plannotator 的规定方法；所有其他视觉内容委托给 nicobailon/visual-explainer。",
		],
	];
	let total = 0;
	for (const [file, from, to] of entries) {
		const fp = join(SKILL_DIR, file);
		if (!existsSync(fp)) continue;
		total += apply(fp, [[from, to]]);
	}
	return `plannotator 技能 (${total} 项)`;
});

// ---- [19] pi-lens 标志和命令 ----
sections.push(() => {
	if (!existsSync(PI_LENS)) return "pi-lens (跳过：不存在)";
	const n = apply(PI_LENS, [
		[
			'description:\n\t\t\t"Start pi-lens disabled for this session. Re-enable with /lens-toggle."',
			"description:\n\t\t\t`本会话禁用 pi-lens。使用 /lens-toggle 重新启用。`",
		],
		[
			'description:\n\t\t\t"Disable unified LSP diagnostics and use language-specific fallbacks (for example ts-lsp, pyright)"',
			"description:\n\t\t\t`禁用统一 LSP 诊断，改用语言特定回退（例如 ts-lsp, pyright）`",
		],
		[
			'description:\n\t\t\t"Disable automatic formatting entirely (deferred format runs at agent_end by default)"',
			"description:\n\t\t\t`完全禁用自动格式化（延迟格式化默认在 agent_end 时运行）`",
		],
		[
			'description:\n\t\t\t"Run automatic formatting immediately after each write/edit instead of deferring to agent_end"',
			"description:\n\t\t\t`每次写入/编辑后立即运行自动格式化，而不是延迟到 agent_end`",
		],
		[
			'description: "Disable auto-fixing of lint issues (Biome, Ruff, ESLint)"',
			"description: `禁用 lint 问题的自动修复（Biome, Ruff, ESLint）`",
		],
		[
			'description: "Disable test runner on write"',
			"description: `写入时禁用测试运行器`",
		],
		[
			'description: "Disable delta mode (show all diagnostics, not just new ones)"',
			"description: `禁用增量模式（显示所有诊断，而不仅仅是新出现的）`",
		],
		[
			'description:\n\t\t\t"Experimental: block git commit/push when unresolved pi-lens blockers exist"',
			"description:\n\t\t\t`实验性：当存在未解决的 pi-lens 阻塞项时阻止 git commit/push`",
		],
		[
			'description:\n\t\t\t"Enable Semgrep dispatch when a Semgrep config is available (or with --lens-semgrep-config)"',
			"description:\n\t\t\t`当 Semgrep 配置可用时启用 Semgrep 调度（或使用 --lens-semgrep-config）`",
		],
		[
			'description:\n\t\t\t"Semgrep config for dispatch: local path, auto, p/<pack>, or r/<rule>. Requires --lens-semgrep."',
			"description:\n\t\t\t`Semgrep 调度配置：本地路径、auto、p/<pack> 或 r/<rule>。需要 --lens-semgrep。`",
		],
		[
			'description: "Disable read-before-edit behavior monitor"',
			"description: `禁用读取前编辑行为监视器`",
		],
		[
			'description:\n\t\t\t"Disable automatic context injection (session-start guidance, turn-end & test findings) while keeping tools, LSP, read-guard, and formatting active. Toggle with /lens-context-toggle. Also via contextInjection.enabled=false in config or PI_LENS_NO_CONTEXT_INJECTION=1."',
			"description:\n\t\t\t`禁用自动上下文注入（会话启动引导、轮次结束和测试结果），同时保持工具、LSP、读取保护和格式化活跃。使用 /lens-context-toggle 切换。也可通过配置中的 contextInjection.enabled=false 或 PI_LENS_NO_CONTEXT_INJECTION=1 设置。`",
		],
		// 命令
		[
			'description:\n\t\t\t"Toggle pi-lens on/off for the current session. Usage: /lens-toggle"',
			"description:\n\t\t\t`切换当前会话的 pi-lens 开/关。用法：/lens-toggle`",
		],
		[
			'description:\n\t\t\t"Toggle automatic context injection on/off for the current session (tools/LSP/read-guard/formatting stay active). Usage: /lens-context-toggle"',
			"description:\n\t\t\t`切换当前会话的自动上下文注入开/关（工具/LSP/读取保护/格式化保持活跃）。用法：/lens-context-toggle`",
		],
		[
			'description:\n\t\t\t"Show or hide the pi-lens diagnostics widget below the editor. Usage: /lens-widget-toggle"',
			"description:\n\t\t\t`显示或隐藏编辑器下方的 pi-lens 诊断小部件。用法：/lens-widget-toggle`",
		],
		[
			'description:\n\t\t\t"Manage Semgrep dispatch. Usage: /lens-semgrep status | enable [--config <auto|p/pack|path>] | disable | init"',
			"description:\n\t\t\t`管理 Semgrep 调度。用法：/lens-semgrep status | enable [--config <auto|p/pack|path>] | disable | init`",
		],
		[
			'description:\n\t\t\t"Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]"',
			"description:\n\t\t\t`完整代码库审查：设计异味、复杂度、AI 草率检测、TODO、死代码、重复代码、类型覆盖率。结果保存到 .pi-lens/reviews/。用法：/lens-booboo [path]`",
		],
		// v8 新增：lens-tdi / lens-health 命令
		[
			'description:\n\t\t\t"Show Technical Debt Index (TDI) and project health trend. Usage: /lens-tdi"',
			"description:\n\t\t\t`显示技术债务指数（TDI）和项目健康趋势。用法：/lens-tdi`",
		],
		[
			'description:\n\t\t\t"Show pi-lens runtime health: pipeline crashes, slow runners, and last dispatch latency. Usage: /lens-health"',
			"description:\n\t\t\t`显示 pi-lens 运行状态：管道崩溃、慢速运行器和最近调度延迟。用法：/lens-health`",
		],
		// v8 新增：lens-tools / lens-allow-edit 命令
		[
			'"Show pi-lens tool installation status: globally installed, auto-installed, or npx fallback. Usage: /lens-tools"',
			"`显示 pi-lens 工具安装状态：全局安装、自动安装或 npx 回退。用法：/lens-tools`",
		],
		[
			'"Allow one edit to a file without a prior read. Usage: /lens-allow-edit <path>"',
			"`允许无需事先读取即可编辑文件一次。用法：/lens-allow-edit <路径>`",
		],
	]);
	return `pi-lens 标志/命令 (${n} 条)`;
});

// ---- [20] pi-lens 技能描述 ----
sections.push(() => {
	const SKILL_DIR = join(PINPM_DIR, "pi-lens/skills");
	if (!existsSync(SKILL_DIR)) return "pi-lens 技能 (跳过：不存在)";
	const entries = [
		[
			"ast-grep/SKILL.md",
			"description: Use when searching or replacing code patterns - use ast-grep instead of text search for semantic accuracy",
			"description: 在搜索或替换代码模式时使用——使用 ast-grep 替代文本搜索以确保语义准确性",
		],
		[
			"lsp-navigation/SKILL.md",
			"description: Navigate code with IDE features and run proactive LSP diagnostics on files/folders/batches. Use as PRIMARY for code intelligence and type/error checks.",
			"description: 使用 IDE 功能导航代码，对文件/文件夹/批次运行主动 LSP 诊断。作为代码智能和类型/错误检查的主要工具。",
		],
		[
			"write-ast-grep-rule/SKILL.md",
			"description: Use when writing a new pi-lens ast-grep rule YAML file — covers schema, drop path, gotchas, and NAPI runner constraints",
			"description: 在编写新的 pi-lens ast-grep 规则 YAML 文件时使用——涵盖模式、放置路径、注意事项和 NAPI 运行器约束",
		],
		[
			"write-tree-sitter-rule/SKILL.md",
			"description: Use when writing a new pi-lens tree-sitter query rule YAML file — covers schema, S-expression syntax, capture names, predicates, and gotchas",
			"description: 在编写新的 pi-lens tree-sitter 查询规则 YAML 文件时使用——涵盖模式、S-表达式语法、捕获名称、谓词和注意事项",
		],
	];
	let total = 0;
	for (const [file, from, to] of entries) {
		const fp = join(SKILL_DIR, file);
		if (!existsSync(fp)) continue;
		total += apply(fp, [[from, to]]);
	}
	return `pi-lens 技能 (${total} 项)`;
});

// ---- [21] pi-markdown-preview 命令和工具参数 ----
sections.push(() => {
	if (!existsSync(PI_MD_PREVIEW)) return "markdown-preview (跳过：不存在)";
	const n = apply(PI_MD_PREVIEW, [
		// tool 参数描述
		[
			'description: "Artifact format to produce: pdf, html, or png image page(s)."',
			"description: `生成的文件格式：pdf、html 或 png 图片页面`",
		],
		[
			'description: "Where the input content comes from. Defaults to markdown when markdown is provided, file when path is provided, otherwise last_assistant."',
			"description: `输入内容的来源。当提供 markdown 时默认为 markdown，提供路径时默认为文件，否则默认为 last_assistant。`",
		],
		[
			'description: "Source file path when source is file. Relative paths resolve against pi\'s current working directory. A leading @ is ignored."',
			"description: `当 source 为 file 时的源文件路径。相对路径相对于 pi 的当前工作目录解析。开头的 @ 被忽略。`",
		],
		[
			'description: "Markdown or LaTeX content to render when source is markdown. Prefer this for content composed in the same assistant turn."',
			"description: `当 source 为 markdown 时要渲染的 Markdown 或 LaTeX 内容。适用于在同一助手轮次中编写的内容。`",
		],
		[
			'description: "Interpret direct markdown content as markdown or latex. File inputs auto-detect .tex."',
			"description: `将直接 markdown 内容解释为 markdown 或 latex。文件输入自动检测 .tex。`",
		],
		[
			'description: "Base directory for resolving relative images/assets when source is markdown. Defaults to pi\'s current working directory."',
			"description: `当 source 为 markdown 时用于解析相对图片/资源的基础目录。默认为 pi 的当前工作目录。`",
		],
		[
			'description: "Optional destination path. Relative paths resolve against pi\'s current working directory. PNG exports with multiple pages append -1-of-N, -2-of-N, etc."',
			"description: `可选的目标路径。相对路径相对于 pi 的当前工作目录解析。PNG 导出多页时追加 -1-of-N、-2-of-N 等。`",
		],
		[
			'description: "Open the generated artifact locally after writing it. Defaults to false for headless/remote sessions."',
			"description: `写入后在本地打开生成的文件。对于无头/远程会话默认为 false。`",
		],
		// 命令描述
		[
			'description: "Render Markdown/LaTeX, a local file, or the latest assistant response to PDF, HTML, or PNG artifact files. Use for remote/headless/Telegram-style sessions where slash-command previews cannot display interactively."',
			"description: `将 Markdown/LaTeX、本地文件或最新的助手响应渲染为 PDF、HTML 或 PNG 文件。用于远程/无头/Telegram 风格会话中斜杠命令预览无法交互显示的情况。`",
		],
		[
			'description: "Rendered markdown preview (--pick select response, --file <path> or bare path, --browser for HTML, --pdf for PDF, --terminal to force inline, --font-size <px>)"',
			"description: `渲染的 markdown 预览（--pick 选择回复、--file <路径> 或直接路径、--browser HTML、--pdf PDF、--terminal 强制内联、--font-size <像素>）`",
		],
		[
			'description: "Open rendered markdown + LaTeX preview in the default browser (MathML + selective MathJax fallback)"',
			"description: `在默认浏览器中打开渲染的 markdown + LaTeX 预览（MathML + 选择性 MathJax 回退）`",
		],
		[
			'description: "Export markdown to PDF via pandoc + LaTeX and open it"',
			"description: `通过 pandoc + LaTeX 将 markdown 导出为 PDF 并打开`",
		],
		[
			'description: "Clear rendered preview cache (~/.pi/cache/markdown-preview)"',
			"description: `清除渲染的预览缓存（~/.pi/cache/markdown-preview）`",
		],
		// v7 新增：工具标签
		['label: "Preview Export"', 'label: "预览导出"'],
	]);
	return `markdown-preview 命令/参数 (${n} 条)`;
});

// ---- [22] plannotator.html 网页界面核心 UI ----
sections.push(() => {
	if (!existsSync(PLANNATOR_HTML)) return "plannotator.html UI (跳过：不存在)";
	const n = apply(PLANNATOR_HTML, [
		['children:"Cancel"', 'children:"取消"'],
		['children:"Save"', 'children:"保存"'],
		['children:"Save All"', 'children:"全部保存"'],
		['children:"Done"', 'children:"完成"'],
		['children:"Retry"', 'children:"重试"'],
		['children:"Reset"', 'children:"重置"'],
		['children:"Reset to defaults"', 'children:"恢复默认"'],
		['children:"Export"', 'children:"导出"'],
		['children:"Share"', 'children:"分享"'],
		['children:"Dismiss"', 'children:"忽略"'],
		['children:"Deny"', 'children:"拒绝"'],
		['children:"Allow"', 'children:"允许"'],
		['children:"Add"', 'children:"添加"'],
		['children:"Settings"', 'children:"设置"'],
		['children:"Theme"', 'children:"主题"'],
		['children:"Mode"', 'children:"模式"'],
		['children:"Model"', 'children:"模型"'],
		['children:"Name"', 'children:"名称"'],
		['children:"Label"', 'children:"标签"'],
		['children:"Labels"', 'children:"标签"'],
		['children:"Note"', 'children:"备注"'],
		['children:"Folder"', 'children:"文件夹"'],
		['children:"File Browser"', 'children:"文件浏览器"'],
		['children:"Editor"', 'children:"编辑器"'],
		['children:"How Plannotator Works"', 'children:"Plannotator 使用说明"'],
		['children:"How it works"', 'children:"使用说明"'],
		['children:"Setup guide"', 'children:"设置指南"'],
		['children:"Release notes"', 'children:"版本发布说明"'],
		['children:"Learn more"', 'children:"了解更多"'],
		['children:"Current Plan"', 'children:"当前计划"'],
		['children:"Plan Width"', 'children:"计划宽度"'],
		['children:"Show Changes"', 'children:"显示变更"'],
		['children:"Compare Against"', 'children:"对比版本"'],
		['children:"Contents"', 'children:"目录"'],
		['children:"Annotations"', 'children:"批注"'],
		['children:"Comment"', 'children:"评论"'],
		['children:"Global comment"', 'children:"全局评论"'],
		['children:"Quick Labels"', 'children:"快捷标签"'],
		['children:"Example output"', 'children:"输出示例"'],
		['children:"Exit Diff"', 'children:"退出差异"'],
		['children:"Download Annotations"', 'children:"下载批注"'],
		['children:"Launch Preview Mode"', 'children:"启动预览模式"'],
		['children:"Create short link"', 'children:"创建短链接"'],
		['children:"Add Directory"', 'children:"添加目录"'],
		['children:"Vault Browser"', 'children:"库浏览器"'],
		['children:"Integrations"', 'children:"集成"'],
		['children:"AI Provider"', 'children:"AI 提供商"'],
		['children:"Agent Switching"', 'children:"代理切换"'],
		['children:"Custom"', 'children:"自定义"'],
		['children:"Disabled"', 'children:"已禁用"'],
		['children:"Current"', 'children:"当前"'],
		['children:"Send Feedback"', 'children:"发送反馈"'],
	]);
	return `plannotator.html UI 核心 (${n} 条)`;
});

// ---- [23] review-editor.html 网页界面核心 UI ----
sections.push(() => {
	if (!existsSync(REVIEW_HTML)) return "review-editor.html UI (跳过：不存在)";
	const n = apply(REVIEW_HTML, [
		['children:"Done"', 'children:"完成"'],
		['children:"Retry"', 'children:"重试"'],
		['children:"Reset to defaults"', 'children:"恢复默认"'],
		['children:"Model"', 'children:"模型"'],
		['children:"Theme"', 'children:"主题"'],
		['children:"Theme Preview"', 'children:"主题预览"'],
		['children:"Labels"', 'children:"标签"'],
		['children:"Folder"', 'children:"文件夹"'],
		['children:"Directories"', 'children:"目录"'],
		['children:"Add Directory"', 'children:"添加目录"'],
		['children:"Vault Browser"', 'children:"库浏览器"'],
		['children:"Vault"', 'children:"库"'],
		['children:"Integrations"', 'children:"集成"'],
		['children:"AI Provider"', 'children:"AI 提供商"'],
		['children:"Agent Switching"', 'children:"代理切换"'],
		['children:"All files"', 'children:"所有文件"'],
		['children:"File not found"', 'children:"文件未找到"'],
		['children:"Attachments"', 'children:"附件"'],
		['children:"Example output"', 'children:"输出示例"'],
		['children:"Launch Preview Mode"', 'children:"启动预览模式"'],
		['children:"Learn more"', 'children:"了解更多"'],
		['children:"Release notes"', 'children:"版本发布说明"'],
		['children:"Save Plans"', 'children:"保存计划"'],
		['children:"Plan Width"', 'children:"计划宽度"'],
		[
			'children:"Maximum width of the plan card"',
			'children:"计划卡片最大宽度"',
		],
		['children:"Quick Labels"', 'children:"快捷标签"'],
		['children:"Conventional Comments"', 'children:"常规评论"'],
		['children:"Custom Tags"', 'children:"自定义标签"'],
		['children:"Tag Position"', 'children:"标签位置"'],
		['children:"Default Diff View"', 'children:"默认差异视图"'],
		['children:"Default Save Action"', 'children:"默认保存操作"'],
		['children:"Set Your Default Diff View"', 'children:"设置默认差异视图"'],
		[
			'children:"Side-by-side or inline diff view"',
			'children:"并排或内联差异视图"',
		],
		['children:"Change Indicators"', 'children:"变更指示器"'],
		['children:"Inline Diff Granularity"', 'children:"内联差异粒度"'],
		['children:"Line Background Intensity"', 'children:"行背景强度"'],
		['children:"Tater Mode"', 'children:"Tater 模式"'],
		['children:"Sticky Actions"', 'children:"固定操作按钮"'],
		[
			'children:"Keep action buttons visible while scrolling"',
			'children:"滚动时保持操作按钮可见"',
		],
		['children:"Line Overflow"', 'children:"行溢出"'],
		[
			'children:"How to handle long lines in diffs"',
			'children:"如何处理差异中的长行"',
		],
		['children:"Code Font"', 'children:"代码字体"'],
		['children:"Code Font Size"', 'children:"代码字号"'],
		[
			'children:"Customize labels and their default severity"',
			'children:"自定义标签及其默认严重程度"',
		],
		['children:"Blocking decorator"', 'children:"阻塞装饰器"'],
		[
			'children:"Preset annotations for one-click feedback"',
			'children:"一键反馈的预设批注"',
		],
		[
			'children:"Click on lines to add annotations"',
			'children:"点击行以添加批注"',
		],
		['children:"Select a reference to preview"', 'children:"选择参考以预览"'],
		['children:"Copy Feedback"', 'children:"复制反馈"'],
		['children:"Send to session"', 'children:"发送到会话"'],
		['children:"Show all"', 'children:"显示全部"'],
		['children:"Show full context"', 'children:"显示完整上下文"'],
		['children:"Hide merged"', 'children:"隐藏已合并"'],
		['children:"Clear filters"', 'children:"清除筛选"'],
		['children:"No changes"', 'children:"无变更"'],
		['children:"Diff not available"', 'children:"差异不可用"'],
		['children:"Failed to load diff"', 'children:"加载差异失败"'],
		['children:"Key takeaways"', 'children:"关键要点"'],
		['children:"Suggested code"', 'children:"建议代码"'],
		['children:"Tour Generated"', 'children:"导览已生成"'],
		['children:"Tour Status"', 'children:"导览状态"'],
		['children:"Review Verdict"', 'children:"审查结论"'],
		['children:"Merge Status"', 'children:"合并状态"'],
		['children:"Linked Issues"', 'children:"关联问题"'],
		['children:"Workspace Name"', 'children:"工作区名称"'],
		['children:"Your Identity"', 'children:"您的身份"'],
		['children:"Permission Mode"', 'children:"权限模式"'],
		['children:"Permission Request"', 'children:"权限请求"'],
		['children:"New chat session"', 'children:"新聊天会话"'],
		['children:"No matches found"', 'children:"未找到匹配"'],
		['children:"No agent jobs yet"', 'children:"暂无代理任务"'],
		['children:"No PR metadata"', 'children:"无 PR 元数据"'],
		['children:"Effort"', 'children:"工作投入"'],
		['children:"Fast"', 'children:"快速"'],
		['children:"Fast mode"', 'children:"快速模式"'],
		['children:"Reasoning"', 'children:"推理"'],
		['children:"General"', 'children:"常规"'],
		['children:"Engine"', 'children:"引擎"'],
		['children:"Resolved"', 'children:"已解决"'],
		['children:"Outdated"', 'children:"已过时"'],
		['children:"Stacked"', 'children:"堆叠"'],
		['children:"Worktrees"', 'children:"工作树"'],
		['children:"Obsidian"', 'children:"Obsidian"'],
		['children:"Obsidian Integration"', 'children:"Obsidian 集成"'],
		['children:"Octarine"', 'children:"Octarine"'],
		['children:"Bear"', 'children:"Bear"'],
		['children:"Bear Notes"', 'children:"Bear 笔记"'],
		[
			'children:"Drop image or click to browse"',
			'children:"拖放图片或点击浏览"',
		],
	]);
	return `review-editor.html UI 核心 (${n} 条)`;
});

// ---- [24] browser-automation 扩展命令 ----
sections.push(() => {
	const EXT = join(PI_DIR, "extensions/browser-automation.ts");
	if (!existsSync(EXT)) return "browser-automation (跳过：不存在)";
	const n = apply(EXT, [
		[
			'description: "Show browser bridge status"',
			"description: `显示浏览器桥接状态`",
		],
		[
			'description: "Diagnose browser automation installation"',
			"description: `诊断浏览器自动化安装`",
		],
		['description: "Start browser bridge"', "description: `启动浏览器桥接`"],
		['description: "Stop browser bridge"', "description: `停止浏览器桥接`"],
	]);
	return `browser-automation 命令 (${n} 条)`;
});

// ---- [25] ctx-lite 扩展命令 ----
sections.push(() => {
	const EXT = join(PI_DIR, "extensions/ctx-lite.ts");
	if (!existsSync(EXT)) return "ctx-lite (跳过：不存在)";
	let n = apply(EXT, [
		[
			'description: "Show ctx-lite status: notes count, checkpoints, data dir size"',
			"description: `显示 ctx-lite 状态：笔记数、检查点、数据目录大小`",
		],
		[
			'description: "Delete all notes and checkpoints"',
			"description: `删除所有笔记和检查点`",
		],
		['"Clear all ctx-lite data?"', '"清除所有 ctx-lite 数据？"'],
	]);
	// "This deletes all notes and checkpoints at ${DATA_DIR}." 含模板变量
	if (existsSync(EXT)) {
		let content = readFileSync(EXT, "utf-8");
		const from = "This deletes all notes and checkpoints at ${DATA_DIR}.";
		const to = "这将删除 ${DATA_DIR} 中的所有笔记和检查点。";
		if (content.includes(from) && !content.includes(to)) {
			backup(EXT);
			content = content.replace(from, to);
			writeFileSync(EXT, content, "utf-8");
			n++;
		}
	}
	return `ctx-lite 命令 (${n} 条)`;
});

// ---- [26] plan-mode 扩展命令 ----
sections.push(() => {
	const EXT = join(PI_DIR, "extensions/plan-mode/index.ts");
	if (!existsSync(EXT)) return "plan-mode (跳过：不存在)";
	const n = apply(EXT, [
		[
			'description: "Start in plan mode (read-only exploration)"',
			"description: `以规划模式启动（只读探索）`",
		],
		[
			'description: "Toggle plan mode (read-only exploration)"',
			"description: `切换规划模式（只读探索）`",
		],
		[
			'description: "Show current plan todo list"',
			"description: `显示当前规划任务列表`",
		],
		[
			'description: "Show diff between current and previous plan iteration"',
			"description: `显示当前与上一版规划的差异`",
		],
		[
			'description: "Show Q&A history for current plan discussion"',
			"description: `显示当前规划讨论的问答历史`",
		],
	]);
	return `plan-mode 命令 (${n} 条)`;
});

// ---- [27] searx-search 扩展工具 ----
sections.push(() => {
	const EXT = join(PI_DIR, "extensions/searx-search.ts");
	if (!existsSync(EXT)) return "searx-search (跳过：不存在)";
	const n = apply(EXT, [
		['label: "Web Search"', 'label: "网页搜索"'],
		[
			'description:\n\t\t\t"Search the web using SearXNG metasearch engine. " +\n\t\t\t"Returns aggregated results from Google, Wikipedia, Bing, and many other sources."',
			"description:\n\t\t\t`使用 SearXNG 元搜索引擎搜索网页。` +\n\t\t\t`返回聚合自 Google、Wikipedia、Bing 等 200+ 搜索引擎的结果。`",
		],
		[
			'query: Type.String({ description: "Search query" })',
			'query: Type.String({ description: "搜索查询" })',
		],
		[
			'description:\n\t\t\t\t\t\t"Language code (e.g. zh-CN, en-US, ja-JP). Default: zh-CN"',
			"description:\n\t\t\t\t\t\t`语言代码（例如 zh-CN, en-US, ja-JP）。默认：zh-CN`",
		],
		[
			'description:\n\t\t\t\t\t\t"Search categories: general, news, images, videos, files, social, music. Default: general"',
			"description:\n\t\t\t\t\t\t`搜索类别：general, news, images, videos, files, social, music。默认：general`",
		],
		[
			'description: "Maximum number of results. Default: 10"',
			"description: `最大结果数。默认：10`",
		],
		[
			'description: "检测搜索引擎可用性并缓存"',
			"description: `检测搜索引擎可用性并缓存`",
		],
	]);
	return `searx-search 工具 (${n} 项)`;
});

// ---- [28] 会话选择器（补充翻译） ----
sections.push(() => {
	let n = apply(SESSION_SELECTOR, [
		['"Recent"', '"最近"'],
		['"Fuzzy"', '"模糊"'],
		['"All"', '"全部"'],
		['"Named"', '"有名称"'],
	]);
	// 模板字符串拼接（Sort: / Name: / Delete session?）
	if (existsSync(SESSION_SELECTOR)) {
		let content = readFileSync(SESSION_SELECTOR, "utf-8");
		let changed = 0;
		const extra = [
			['theme.fg("muted", "Sort: ")', 'theme.fg("muted", "排序：")'],
			['theme.fg("muted", "Name: ")', 'theme.fg("muted", "名称：")'],
			['"Delete session?"', '"删除会话？"'],
		];
		for (const [from, to] of extra) {
			if (content.includes(to)) continue;
			if (content.includes(from)) {
				content = content.replace(from, to);
				changed++;
			}
		}
		if (changed > 0) {
			backup(SESSION_SELECTOR);
			writeFileSync(SESSION_SELECTOR, content, "utf-8");
		}
		n += changed;
	}
	return `会话选择器 (${n} 项)`;
});

// ---- [29] 登录对话框补翻（行 99 fallback，行 81 已有翻译被 apply 跳过） ----
sections.push(() => {
	const LG = join(PI, "dist/modes/interactive/components/login-dialog.js");
	if (!existsSync(LG)) return "login-dialog 补翻 (跳过：不存在)";
	let content = readFileSync(LG, "utf-8");
	// apply() 跳过已翻译的行，因为行 81 已翻译的目标字符串导致所有替换被跳过
	// 行 99 的 "Ctrl+click to open" 仍然未翻译，这里直接定位替换
	let n = 0;
	const replacements = [
		['"Cmd+click to open"', '"Cmd+点击打开"'],
		['"Ctrl+click to open"', '"Ctrl+点击打开"'],
	];
	for (const [from, to] of replacements) {
		// 检查行 81 已翻译的，只替换行 99 中还未翻译的
		const firstTranslated = content.indexOf(to);
		if (firstTranslated !== -1) {
			// 存在已翻译的，查找该位置之后的原文
			const afterTranslated = content.slice(firstTranslated + to.length);
			const nextOriginal = afterTranslated.indexOf(from);
			if (nextOriginal !== -1) {
				const absPos = firstTranslated + to.length + nextOriginal;
				content =
					content.slice(0, absPos) + to + content.slice(absPos + from.length);
				n++;
			}
		} else {
			// 没有任何已翻译的，直接用 indexOf 替换第一个原文
			if (content.includes(from)) {
				content = content.replace(from, to);
				n++;
			}
		}
	}
	if (n > 0) {
		backup(LG);
		writeFileSync(LG, content, "utf-8");
	}
	return `login-dialog 补翻 (${n} 项)`;
});

// ---- [30] 用户 skill 描述 ----
sections.push(() => {
	const SKILLS_DIR = join(PI_DIR, "skills");
	const browserFrom =
		`description: >\n` +
		`  Stealth browser automation via CloakBrowser + browser-harness (CDP) + proxy pool.\n` +
		`  Use for web scraping, login automation, form filling, data extraction,\n` +
		`  and any web task requiring anti-detection. Agent can proactively select\n` +
		`  proxies by region, anonymity level, or task type.`;
	const browserTo =
		`description: >\n` +
		`  通过 CloakBrowser + browser-harness (CDP) + 代理池实现隐身浏览器自动化。\n` +
		`  用于网页抓取、登录自动化、表单填写、数据提取\n` +
		`  以及任何需要反检测的网页任务。代理可根据地区、匿名级别或任务类型主动选择代理。`;
	const searxngFrom =
		`description: >\n` +
		`  Install and configure SearXNG metasearch engine as a local web search tool\n` +
		`  for Pi Agent. SearXNG aggregates results from 200+ search services (Google,\n` +
		`  Wikipedia, Bing, GitHub, etc.) without tracking users. Use this when you\n` +
		`  need to give Pi the ability to search the web privately and comprehensively.\n` +
		`  Covers bare-metal installation, configuration, and Pi Extension setup.`;
	const searxngTo =
		`description: >\n` +
		`  安装并配置 SearXNG 元搜索引擎作为 Pi Agent 的本地网页搜索工具。\n` +
		`  SearXNG 聚合来自 200+ 搜索服务（Google、Wikipedia、Bing、GitHub 等）的结果，\n` +
		`  不跟踪用户。当需要让 Pi 具备私密且全面的网页搜索能力时使用此技能。\n` +
		`  涵盖裸机安装、配置和 Pi 扩展设置。`;
	let total = 0;
	const fp1 = join(SKILLS_DIR, "browser-automation/SKILL.md");
	if (existsSync(fp1)) total += apply(fp1, [[browserFrom, browserTo]]);
	const fp2 = join(SKILLS_DIR, "searxng-search/SKILL.md");
	if (existsSync(fp2)) total += apply(fp2, [[searxngFrom, searxngTo]]);
	return `用户 skill 描述 (${total} 项)`;
});

// ---- [31] context-mode 技能描述 ----
sections.push(() => {
	const CTX_SKILLS = join(PINPM_DIR, "context-mode/skills");
	if (!existsSync(CTX_SKILLS)) return "context-mode 技能 (跳过：不存在)";
	const entries = [
		[
			"context-mode/SKILL.md",
			`description: |
  Use context-mode tools (ctx_execute, ctx_execute_file) instead of Bash/cat when processing
  large outputs. Triggers: "analyze logs", "summarize output", "process data",
  "parse JSON", "filter results", "extract errors", "check build output",
  "analyze dependencies", "process API response", "large file analysis",
  "page snapshot", "browser snapshot", "DOM structure", "inspect page",
  "accessibility tree", "Playwright snapshot",
  "run tests", "test output", "coverage report", "git log", "recent commits",
  "diff between branches", "list containers", "pod status", "disk usage",
  "fetch docs", "API reference", "index documentation",
  "call API", "check response", "query results",
  "find TODOs", "count lines", "codebase statistics", "security audit",
  "outdated packages", "dependency tree", "cloud resources", "CI/CD output".
  Also triggers on ANY MCP tool output that may exceed 20 lines.
  Subagent routing is handled automatically via PreToolUse hook.`,
			`description: |
  使用 context-mode 工具（ctx_execute, ctx_execute_file）替代 Bash/cat 处理大型输出。
  触发词："分析日志"、"汇总输出"、"处理数据"、"解析 JSON"、"筛选结果"、"提取错误"、"检查构建输出"、
  "分析依赖"、"处理 API 响应"、"大型文件分析"、"页面快照"、"浏览器快照"、"DOM 结构"、"检查页面"、
  "无障碍树"、"Playwright 快照"、"运行测试"、"测试输出"、"覆盖率报告"、"git 日志"、"最近提交"、
  "分支差异"、"列出容器"、"Pod 状态"、"磁盘使用"、"获取文档"、"API 参考"、"索引文档"、
  "调用 API"、"检查响应"、"查询结果"、"查找 TODO"、"代码行数统计"、"代码库统计"、"安全审计"、
  "过时的包"、"依赖树"、"云资源"、"CI/CD 输出"。
  也自动触发于任何超过 20 行的 MCP 工具输出。
  子代理路由通过 PreToolUse 钩子自动处理。`,
		],
		[
			"ctx-doctor/SKILL.md",
			`description: |
  Run context-mode diagnostics. Checks runtimes, hooks, FTS5,
  plugin registration, npm and marketplace versions.
  Trigger: /context-mode:ctx-doctor
user-invocable: true`,
			`description: |
  运行 context-mode 诊断。检查运行环境、钩子、FTS5、
  插件注册、npm 和商店版本。
  触发：/context-mode:ctx-doctor
user-invocable: true`,
		],
		[
			"ctx-index/SKILL.md",
			`description: |
  Index a local file or directory into context-mode's persistent FTS5 knowledge base
  so future ctx_search calls can retrieve focused snippets without rereading raw files.
  Trigger: /context-mode:ctx-index
user-invocable: true`,
			`description: |
  将本地文件或目录索引到 context-mode 的持久 FTS5 知识库中，
  以便将来的 ctx_search 调用无需重新读取原始文件即可检索到精准片段。
  触发：/context-mode:ctx-index
user-invocable: true`,
		],
		[
			"ctx-insight/SKILL.md",
			`description: |
  Open the context-mode Insight analytics dashboard in the browser.
  Shows personal metrics: session activity, tool usage, error rate,
  parallel work patterns, project focus, and actionable insights.
  First run installs dependencies (~30s). Subsequent runs open instantly.
  Trigger: /context-mode:ctx-insight
user-invocable: true`,
			`description: |
  在浏览器中打开 context-mode Insight 分析仪表板。
  显示个人指标：会话活动、工具使用、错误率、
  并行工作模式、项目关注点和可操作的见解。
  首次运行安装依赖（约 30 秒），后续运行即时打开。
  触发：/context-mode:ctx-insight
user-invocable: true`,
		],
		[
			"ctx-purge/SKILL.md",
			`description: |
  Purge the context-mode knowledge base. Permanently deletes all indexed content
  and resets session stats. This is destructive and cannot be undone.
  Trigger: /context-mode:ctx-purge
user-invocable: true`,
			`description: |
  清空 context-mode 知识库。永久删除所有已索引的内容
  并重置会话统计。此操作具有破坏性且无法撤销。
  触发：/context-mode:ctx-purge
user-invocable: true`,
		],
		[
			"ctx-search/SKILL.md",
			`description: |
  Search context-mode's persistent FTS5 knowledge base for previously indexed
  local project content, documentation, or session memory.
  Trigger: /context-mode:ctx-search
user-invocable: true`,
			`description: |
  在 context-mode 的持久 FTS5 知识库中搜索先前索引的
  本地项目内容、文档或会话记忆。
  触发：/context-mode:ctx-search
user-invocable: true`,
		],
		[
			"ctx-stats/SKILL.md",
			`description: |
  Show how much context window context-mode saved this session.
  Displays token consumption, context savings ratio, and per-tool breakdown.
  Read-only — shows stats only, no reset capability.
  To wipe the knowledge base entirely, use ctx_purge instead.
  Trigger: /context-mode:ctx-stats
user-invocable: true`,
			`description: |
  显示 context-mode 在本会话中节省了多少上下文窗口。
  显示 token 消耗、上下文节省比例和按工具细分的统计。
  只读——仅显示统计，无法重置。
  要完全清空知识库，请使用 ctx_purge。
  触发：/context-mode:ctx-stats
user-invocable: true`,
		],
		[
			"ctx-upgrade/SKILL.md",
			`description: |
  Update context-mode from GitHub and fix hooks/settings.
  Pulls latest, builds, installs, updates npm global, configures hooks.
  Trigger: /context-mode:ctx-upgrade
user-invocable: true`,
			`description: |
  从 GitHub 更新 context-mode 并修复钩子/设置。
  拉取最新代码、构建、安装、更新 npm 全局包、配置钩子。
  触发：/context-mode:ctx-upgrade
user-invocable: true`,
		],
	];
	let total = 0;
	for (const [file, from, to] of entries) {
		const fp = join(CTX_SKILLS, file);
		if (!existsSync(fp)) continue;
		total += apply(fp, [[from, to]]);
	}
	return `context-mode 技能 (${total} 项)`;
});

// ---- [32] pi-subagents 扩展工具标签/描述 ----
sections.push(() => {
	const EXT = join(PINPM_DIR, "pi-subagents/src/extension/index.ts");
	if (!existsSync(EXT)) return "subagents 扩展 (跳过：不存在)";
	let n = 0;
	// label: "Subagent" 在文件中有多处引用，需要精确匹配
	const content = readFileSync(EXT, "utf-8");
	let modified = content;
	let changed = 0;
	// 匹配工具定义中的 label: "Subagent"
	const labelRe = /(label:\s*)"Subagent"/;
	if (labelRe.test(modified) && !modified.includes('label: "子代理"')) {
		modified = modified.replace(labelRe, '$1"子代理"');
		changed++;
	}
	// 匹配 description 第一行
	const descFrom =
		"description: `Delegate to subagents or manage agent definitions.";
	const descTo = "description: `将工作委托给子代理或管理代理定义。";
	if (modified.includes(descFrom) && !modified.includes(descTo)) {
		modified = modified.replace(descFrom, descTo);
		changed++;
	}
	if (changed > 0) {
		backup(EXT);
		writeFileSync(EXT, modified, "utf-8");
		n = changed;
	}
	return `subagents 扩展 (${n} 项)`;
});

// ---- [33] context-mode pi-extension 命令描述 ----
sections.push(() => {
	const CTX_EXT = join(PINPM_DIR, "context-mode/build/pi-extension.js");
	if (!existsSync(CTX_EXT)) return "context-mode 命令 (跳过：不存在)";
	const n = apply(CTX_EXT, [
		[
			'description: "Show context-mode session statistics"',
			'description: "显示 context-mode 会话统计"',
		],
		[
			'description: "Run context-mode diagnostics"',
			'description: "运行 context-mode 诊断"',
		],
	]);
	return `context-mode 命令 (${n} 项)`;
});

// ============================================================
// 主流程
// ============================================================
console.log(`pi 路径: ${PI}`);
console.log(
	`pi 版本: ${(() => {
		try {
			return JSON.parse(readFileSync(join(PI, "package.json"), "utf-8"))
				.version;
		} catch {
			return "?";
		}
	})()}\n`,
);

console.log("开始翻译...\n");

for (let i = 0; i < sections.length; i++) {
	const label = sections[i]();
	console.log(
		`  [${String(i + 1).padStart(2, " ")}/${String(sections.length).padStart(2, " ")}] ${label}`,
	);
}

console.log("\n翻译完成！");

// ---- 翻译覆盖率统计 ----
console.log("\n── 翻译覆盖率 ──");
for (const f of FIRST_NAMES) {
	const c = coverage(f);
	if (c.total > 0 || c.translated > 0) {
		console.log(
			`  ${c.name.padEnd(32, " ")} ${String(c.translated).padStart(3, " ")}/${String(c.total).padStart(3, " ")}  (${c.pct})`,
		);
	}
}

console.log("\n重启 pi 后生效。如需恢复，从 .bak. 文件还原。");
