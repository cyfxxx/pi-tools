---
name: pi-full-audit
description: 全项目深度审计技能。区别于 pi-code-review（diff/改动审查）：对仓库做全量确定性检查 + 基线回归测试 + subagent 并行深度审查 + 复核子代理逐条核实建议 + 主会话终审 + 分级报告。含会话运行健康巡检（提示词注入/缓存命中/token 消耗/自动执行功能）。用户说"全面检查""深度审计""全项目审查""健康检查""体检""运行检查""会话检查""audit"时触发。
version: v1.8
经验基线: 2026-08-13 /root/.pi 全项目深度审查实战（4 HIGH / 22 MEDIUM 发现，1 项 subagent 方向性误报被人工验证纠正）；同日二次实战：外部 33 条优化建议经 5 组复核子代理逐条核实 → 0 捏造、约 20 准确、12 部分属实、2 处行号错、1 处位置错、3 处同类遗漏，HIGH 中 1 条机制描述错误被纠正降级，1 条"设计当 bug"被驳回；2026-08-14 会话运行巡检实战（缓存命中率 98%+ 实测基准、usage-diag 判定法、注入块 grep 验证的适用性局限——注入不落盘时改用缓存命中率反证、断裂点定位法——systemPrompt 拼入式注入是历史重发根因，pi-memory 改消息注入 + context hook 过滤防累积）；同日缓存验证测试（请求级消息 hash 对比法：usage in 大≠消息断裂，DeepSeek 侧缓存未命中是独立现象；轻量请求 nMsg=4 不影响主请求缓存；修复后记忆变化轮 in=40-92，命中 100%）；同日 dsh 深度分析（deepseek-ai/deepseek-harness 借鉴：注册即 effect、配置分层合并、测试分层、真实运行观察替代 keyless snapshot）；2026-08-14 补充基准工具 pi-bench.sh（usage/timing/compare 三子命令，守护缓存优化不回退）；2026-08-15 全流程实战（50 项发现：1 HIGH / 18 MEDIUM / 19 LOW / 12 同类遗漏，全部修复闭环 6 提交；4 组并行复核首次调用返回空结果→改 2+2 分批重试成功；修复分层执行模式验证：MEDIUM 主会话修 + LOW 三 worker 并行一次成功；scout readonly 化后复核实测改主会话/worker；todo 状态遗漏致 TUI 残留——修复逐项销账纪律；注入块内容质量抽查发现重复/空摘要/截断条目）；同日合并后全量审计（test/portable-win-merge 分支，5 组并行=4 模块+1 文档专项，36 项发现经复核：3 误报纠正/2 部分属实降级/行号普遍 ±20-30，4 HIGH 全修复+回归测试；文档同步 4 处不一致；审计工具自身 bug：review.sh --all 对 ~/.pi 自身失效——排除规则 */.pi/* 误伤扫描根（249 文件只审到 1 个），修复后全量可扫；功能实测维度：扩展真实调用验证（含环境排查：CLOAKBROWSER_BINARY_PATH 从 Termux 泄漏到 WSL 致 pi-browser 启动失败——wrapper 无条件导出 Termux 路径）；2026-08-17 远程合并超严格审计实战（用户强调重要性：合并完整性用 md5 逐文件比对 master vs 分支 + 功能符号 grep，发现 squash 合并只带早期快照——portable-win 46 提交仅早期入 master、pi-browser Windows 便携修复（探测/直连/路径校验）缺失，三点合并移植保留 master 独有修复；subagent 并行 4 组确认每项修复方案，修正 2 处主会话误判：rebase diff 方向看反的 .gitignore 误报、bash 顶层 local 报错但变量仍设置的行为噪音误判；深层审查揪出 d323ab9 审计修复半闭环——fireViaMessage 改语义后 once 任务每小时重复注入永不删除、notifyOnCompletion 死功能、failoverCount 不重置（表面测试通过因只覆盖 subagent 路径），在 agent_settled 补 finalizeInjected 闭环；dsh 优化落地：opencode-go 无 contextWindow 致自动压缩静默失效（getContextUsage 返回 undefined）——resolveContext fallback（turn_end provider tokens + PI_CONTEXT_WINDOW_FALLBACK 1M）+ 0.8 阈值对齐 dsh + 溢出兜底；注入截断质量：truncateByTokens 硬切残句 + 标记预算未扣除（实测超 11 token）——句子边界感知 + TRUNC_MARK_TOKEN_BUDGET 修复；缓存复查：优化后常态命中 99.5%+ vs 历史 86% 基线，断裂三类分类法（重启首轮/注入变化/擦除压缩）；openocde.ai usage 云页访问失败（OAuth/SPA SSR RPC 拿不到）——本地三途径替代（stats/db/usage-diag）。教训沉淀：临时文件 basename 冲突覆盖污染 diff、sed 行号删除后先 grep 验证、合并后验证 master 独有修复未被覆盖、审计语义修正必须检查调用链闭环）

---

# pi-full-audit 全项目深度审计

对整个仓库（含扩展、脚本、技能）做一次完整审计，产出可信的分级报告。核心信条：**审查报告不可全信，建议清单必须经复核子代理逐条核实、主会话终审后才可执行**。

## 与 pi-code-review 的分工

| | pi-code-review | pi-full-audit |
|---|---|---|
| 范围 | git 变更（diff/HEAD/未跟踪） | 全仓库全量（--all） |
| 深度 | 单文件逐项核对 | 确定性检查 + 全量测试 + 并行深度审查 + 复核核实 + 终审 |
| 适用 | "审查这个改动" | "全面检查这个项目" |

## 工作流

### 第 0 步：准备

- 确认仓库路径与 git 状态（`git status -sb`），有未提交改动时先处理（stash 或提交），避免审查对象含半成品
- 若目标仓库是 ~/.pi：先跑 `review.sh --selfcheck` 确认技能自身最新（注意：selfcheck 检查的是**当前 cwd** 而非技能目录，须在仓库内运行）
- 用 todo 建立 6 步计划：确定性检查 → 基线测试 → 并行深度审查 → 复核核实 → 终审报告 → 修复闭环

### 第 1 步：确定性检查（机器先跑）

```bash
bash ~/.pi/agent/skills/pi-code-review/review.sh --all <repo_dir>
```

- 保存完整输出到 /tmp 再分析（终端输出会截断）
- **"失败"项先定性再报告**，见"误报判别清单"
- 阶段 C 可疑模式逐条人工确认（大部分是 child_process/console.log 的正常使用）

### 第 1b 步：Windows 便携版专项检查（目标含 ps1/bat/便携包时）

仓库含 PowerShell/bat/便携包（portable/ 种子 + 实例 bin/ 双份）时，除 review.sh 外追加：

```powershell
# 1. ps1 语法（PSParser；PS 5.1 无 BOM 按 GBK 解析中文 → 乱码破坏语法）
$files = Get-ChildItem 'portable\bin\*.ps1','bin\*.ps1','start.ps1'
foreach ($f in $files) {
  $t=$null; $e=$null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e)|Out-Null
  "{0}  {1}" -f ($(if($e.Count){"ERR($($e.Count))"}else{'OK'})), $f.Name
}
# 2. 编码/行尾：ps1 = UTF-8 BOM + CRLF；bat = 无 BOM（cmd 首行报错）
#    BOM 检查：head -c 3 <f> | xxd -p（efbbbf = BOM）
# 3. 种子 vs 实例一致性（忽略行尾）：diff <(cat portable/bin/$f) <(cat bin/$f)
#    修复只改实例（gitignored）忘同步种子（入库）是经典漂移
# 4. 构建链断点：setup 脚本依赖自足性——uv/python/服务端 py/补丁文件由谁下载？
#    clone/pull/push 分支正确性（master 停更场景）；补丁查找路径（bin/ → scripts/ 兜底）
```

**编码/行尾实战坑（2026-08-15 沉淀）**：

- ps1 中文必须 UTF-8 BOM（PS 5.1 无 BOM 按 ANSI/GBK 解析 → 乱码可能破坏语法）；bat 反之必须无 BOM
- 修改 ps1 用 python `open(p,'w',encoding='utf-8-sig')`（保持 BOM）；含反斜杠的锚点用 raw 字符串（r"""..."""），否则 `\b`/`\n` 被解释成控制符导致匹配失败
- PowerShell here-string 打开符 `@"` 必须行首（PS 5.1 缩进打开符报错）；转义串里多余反引号会把闭合引号转义掉 → 整文件解析崩溃（searxng-setup 实例，ParseFile 18 错误）
- 种子/实例双份文件：修改后必须双向同步，提交只认种子（实例 bin/ gitignored）

### 第 2 步：基线回归测试（审查前必跑）

- 用项目自带全量测试（~/.pi 仓库：`bash scripts/test-all.sh`）
- 长任务用 `tmux_run` 后台跑。**禁止 tmux_wait 阻塞等待**（AGENTS.md 铁律；2026-08-15 实战教训：until_exit 等满 420s 占用前台）——tmux_run 后结束回合或转做其他独立工作，后续轮次用 `tmux_read` 轮询结果
- 测试**全绿**再进入深度审查；有红项先记录为问题，不阻塞后续步骤

### 第 3 步：subagent 并行深度审查（核心）

按模块分组委派 scout，**每组独立上下文**，主会话只消费压缩报告：

```text
分组参考（~/.pi 仓库）：
  组1: pi-link + pi-autopilot（网络/进程/调度，安全敏感）
  组2: pi-voice + pi-tmux + pi-browser（进程管理、平台适配）
  组3: pi-memory + pi-context + plan-mode（状态/注入/合并）
  组4: pi-web-search + subagent + scripts/ + skills/（fetch/补丁/脚本）
  组5（文档专项，用户要求"检查文档是否更新"时加）: AGENTS.md + 各扩展 README + docs/ + portable/README + skills SKILL.md——
      找：引用不存在的路径/命令/旧扩展名（pi-web-toolkit/pi-router/pi-admin/pi-scheduler、旧命令 /tts /planclear /auto:*）、
      文档描述功能已删除更名、代码新增功能文档未提、计数类过时（"9 个扩展"、测试用例数）；输出严格精简（每条 ≤60 字、≤12 条、结尾给核对一致总结）
```

**功能实测维度**（用户要求"测试所有扩展功能"时，审查之外对每个扩展做真实工具调用验证）：
- 逐个调用扩展暴露的工具/能力（memory_stats、autopilot_status、link_status、web_search、browser_navigate、tmux_run、subagent 委派等），记录成功/失败/环境限制
- 实测失败先排查环境再报扩展缺陷：2026-08-15 实战——browser_navigate 报 Termux 路径实际是 CLOAKBROWSER_BINARY_PATH 从 Termux 泄漏到 WSL（pi-wrapper.sh 无条件导出 Termux 默认值，无平台守卫）；pi-voice 缺 ffmpeg/pulse 属环境未装（apt install ffmpeg 即恢复）；searxng 瞬时超时重试即恢复
- 环境限制项标注"受环境限制"并引用对应 vitest 用例数（如 pi-browser 24 用例全绿但运行时缺 chromium 二进制）
- 修复环境后实测通过才销账（如 wrapper 修复需重启 pi 生效——记录"需重启验证"）

**委派 prompt 要点**（照抄进任务描述）：
- 明确只读："只读审查，不修改任何文件"
- 明确维度：正确性/安全/资源/并发与状态/回归影响/可维护性
- **输出精简约束（防截断）**："只列问题，每条 文件:行号 + 一句话描述 + 级别（HIGH/MEDIUM/LOW），LOW 最多 5 条；无问题项明确说明；总输出控制在 3000 字内"
- **涉及运行时行为/机制描述的建议标注"需实测"**（子进程语义、超时行为、事件时序等）——审查阶段只做读码判断，实测留给第 4 步复核（缩小复核排查面）

- 指定 cwd 为仓库根

**报告截断处理**：若返回报告被截断，重新委派该组并要求更精简格式，不要凭截断内容下结论。

**并行批空结果/超时降级**（2026-08-15 实战）：4 组并行委派首次调用返回 "No result provided"（空结果）——整个批失败不代表任务失败，降级分批重试（2+2 或逐组），不要凭空结果下"无问题"结论。

### 第 4 步：复核子代理逐条核实（防过度自信，必做）

**为什么**：初次审查/优化建议必然含缺陷（完美不可能）：行号引用错误、机制描述错误、设计权衡当 bug、定级偏高、遗漏同类问题。若主会话直接采信，错漏会原样进入修复。把建议清单委派给**复核子代理**逐条核实——独立上下文不受主会话先入为主影响，也避免主会话上下文被大量代码细节污染。

- 按建议归属模块分组委派（沿用第 3 步分组），**每组一个子代理**，任务 = 逐条核实
- 核实 prompt 模板（照抄进任务描述，每条建议原文完整粘贴含声称的 文件:行号）：

```
在 <cwd> 下核实以下审查问题是否真实存在。逐条阅读对应代码给出结论：真实/误报/部分属实，并判断修复建议是否合理。
1. <条目原文：文件:行号 + 机制描述 + 修复建议>
...
输出格式：每条一行「结论（真实/误报/部分属实）+ 依据（关键代码摘录 3-5 行）+ 修复建议是否合理的判断」；
声称的行号与实际不符时明确指出实际位置；顺手检查该模块 tests/ 是否有相关测试覆盖这些行为；
最后给总体判断：哪些准确命中、哪些误报或夸大、有无同类遗漏。
```

- **复核子代理同时负责发现同类遗漏**：核实某条时留意同模块是否存在同一类问题（如“A 处不落盘”→ 查 B 处是否同样不落盘；“A 处 ETIMEDOUT 死分支”→ 查 B 处）
- **运行时行为必须实测**：Node 子进程超时语义（err.code=null/signal='SIGTERM'）、glob 展开、spawn 错误事件（异步 error 而非同步抛错）等以实测为准，不凭注释/直觉/审查者的机制描述。注意（2026-08-15）：scout 已标 frontmatter `readonly: true`（subagent 扩展 spawn 时强制过滤 bash，计划模式只读隔离修复），复核 scout **无法执行 bash 实测**——需实测的验证由主会话（有 bash）或委派 worker 完成；scout 只做读码级核实并在报告中标注“未实测”项
- 报告截断处理同第 3 步（重委派要求精简）

### 第 5 步：主会话终审 + 分级报告

主会话消费复核结论（每模块一行汇总），不再逐条读代码（上下文保护）：

1. **汇总表**：真实命中 / 部分属实（细节偏差）/ 误报 / 行号或位置错误 / 同类遗漏——先给这个表再给报告
2. **争议项终审**：复核结论与审查建议冲突、或 HIGH 定级有争议的，主会话亲自验证（读代码 + 实测），以主会话终审为准
3. **定级调整**：审查标 HIGH 但机制描述错误/触发面窄的降级；注释自认的设计权衡降 MEDIUM 并注明（如“写死工具集”是执行模式刻意限制）；被推翻的项注明原因
4. **修复方案细化**：核实后给出比审查建议更优的方案（实战例：预算拦截直接 updateTaskAfterRun 会消耗重试次数，更优是仅推进 nextRun 不记 failed）
5. 产出分级报告（格式见下，HIGH 标注“主会话已验证”）

### 第 6 步：修复执行闭环（用户要求时）

1. **先列修复计划**（todo 按 HIGH/MEDIUM 分批），用户批准后动手（审计本身只读）
2. **修复分层执行模式**（2026-08-15 实战验证，高效且质量可控）：
   - HIGH/MEDIUM 核心项：主会话亲自修（安全敏感逻辑，上下文可控）
   - LOW 项：批量委派 worker 并行修（2-3 个 worker 按模块分组），每个 worker 的 prompt 给精确的 文件:行号 + 修复方案 + 回归测试要求 + 输出格式约束（每项一行、总输出≤1500 字）；worker 间文件不重叠防冲突
   - **worker 修复报告不可全信**：主会话抽查关键 diff（每个 worker 抽 2-4 处：外部句柄承接/状态迁移/边界条件），确认与方案一致
3. 每个修复点**至少一个回归测试**：优先补在对应扩展现有测试文件；测试要能捕获旧行为（修复前先跑一遍确认失败）
4. 行为/语义变化的修复同步更新 README/CHANGELOG（有维护惯例的扩展，如 subagent/plan-mode/pi-web-search 有 CHANGELOG）；代码注释与实现矛盾的一并更正
5. 全量回归：对应扩展 vitest + tsc + 注册面/conflict-check（`bash scripts/test-all.sh`）；新测试文件要进仓库而非临时验证；全量回归同样 tmux_run 后台跑（禁 tmux_wait，见第 2 步）
6. **修复逐项销账**：对照审计报告清单逐项核对修复状态（2026-08-15 教训：多任务同文件合并完成时漏更新 todo 状态，#5 残留待办行被用户发现）；全部完成后 todo delete 归档清除 TUI 展示
7. 提交推送：按仓库惯例分离提交（如代码修复 / memory/entries.json 记忆增量分开）；push 前确认 remote 无凭证 token；SSH remote 直接推

## 分级报告格式

先给“基线验证”表（确定性检查 + 回归测试结果，全绿事实优先），再按 HIGH/MEDIUM/LOW 分级。格式：

```
## 全项目审计报告
**审查范围**: ... | **方法**: 确定性检查 + 基线测试 + N 组并行审查 + 复核子代理逐条核实 + 主会话终审

## 零、基线验证（全绿）
| 检查 | 结果 |

## HIGH（必须修）
- `路径:行号` — 描述（已验证）
  > 修复：...

## MEDIUM（建议修）
（按模块分组）

## LOW（节选）

## 总体评价与修复顺序
```

分级标准与 pi-code-review 一致（HIGH=明确 bug/安全；MEDIUM=边界/健壮性/性能；LOW=疑似误报/吹毛求疵）。

## 误报判别清单（本次实战沉淀）

遇到以下情况先定性，别直接报：

- **密钥扫描命中**：先 `git ls-files <file>` + `git check-ignore -v <file>`。git ignored 的运行配置（~/.pi 的 auth.json/settings.json/models.json）是正常存在，**不是泄露**；只有被 git 跟踪的才是 HIGH
- **review.sh --all 排除陷阱（2026-08-15 实测）**：排除规则 `! -path '*/.pi/*'` 在扫描根自身是 .pi 目录（如 `review.sh --all /root/.pi`）时误伤全部文件——"待审文件: 1 个"而预览 249 个即此症状。已修复（根为 .pi 时禁用该排除）；审计中若发现待审文件数远小于预览数，先怀疑排除规则而非仓库无文件
- **运行时数据噪音**：`--all` 会扫入入库的运行时数据（如 memory/entries.json），其中的文本内容命中 rm -rf/密钥等模式属噪音，跳过
- **glob 陷阱**：`for d in dir/*/node_modules` 只在**全部不匹配**时保留字面量；部分不匹配 = 静默漏检，不是报错
- **"没找到 X" ≠ "X 不存在"**：先 grep 确认是否在其他层实现（如删除落盘在 deleteEntry 内部 vs 工具函数外层）
- **ETIMEDOUT 类分支**：Node 子进程超时行为与版本相关，实测确认，不要信注释或直觉
- **运行时行为必须实测**（2026-08-15 扩展）：Node 子进程超时语义（err.code=null/signal='SIGTERM'）、glob 展开、spawn 错误事件（异步 error 而非同步抛错）等以实测为准，不凭注释/直觉/审查者的机制描述。注意：scout 已标 frontmatter `readonly: true`（subagent 扩展 spawn 时强制过滤 bash），复核 scout **无法执行 bash 实测**——需实测的验证由主会话（有 bash）或委派 worker 完成；scout 只做读码级核实并在报告中标注"未实测"项
- **审查建议的行号引用**：常与实际位置不符（偏差可达几十行）——行为成立但行号错不算误报，以 grep/sed 实际定位为准并在结论中纠正
- **审查者的机制描述**：不可轻信，追完整调用链核实（实战：“spawn 抛错即永久泄漏”实际是异步 error 事件且已有处理+测试）
- **设计当 bug**：代码注释自认的故意设计（写死工具集/磁盘兜底/非阻塞注入）按设计权衡报并注明，不按纯 bug
- **同类遗漏**：审查只报一处的，检查同模块第二处（environments 合并两处、ETIMEDOUT 两处、掩蔽路径两处）
- **修复建议可改进**：审查给的修复方案常非最优或带副作用（预算拦截用 updateTaskAfterRun 会消耗重试次数），核实后给出更优方案
- **PS 解析错误先查编码**：ParseFile 报乱码错误 = 无 BOM/GBK 解码（修复加 BOM）；报结构错误 = 看反引号/引号配对（多余反引号会转义掉闭合引号）
- **Windows 测试隔离**：os.homedir() 优先 USERPROFILE 而非 HOME——stubEnv('HOME') 不生效 → 测试读写真实用户配置（pi-voice.json 被测试数据污染事故）；测试 stub 必须 HOME+USERPROFILE 双设

## 会话运行检查（运行时健康巡检）

对**当前 pi 会话的运行态**做健康检查——区别于上述代码审计（审运行态而非代码态）。随时可单独执行（只读、无依赖）。触发词："运行检查""会话检查""健康巡检"。

### 检查清单（按序）

1. **运行时状态**：`admin_status`（模型/provider/会话文件/思考层级）+ `autopilot_status`（自主运行开关、任务数、遥测、预算、failover）+ `schedule_task list`（定时任务）
2. **缓存命中与 token**：读 `agent/.usage-diag.jsonl` 尾部 3 条：
   - 命中率 = cacheRead / (input + cacheRead)，正常 >90%（实测 98%+）；偏低 → system prompt 前缀不稳定（时间戳注入/banding 失效）
   - **统计修正（2026-08-14 实战）**：先排除 run 边界轮——重启/--continue 恢复/新实例后的首轮必然重发（context 重建），不算异常；usage-diag 记录所有 turn_end（含同机其他 pi 实例、昨晚实例），统计全量时先按时间窗口滤出当前会话活跃期
   - **断裂点定位法**：低命中轮的 cacheRead ≈ 断裂点位置。断裂点 ≈ system prompt 尾部 → **systemPrompt 拼入式注入**（如 pi-memory 旧实现）——变化时全部历史重发，应改为消息注入；断裂点在消息末尾 → 注入块变化，成本仅注入本身（≤几 K），正常
   - **请求级验证法（比 usage 统计更精确，2026-08-14 实测）**：usage 的 in≈40-50K 并不等于消息序列断裂——写临时 debug 扩展监听 `before_provider_request`，对每条消息做完整内容 hash，对比相邻请求：前 N 条 hash 全同 = 无断裂（in 大是 DeepSeek 侧缓存未命中，与消息内容无关）；首个不同消息 = 精确断裂点。测完删除扩展
   - **缓存断裂三类成因（实测分类）**：A 注入变化（systemPrompt 拼入式注入，已修）；B DeepSeek 侧缓存未命中（100K+ 上下文时偶发 in≈41K 轮，消息序列无断裂，嫌疑 thinking 全文/请求格式，超出扩展可控范围）；C run 边界（重启/恢复首轮）。另有 pi 内部轻量请求（nMsg=4，每 3-5 分钟一次）不影响主请求缓存
   - input 应远小于 cacheRead（每轮只发增量）；input 涨到数千 → 历史膨胀
   - contextTokens 接近预算上限 → 报告压力档位注入（≥75%/≥90% 文案）
   - 自动压缩触发次数高（usage-diag 中 `type:"auto-compact"` 事件行）→ 检查 pi-context 压缩配置
3. **会话体积**：会话 jsonl 大小 + 消息数（对比历史会话，异常膨胀提示上下文失控）
4. **注入块**（适用性检查）：注入内容无时间戳/精确数值（缓存友好）。注意实测（2026-08-14）：注入在请求时生成、**不落盘会话文件**时，`grep -c pi-memory-injection <会话文件>` 只能命中工具参数文本，计数无意义——改用检查项 2 的缓存命中率反证注入稳定性；仅当会话文件中可见注入 customType 标记（落盘环境）时才用 grep 计数（应≈请求轮数）
   - **内容质量抽查**（2026-08-15 实战发现三类残留，已修复）：① 重复摘要（同 sessionId 多条历史摘要均注入——根因 appendSummary 无 upsert，已修）；② 空摘要（"开场问候无实质内容""无可提取"类仍在注入——已修 doExtract 质量门 + isSubstantiveSummary 过滤）；③ 硬截断条目（slice(0,200) 切半如"跨""用 readlink "——已修 truncateByTokens 80 token 带标记）。抽查 memory/summaries.json 与注入块构建逻辑，验证修复持续生效（无新增重复/空摘要/残句）

5. **日志与残留**：`ls -lt logs/` 查错误；`logs/tmux/` 残留日志（测试遗留可清）；`tmux_status` 活动会话
6. **后台任务**：`crontab -l` 中 pi-cron.sh；watchdog 状态文件（`agent/.pi-autopilot-state.json` 存在 = 触发过）
7. **真实运行观察（keyless snapshot 替代，2026-08-14 沉淀）**：mock 测试发现不了缓存/注入/状态流问题（本次 72K 重发就是 mock 全绿+真实运行才暴露的）。做法：实际触发一轮关键路径操作并观察行为：
   - `memory_store` 写一条 → 观察该轮 usage：记忆变化轮 input 应 <500（消息注入已修复）；>70K = 拼入式注入回退
   - `todo update`（plan-mode）→ 观察状态条/overlay 即时刷新 + 该轮 input
   - bash 大输出轮 in≈50K 属 DeepSeek 侧缓存现象（消息序列无断裂，请求级 hash 验证法确认），不算注入回归
   - 验证模板（2026-08-14 实测）：记忆变化轮 in=40-92 token 命中 100%；连续相邻请求逐消息 hash 全同
   - 基准工具：`bash scripts/pi-bench.sh usage`（聚合报告）`timing`（关键计时）`compare <基准>`（退化检测）

### 判定基准（2026-08-14 实测沉淀）

| 指标 | 正常 | 异常 |
|---|---|---|
| 缓存命中率 | >90%（实测 98%+） | 偏低 → 注入稳定性问题（排除 run 边界轮后仍低 = 实锤；断裂点 ≈ system prompt 尾部 → systemPrompt 拼入式注入需改消息注入） |
| 每轮 input | <2K | 涨 → 历史膨胀/缓存失效 |
| 自动压缩触发 | 偶发 | 频繁 → 压缩配置 |
| 定时任务/遥测 | 与配置一致 | 任务缺失、遥测失败率高 |
| failover | 未配置属正常 | 配置了但频繁切换 → 模型不稳定 |

### 输出格式

```
## 会话运行检查报告
**会话**: <文件> | **模型**: <provider/model>
1. 提示词注入: ✓/✗ + 依据
2. 工具调用: ✓/✗（无扩展报错/未处理异常）
3. 缓存命中: xx%（基准 >90%）
4. token 消耗: context xxK / 预算 xxK / 自动压缩次数（usage-diag auto-compact 事件行）
5. 自动执行: ✓/✗（任务/遥测/预算/watchdog）
结论: 正常 / N 项异常（附修复建议）
```

### 与代码审计的关系

运行检查发现问题需要改代码时：小改动走 pi-code-review（审查 diff 后修），系统性改动转本技能第 6 步（修复闭环）。运行检查不替代审计，两者互补。

## 约定

- **只读**：审计全程不改文件。用户要求修复时先列计划（第 6 步）。
- **复核必做**：任何建议清单（本技能产出或外部审查模型提供）进入修复前，必须经第 4 步复核子代理逐条核实。
- **敏感信息脱敏**：报告密钥只报位置。
- **报告与验证分离**：报告中每个 HIGH 明确标注“主会话已验证/复核核实/待验证”，防止未经验证的判断误导修复优先级。
