# Pi 扩展开发注意事项

pi（earendil-works/pi-coding-agent）扩展开发实测经验汇总（2026-08，含 pi-voice 12 问题复盘教训）。与 `agent/AGENTS.md` 全局约定配套，本文件聚焦扩展开发的隐性契约与踩坑点。

## 注册与加载

- pi 0.83+ 从 `~/.pi/agent/extensions/` **自动发现**扩展（扫描含 index.ts 的子目录）；settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制 / `-` 排除），裸路径条目无效
- 新扩展须同步：目录 index.ts、`extensions/tsconfig.json` include、`tests/conflict-check.mjs` 监听者清单、`extensions.test.ts`（注册面）
- 注入类改动（AGENTS.md/注入文案/消息变换阈值）须跑 `tests/cache-guard.mjs --help` 并过基线：注入面是缓存前缀，漂移须 `--update-baseline` 显式确认；prune 阈值（120K/80K/64K）回退会被阻断
- 扩展代码改动后需重启 pi（或 `/reload`）生效

## 命令注册

- **整合规范**：同一扩展 slash 命令 ≤2 个，功能用子命令参数（终端程序风格），支持 `help`/`-h`/`--help`；description 简短并附 `/xxx help` 提示；子命令补全用 `getArgumentCompletions`
- 新增/改动命令必须同步 conflict-check.mjs 清单，否则直接报错

## 快捷键（踩坑重灾区）

- **`enter` 是保留键**：`tui.input.submit` 默认绑 enter，且在 `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 列表（`dist/core/extensions/runner.js`）——扩展注册 **enter 会被静默丢弃，无任何警告**！用 `Key.return`（matchesKey 的 case enter/return 同一分支，`\r` 命中）或 `shift+enter` 等非保留键
- **注册前查保留列表**：`grep -A20 "RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS" dist/core/extensions/runner.js`
- **handler 返回 false = 放行**：依赖补丁 `scripts/patch-voice-enter.mjs`（rebuild.sh 自动执行，pi update 后需重跑）；未打补丁时注册 enter/return 会**吞掉全部回车**（输入提交/菜单失效）——用 `enterPatchApplied()` 探测，未检测到补丁则不注册
- 按键原始数据排查：在 `dist/modes/interactive/interactive-mode.js` 的 `onExtensionShortcut` 打临时日志可看到 `{data, keys:[...]}`——确认按键是否到达、注册是否被丢弃

## 参数补全语义

- **`getArgumentCompletions(prefix)` 的 value 是整体替换参数前缀**（pi-tui `applyCompletion`：`beforePrefix + item.value`），不是追加当前单词！
- 三级命令补全 value 必须含完整参数：用户输入 `/voice tts ` 时 prefix=`"tts "`，value 应为 `'tts on'` 而非 `'on'`（否则命令变成 `/voice on`）
- prefix 参数含多级与空格（`prefix.trim().split(/\s+/)[0]` 取第一级分发）

## UI API

- `ctx.ui.setStatus(key, text)` / `setWidget` / `setFooter`：**纯展示，无点击回调**，不能做可交互按钮
- `ctx.ui.custom()` 对话框：仅键盘交互（Enter/Escape）
- 编辑框：`getEditorText()` / `setEditorText()` / `pasteToEditor()` 可用（按键处理里区分"有内容=发送/空=续录"这类交互要主动确认用户心智模型）
- notify 级别：info / warning / error

## 缓存友好（跨扩展约定）

- system prompt 注入禁止时间戳与精确数值；压力提示按档位固定文案（<75% 不注入 / ≥75% / ≥90% 固定文案）
- token 估算统一用 `lib/context-budget.ts` 的 `estimateTokens`；共享库在 `agent/lib/`（usage-diag.ts、auto-compact.ts、context-budget.ts 等）
- **排序类注入加 banding**（pi-memory M1 先例）：候选按分数排序时，高分前缀（与 top 差 <15%）锚定原序不参与重排——数据增量（新条目）不触发整体顺序变化，KV 缓存前缀保持稳定；多样性/重排只作用于分数相近的尾部 band
- **停止模型生成用 `ctx.abort()`**（plan-mode 先例）：工具执行中需要"结束当前生成、交还输入权"时调用 `ctx.abort()`（等价用户按 Esc 的生成中止信号）；不要在返回文本里依赖模型自觉停止——模型读到"请停止"仍可能继续输出

## 测试与验证

```bash
# 单扩展（须在扩展目录跑，顶层跑会因真实包加载超时）
cd agent/extensions/<ext> && ./node_modules/.bin/vitest run
# 类型 + 冲突
cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.local.json --noEmit
cd agent/extensions && node tests/conflict-check.mjs
# 全量
bash scripts/test-all.sh
```

- **单测的局限**：mock 验证"实现符合假设"，不验证"假设符合真实"——平台集成行为（按键分发、补全语义、硬件行为）必须运行时验证或集成冒烟
- 扩展事件：`before_agent_start` / `message_end` / `input`（返回 `{action:'handled'|'continue'}` 可拦截输入）/ `session_shutdown`（清理兜底）

## 黑盒系统开发流程（pi-voice 12 问题教训）

涉及外部系统（硬件、Android API、daemon）时按 5 阶段走：

```
0 侦察：通读依赖链每层源码/脚本/文档（如 termux-api、pi-tui keys/autocomplete）
1 观测：先建持久日志（logcat 落盘 / dist 临时日志），先于一切修改
2 基准：最小集成冒烟脚本跑通，记录正常行为基线
3 假设显式化：把隐含假设写成文档并实验验证（如"进程退出≠录制结束"——用状态查询接口验证）
4 修改：每次改动跑冒烟对比基线；修复会揭开掩盖层，主动复查观察信号变化
```

- **以真实状态为权威信号**，不以中间进程/中间层推断
- **归因必须验证**：复现不了不修；修之前先抓到根因日志（logcat 滚动快，持续落盘）
- 用户反馈索取量化信息（如"提前结束"→ 要求附实际秒数），缩短诊断循环
- 平台隐性契约（保留键、补全语义、补丁机制）踩过即入文档，避免重复

## Git 约定

- remote 含 token 时推送后立即恢复无凭证 URL；token 内联一次性使用不落盘
- 勿提交 auth.json / settings.json / models.json（已 git ignore）；memory/checkpoints/ 为瞬时快照不入库（entries/notes/summaries 正常备份）
- **推送走 SSH over 443**（免代理免 PAT）：remote = `ssh://git@ssh.github.com:443/cyfxxx/pi-tools.git`；**不要改回 HTTPS**。细节与多环境差异见 `docs/ENVIRONMENTS.md` 与 `docs/TERMUX-DEV-NOTES.md`（网络节）
- **pi-link 运行时文件约定**：跨设备共享类状态（活跃时间戳/远程状态/信箱）放 `~/.pi/` 根目录 `pi-link-*.json`，**gitignore + 每设备独立**（pi-link.json 设备清单同样 gitignored）；设备间信息交换走 ssh 文件读取（readRemoteState/readRemoteOutbox），不引入 HTTP daemon
