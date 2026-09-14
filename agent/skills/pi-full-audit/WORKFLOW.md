# 详细步骤

## 第 0 步：准备

- 确认仓库路径与 git 状态（`git status -sb`），有未提交改动时先处理（stash 或提交）
- 若目标仓库是 ~/.pi：先跑 `review.sh --selfcheck` 确认技能自身最新
- 用 todo 建立 6 步计划
- **基线测试提前并行**：全量回归与后续所有步骤无依赖，本步完成后立即 tmux_run 后台启动

## 第 1 步：确定性检查（机器先跑）

```bash
bash ~/.pi/agent/skills/pi-full-audit/review.sh --all <repo_dir>
```

- 保存完整输出到 /tmp 再分析（终端输出会截断）
- **"失败"项先定性再报告**，见"误报判别清单"
- 阶段 C 可疑模式逐条人工确认

### 第 1b 步：Windows 便携版专项检查（目标含 ps1/bat/便携包时）

仓库含 PowerShell/bat/便携包时，除 review.sh 外追加：

```powershell
# 1. ps1 语法（PSParser；PS 5.1 无 BOM 按 GBK 解析中文 → 乱码破坏语法）
$files = Get-ChildItem 'portable\bin\*.ps1','bin\*.ps1','start.ps1'
foreach ($f in $files) {
  $t=$null; $e=$null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e)|Out-Null
  "{0}  {1}" -f ($(if($e.Count){"ERR($($e.Count))"}else{'OK'})), $f.Name
}
# 2. 编码/行尾：ps1 = UTF-8 BOM + CRLF；bat = 无 BOM（cmd 首行报错）
# 3. 种子 vs 实例一致性（忽略行尾）：diff <(cat portable/bin/$f) <(cat bin/$f)
# 4. 构建断点：setup 脚本依赖自足性
```

### 第 1c 步：文档一致性检查（与确定性检查同批并行）

范围 = 项目自有 .md（排除 venv/第三方 repo/node_modules/plans）。方法：按对象分组委派 scout 并行做「文档陈述 vs 实际」**可证伪核对**：

```text
组A: 根 README/CHANGELOG + docs/ 全部 —— 对照实际目录树/脚本清单/扩展清单/git log 衔接
组B: AGENTS.md + AGENTS-DETAILS + APPEND_SYSTEM —— 对照 extensions 目录/settings.json/rebuild.sh patch 清单
组C: 各扩展 README vs 源码 —— grep registerCommand 命令面/process.env 环境变量/配置键读取
组D: 工具类文档 vs 对应实现
```

## 第 2 步：基线回归测试（审查前必跑）

- 用项目自带全量测试（~/.pi 仓库：`bash scripts/test/test-all.sh`）
- 长任务用 `tmux_run` 后台跑，**命令一律全量重定向落盘**
- 测试**全绿**再进入深度审查；有红项先记录为问题，不阻塞后续步骤

## 第 3 步：subagent 并行深度审查（核心）

按模块分组委派 scout，**每组独立上下文**，主会话只消费压缩报告：

```text
分组参考（~/.pi 仓库）：
  组1: pi-link + pi-autopilot（网络/进程/调度，安全敏感）
  组2: pi-voice + pi-tmux + pi-browser（进程管理、平台适配）
  组3: pi-memory + pi-context + plan-mode（状态/注入/合并）
  组4: pi-web-search + subagent + scripts/ + skills/（fetch/补丁/脚本）
```

**委派 prompt 要点**：
- 明确只读："只读审查，不修改任何文件"
- 明确维度：正确性/安全/资源/并发与状态/回归影响/可维护性
- **输出精简约束**："只列问题，每条 文件:行号 + 一句话描述 + 级别（HIGH/MEDIUM/LOW），LOW 最多 5 条；总输出控制在 2500 字内"

## 第 4 步：复核子代理逐条核实（防过度自信，必做）

**为什么**：初次审查/优化建议必然含缺陷（完美不可能）：行号引用错误、机制描述错误、设计权衡当 bug、定级偏高、遗漏同类问题。

- 按建议归属模块分组委派（沿用第 3 步分组），**每组一个子代理**，任务 = 逐条核实
- **文档一致性发现（第 1c 步产出）豁免本步**

**复核子代理同时负责发现同类遗漏**：核实某条时留意同模块是否存在同一类问题

## 第 5 步：主会话终审 + 分级报告

主会话消费复核结论（每模块一行汇总），不再逐条读代码（上下文保护）：

1. **汇总表**：真实命中 / 部分属实（细节偏差）/ 误报 / 行号或位置错误 / 同类遗漏
2. **争议项终审**：复核结论与审查建议冲突、或 HIGH 定级有争议的，主会话亲自验证
3. **定级调整**：审查标 HIGH 但机制描述错误/触发面窄的降级
4. **修复方案细化**：核实后给出比审查建议更优的方案
5. 产出分级报告（HIGH 标注"主会话已验证"）

## 第 6 步：修复执行闭环（用户要求时）

1. **先列修复计划**（todo 按 HIGH/MEDIUM 分批），用户批准后动手
2. **修复分层执行模式**：
   - HIGH/MEDIUM 核心项：主会话亲自修
   - LOW 项：批量委派 worker 并行修
   - **worker 修复报告不可全信**：主会话抽查关键 diff
3. 每个修复点**至少一个回归测试**
4. 行为/语义变化的修复同步更新 README/CHANGELOG
5. 全量回归：对应扩展 vitest + tsc + 注册面/conflict-check
6. **正则/多层转义类精确修改用 write 写独立 .mjs 脚本执行最可靠**
7. **修复逐项销账**
8. 提交推送
