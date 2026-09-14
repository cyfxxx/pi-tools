# 模块详细步骤

按模块选择执行。每个模块可独立运行，也可组合使用。

---

## A. 代码审查

审查 git 变更（diff/HEAD/未跟踪）：确定性检查 + 清单核对 + 分级报告。

### 触发词
"审查""review""看下改动""PR 审查""检查代码"

### 流程

```
确定审查范围 → 确定性检查 → 人工检查清单 → 验证要求 → 分级报告
```

### 步骤

#### A1. 确定审查范围

```bash
# 自检
bash ~/.pi/agent/skills/pi-full-audit/review.sh --selfcheck

# 查看变更
git status -sb
git diff --stat
git log --oneline -5
```

#### A2. 确定性检查

```bash
bash ~/.pi/agent/skills/pi-full-audit/review.sh
```

脚本输出：git 卫生、语法检查、可疑模式。

#### A3. 人工检查清单

逐项核对（详见 [CHECKLIST.md](CHECKLIST.md)）：
1. 正确性：边界值、错误处理、类型转换、循环边界
2. 安全：输入校验、鉴权、硬编码密钥、路径穿越
3. 资源：句柄关闭、超时设置、递归深度
4. 并发与状态：竞态条件、异步串联
5. 回归影响：API 调用方、配置变更影响面
6. 可维护性：死代码、命名、过时注释

#### A4. 验证要求

- 运行涉及功能的测试
- 类型检查（tsc --noEmit）
- lint 检查

#### A5. 分级报告

按 HIGH/MEDIUM/LOW 分级输出。报告格式见 [REPORT.md](REPORT.md)。

---

## B. 仓库优化

对配置仓库（目录/存储/架构层面）做完整优化：摸底 → 分级方案 → 用户确认 → 执行落地 → 验证提交。

### 触发词
"仓库优化""结构优化""仓库卫生""存储清理""检查 .pi 目录"

### 流程

```
摸底（只读） → 输出分级方案 → 用户确认删除类条目 → 执行与验证 → 收尾汇报
```

### 步骤

#### B1. 摸底（只读）

- **目录树全览**：含隐藏目录，标注每块职责（配置/扩展/运行时/文档/部署）
- **git 状态**：`git status` + `.gitignore` 核对
  - 运行时数据（sessions/logs/checkpoints/stats）是否已忽略
  - lock 文件是否入库
  - ignore 规则是否重复
- **大文件扫描**：bak/、旧工具目录、迁移遗留
- **两类文件区分**：
  - 入库共享：配置、源码、README
  - 运行时本地：会话、日志、统计

#### B2. 仓库体积审计

```bash
# 本地体积（最准确）
git count-objects -vH

# 按大文件排查
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | sed -n 's/^blob //p' | sort -rnk2 | head -20
```

> **注意**：GitHub API `size` 字段有缓存延迟，重写后仍显示旧值。本地 `size-pack` 才是准的。pack 减幅可能小于被删 blob（delta 重算吸收）。

#### B3. 输出分级方案

| 级别 | 定义 | 处理 |
|------|------|------|
| **H1 必改** | 结构错误、gitignore 冲突、丢数据/覆盖风险 | 必须修 |
| **H2 建议** | 仓库卫生（忽略规则、去重、残留清理）、文档同步 | 建议修 |
| **H3 可选** | 重构迁移、长期演进 | 可选 |

每条附：位置、问题、改法、影响/风险。

#### B4. 删除类条目用户确认

涉及删除运行时数据或跨设备文件的条目单列，执行前逐项确认"移除/保留"。

#### B5. 执行与验证

- 按确认方案批量修改，一轮内完成同类改动
- 验证：`bash scripts/test/test-all.sh` 全量回归
- 文档同步：README/AGENTS.md 的目录清单与实际一致
- 提交推送前检查 remote 无 token

#### B6. 收尾汇报

按 H1/H2/H3 分级汇报落地情况，标注未执行项及原因。未确认的删除类条目保持原样。

### 关键要点

- **分析阶段只读，方案先行**
- **运行时数据与入库数据的边界是优化重点**
- **一次优化会话产出 1 个提交粒度**，避免碎提交

### 常见问题

| 问题 | 回答 |
|------|------|
| 如何区分入库共享和运行时本地？ | 入库共享 = 配置/源码/README；运行时 = 会话/日志/统计 |
| 删除类需要确认吗？ | 是，涉及删除运行时数据或跨设备文件必须确认 |
| 优化后如何验证？ | `bash scripts/test/test-all.sh` 全量回归 |

---

## C. 确定性检查

review.sh 自动化检查，覆盖 git 卫生、语法检查、可疑模式。

### 步骤

```bash
# 自检
bash ~/.pi/agent/skills/pi-full-audit/review.sh --selfcheck

# 全量检查
bash ~/.pi/agent/skills/pi-full-audit/review.sh --all <repo_dir>
```

- 保存完整输出到 /tmp 再分析（终端输出会截断）
- **"失败"项先定性再报告**，见 [references/ERROR-CHECKLIST.md](references/ERROR-CHECKLIST.md)
- 阶段 C 可疑模式逐条人工确认

### Windows 便携版专项（目标含 ps1/bat/便携包时）

```powershell
# ps1 语法（PSParser）
$files = Get-ChildItem 'portable\bin\*.ps1','bin\*.ps1','start.ps1'
foreach ($f in $files) {
  $t=$null; $e=$null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e)|Out-Null
  "{0}  {1}" -f ($(if($e.Count){"ERR($($e.Count))"}else{'OK'})), $f.Name
}
# 编码/行尾：ps1 = UTF-8 BOM + CRLF；bat = 无 BOM
# 种子 vs 实例一致性：diff <(cat portable/bin/$f) <(cat bin/$f)
```

---

## D. 运行态巡检

完整清单见 [references/RUNTIME-CHECK.md](references/RUNTIME-CHECK.md)（按需加载）。

覆盖：提示词注入检测、缓存命中分析、token 消耗监控、自动执行功能检查、会话体积审计。

---

## E. 深度并行审查

subagent 并行委派 scout 分组审查 + 复核核实 + 主会话终审。

### 步骤

#### E1. 并行深度审查（subagent 委派 scout）

按模块分组委派 scout，每组独立上下文，主会话只消费压缩报告：

```
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

#### E2. 复核子代理逐条核实（必做）

- 按建议归属模块分组委派，每组一个子代理，任务 = 逐条核实
- 文档一致性发现（第 1c 步产出）豁免本步
- 复核子代理同时负责发现同类遗漏

#### E3. 主会话终审 + 分级报告

1. **汇总表**：真实命中 / 部分属实 / 误报 / 行号错误 / 同类遗漏
2. **争议项终审**：复核结论与审查建议冲突的，主会话亲自验证
3. **定级调整**：机制描述错误/触发面窄的降级
4. **修复方案细化**：给出比审查建议更优的方案
5. 产出分级报告（HIGH 标注"主会话已验证"）

---

## 文档一致性检查（可独立于代码审查执行）

范围 = 项目自有 .md（排除 venv/第三方 repo/node_modules/plans）。按对象分组委派 scout 并行做「文档陈述 vs 实际」可证伪核对：

```
组A: 根 README/CHANGELOG + docs/ —— 对照实际目录树/脚本清单/扩展清单/git log
组B: AGENTS.md + AGENTS-DETAILS + APPEND_SYSTEM —— 对照 extensions/settings.json/rebuild.sh
组C: 各扩展 README vs 源码 —— grep registerCommand/process.env/配置键
组D: 工具类文档 vs 对应实现
```

文档类发现豁免子代理复核（核实只需一条 grep/test，主会话直接定论）。
