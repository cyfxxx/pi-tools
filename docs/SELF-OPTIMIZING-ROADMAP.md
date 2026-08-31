# 可自我优化的全能型私人助手 — 差距分析与行动路线图

> 制定：2026-08-19/20 战略会话 | 状态：执行中（阶段 1）
> 范围确认：用户已同意；自主优化授权放宽为"低风险自动执行，高风险需确认"（边界见 §5）

## 1. 目标拆解

| 轴 | 含义 | 现有关键资产 |
|---|---|---|
| 感知/交互（全能的面） | 输入输出渠道多样化 | 文本、语音（pi-voice）、浏览器（pi-browser）、搜索（pi-web-search/SearXNG）、多设备（pi-link）、截图分析 |
| 记忆/学习（沉淀） | 跨会话积累、知识检索 | pi-memory（529 条目/21 摘要，环境标签+去重）、会话摘要、note-store |
| 行动/自治（做事） | 持续运转、自动执行 | pi-autopilot（定时/看门狗/failover/预算）、pi-tmux 后台、subagent、plan-mode |
| 自我优化（核心差异化） | 测量→改进→验证→回滚闭环 | usage-stats.mjs、usage-diag、cache-guard、test-all.sh、9 patch 脚本、pi-backup |

前三个轴已成可运行骨架；**核心差异化在第四轴**，此前缺口是"闭环未串通 + 触发靠人工"。

## 2. 差距摘要（按严重度）

- **A. 自优化闭环已串通（2026-08-20 晚）**：测量/决策/验证/回滚齐备、触发自动化实弹；2.4 失败会话学习（lesson-miner.mjs）与 2.5 用量账单（usage-stats 工具聚合，08-20 落地并持续入账）均已实现；剩余差距=压缩可逆快照（2.6）。
- **B. 缓存命中已达标**：实弹 97.7%（daily-health 08-20），目标 97% 达成；A 类断裂归因已实证（compaction/早期改写/大工具输出，非记忆注入）。
- **C. 感知面**：文档解析/OCR/知识订阅已就绪；语音双后端（whisper+sherpa）；输出渠道（通知推送）待稳定主机后接入。
- **D. 运维**：记忆库 GC 按 §4.2 规则；pi-link 无人值守拒跨设备指令保留（安全特性）。

## 3. 行动计划

### 阶段 1（快赢）：打基线、补测量触发、清历史欠账
| # | 项 | 产出/验收 | 状态 |
|---|---|---|---|
| 1.1 | 固化健康指标 | `SELF-OPTIMIZING-BASELINE.md`（命中率/断裂/记忆库/回归基线） | 2026-08-20 |
| 1.2 | 澄清缓存断裂归因 | usage-stats.mjs 诊断文本更新（注入非主因实证） | 2026-08-20 ✔ |
| 1.3 | 记忆 GC 策略 | 冷数据清理规则入 memory 库（procedure） | 2026-08-20 |
| 1.4 | 实验记录模板 | `OPTIMIZATION-LOG.md` 三段式规范 | 2026-08-20 |
| 1.5 | 回归基线 | test-all.sh --fast 全绿记录 | 2026-08-20 |

### 阶段 2（中期）：闭环自主化
| # | 项 | 验收 |
|---|---|---|
| 2.1 | 每日自动自检 | ✅ 实弹通过（08-20 8:30 命中 97.7%／断裂 0） |
| 2.2 | 决策启发式成文 | 何时调阈值（断裂率阈值）/何时重构/何时回滚 写入本文档 §4 |
| 2.3 | 优化工单闭环 | 每次自检产出的建议可跟踪执行→验证→回滚 |
| 2.4 | 失败会话学习（headroom learn 本地化） | 从 usage-diag 断裂轮/异常轮规则化归因 → 教训落 memory（solutions）+ AGENTS-DETAILS 附录，补“观测→归因”缺的“写入修正”端 |
| 2.5 | 工具/技能用量账单 | usage-stats 按工具聚合调用/token（tool-events.jsonl 数据源）→ 优化优先级数据化 |
| 2.6 | 压缩可逆快照（headroom CCR 本地化） | ✅ 已上线：auto-compact 触发前原文快照落盘 logs/compact-snapshots/（保留 8 个/7 天），压缩后原文可追溯（运行产物已验证） |

### 阶段 3（战略期）：全能面扩展
| # | 项 | 备注 |
|---|---|---|
| 3.1 | 文档解析/OCR | ✅ 完整可用：doc-extract.py（txt/md/csv/json + docx/xlsx 零依赖）已验；poppler-utils(pdf)+tesseract(chi_sim) 已装并验 |
| 3.2 | 知识订阅 | ✅ 自动化就绪（knowledge-fetch.py 零 LLM 抓取 + 并入每日自检摘要入库）；5 关键词已配；实弹待明日 |
| 3.3 | 通知推送 | ✅ 骨架完成（pi-notify.sh + 模板配置 + 自检联动）；⚠️ 渠道接入暂缓（无稳定主机，未配置真实渠道，保证不误发） |
| 3.5 | ntfy 自托管 | ⏸ **暂缓**：用户确认暂无常驻可跑 Docker/systemd 的主机；待有节点后恢复 Tailscale 内网方案 |
| 3.4 | 领域扩展 | ⏸ **暂缓**：无邮箱/Telegram 需求、无稳定主机；用户明确重心=优化 pi + 日常沟通，暂不接入外部业务系统 |

## 4. 决策启发式（成文 v1，随经验修订）

输入：每日自检 health-alert / full-audit / 用户观察。各规则独立判定，优先处理触发条数最多的信号。

### 4.1 命中率退化
- **触发**：连续 3 会话命中率 <85%，或单会话断裂 >3 次且浪费 >300K。
- **行动**：usage-stats --json 定位断裂轮 → 对照该轮事件 → 分类归因（先行顺序：compaction 改写 → 早期消息改写/thinking 剪枝 → 大工具输出改写 → provider 缓存键 → enable_tool；**注入块在尾部≤500 token 非主因，勿归因记忆操作**）。
- **止损**：断裂根因未明的会合先不做结构大改，只记录；确需调 thinking/压缩阈值时增量 20% 步进。
- **回滚**：改动后命中率反降 >3pp 且无确认修复路径 → git 回滚 + LOG 记 rolled-back。

### 4.2 记忆库膨胀
- **触发**：存储 >0.8MB（远低于告警线 1.8MB 即先动）或 活跃条目 >600 或 冷数据 >100。
- **行动**：memory_stats 分类 → 快照（ctx_snap/cp）→ 删被取代/过期条目、合并近似（merge 机制）→ 复测。
- **达标**：存储 <0.5MB 且冷数据 0。批量删除走授权边界（高风险需确认）。

### 4.3 回归失败
- test-all 红 → 改动未提交先回滚；已提交则修补丁。同一根因红 3 次 → 标 blocked 暂停该线优化，先修复回归本身。

### 4.4 成本/预算
- autopilot 预算拦截自动处理；人复核：单任务估费超 ~10× 正常、或今日 tokens 连续 3 天超标 → 检查任务 prompt 是否过度（如误含大文件读取/完整 test-all）。

### 4.5 重构触发与“不碰”原则
- 重构触发：patch 脚本 >3 处重复逻辑 / 单文件 >400 行 / 扩展职责重叠（如 cache-guard 与 pi-context 注入面）。
- **不碰**：系统健康（命中率 >95%、回归绿、无 open 工单）时不主动重构——稳定性优先，避免无谓风险。

### 4.6 回滚总则
- 改前 git 状态必须干净或已 commit；改动记 OPTIMIZATION-LOG。
- 测试红且 2 次修复失败 → git 回滚 + LOG 记 rolled-back。
- 涉及不可逆操作（删数据/全局配置/付费）先确认，不受此条自动回滚覆盖。

## 阶段 4（2026-08-26）：进化基建强化（愿景见 docs/VISION.md §4 度量体系）

| # | 项 | 产出/验收 | 状态 |
|---|---|---|---|
| 4.1 (P1) | 干预捕获扩展 | pi-intervention：abort 快照 + corrective prompt 关联 → memory/interventions.jsonl；/intervention recent\|stats | ✅ |
| 4.2 (P2) | 任务级遥测 | scripts/task-metrics.mjs：会话级成功率代理/干预次数/token 成本（只读） | ✅ |
| 4.3 (P3) | golden tasks 防退化基准 | scripts/golden-tasks.sh（--fast 确定性 / --full 无头 pi 会话） | ✅ |
| 4.4 (P4) | 记忆生命周期治理 | scripts/memory-lifecycle.mjs 只读报告（淘汰/升格/冲突候选）；规则入 VISION §5 | ✅ |
| 4.5 (观察) | pi-memory L0 分层注入 | 借鉴 OpenViking L0/L1/L2：条目写入时生成 ≤256 字符一句话摘要，注入层用 L0、memory_search 结果才给全文——同 500 token 注入预算装更多条目。触发条件：注入块接近预算上限或活跃条目 >800 时启动（2026-08-27 调研，当前 496/500 未触发） | ✅ 2026-08-29 落地：确定性 L0（条目 36token/上限 4→8），摘要 L2 保持 80token，零写入侧改动零迁移；触发条件满足（496/500 贴顶） |

## 5. 授权边界（用户 2026-08-20 放宽）

- **可自动执行**（无需每次确认）：
  - 注释/诊断文本/文档更新；低风险参数微调（阈值档内调整）；
  - 已由 test-all.sh 覆盖的扩展代码改动（改后必须跑回归，绿才收尾，红即修或回滚）；
  - 记忆库 GC（按 §4 规则，先只读统计再清理，清理前快照）。
- **必须确认后执行**：
  - 高危：删除数据（含记忆批量删除）、改全局 settings/models/auth、跨设备操作、服务停机；
  - 结构性改动：新扩展/新技能/新命令面、重建 patch 生命周期；
  - 涉及真金白银：provider 费用相关、外部 API 付费调用。
- **风险护栏**：任何自动改动前先 `git status` 确认工作区干净或已提交；改动落盘后记入 OPTIMIZATION-LOG；失败路径=回滚+记录。

## 6. 状态跟踪

- [x] 阶段 1.2（usage-stats 诊断文本）
- [x] 阶段 1.1/1.3/1.4/1.5（基线报告/GC 策略/日志模板/回归基线）
- [x] 阶段 2.1（每日自检 ✅ 实弹：08-20 08:30 命中 97.7%／断裂 0；下次 08-21 00:30）
- [x] 阶段 2.2（决策启发式成文 §4 v1：命中/膨胀/回归/成本/重构/回滚六规则）
- [x] 阶段 2.3（优化工单闭环流程入 memory 库 procedure；1 ticket=1 改动+验证）
- [x] 阶段 2.4（失败会话学习）——✅ 已落地 scripts/lesson-miner.mjs（只读扫描 usage-diag/tool-events → 候选教训线索，LLM 提炼后存 memory）
- [x] 阶段 2.5（工具/技能用量账单）——✅ 已落地 usage-stats.mjs 工具聚合 + pi-context tool_result hook 按工具累加
- [x] 阶段 2.6（压缩可逆快照）——✅ 已上线：auto-compact 触发前原文快照落盘 logs/compact-snapshots/（compact-snapshots 已有运行产物）
- [x] 阶段 3.3（通知推送骨架：pi-notify.sh + 模板配置 + 自检联动；渠道接入暂缓，未误发）
- [x] 阶段 3.1（文档解析：doc-extract.py 全格式可用，pdf/OCR 依赖已装已验）
- [x] 阶段 3.2（知识订阅：knowledge-fetch.py + 并入自检入库；08-20 已产当日文件）
- [x] 阶段 3.4/3.5（⏸ 暂缓：无稳定主机、无邮箱/Telegram 需求；用户定焦 = 优化 pi + 日常沟通）
- [x] §4 P1 缓存断链：✅ 已闭环——归因错误已回滚（无网关硬裁）；MISS=缓存 TTL 过期+跨会话边界；实弹 97.7% 达目标，剩余为规律运营成本

## 阶段 5（2026-08-29）：业界借鉴落地（GitHub 自进化 agent 项目调研驱动）

> 调研源：GitHub API 实测 26 仓（AHE/memU/OpenViking/Evolver/MemOS/DGM/Voyager/ExpeL/Reflexion 等），
> 机制细节与结论详见 memory reference 条目「GitHub 自进化 agent 项目调研结论」。区分两类信号源：
> benchmark 驱动（DGM/OpenEvolve）与真实使用驱动（Voyager/AHE/memU）——本阶段只吸收后者可迁移机制。

### 已执行（低垂果实，用户批准）

| # | 项 | 来源 | 落点 |
|---|---|---|---|
| 5.1 | 访问强化：检索命中回写 accessedAt（进程级去抖，fail-open）；修复剪枝语义漏洞（被检索使用不强化→活跃旧条目误剪） | MemoryBank | pi-memory storage.touchAccessedAt + tools.ts search/recall 双挂点 + 单测 |
| 5.2 | 干预→反思闭环：daily-review 新增步骤 3（近 7 天 corrective 记录提炼教训，confidence=0.6，回链记录 ts） | Reflexion | seeds + 本机 scheduled-tasks 同步（5 步版） |
| 5.3 | 守门防篡改：test-all/golden-tasks/daily-health/verify-patches 未提交改动 → alert（DGM 实锤 agent 会博弈评价器） | DGM 教训 | daily-health 新判据；改动即提交纪律下误报率≈0 |

### 中期设计（已分析，待实施）

- **5.4 summarizer patch-vs-create**（memU 六步管线第 3 步）：✅ 2026-08-29 落地——task-summarizer prompt 改为"先 ls+读同主题草稿 description；存在同主题→不新建，概述中列'建议 patch <文件名>：<差异要点>'待人工确认；确认无才新建"。防草稿碎片化。
- **5.5 ExpeL 归纳升级**：✅ 2026-08-29 落地（报告端）——memory-lifecycle 新增第 5 类"聚合候选"：solutions/procedure 标题 bigram-jaccard（阈值 0.34）贪心聚类，组内 ≥3 条且 Σrecurrence≥8 输出归纳建议；合成数据实测聚类正确。执行侧不走新 UPGRADE 写操作，由 daily-review 步骤 5 出规则草案→OPTIMIZATION-LOG→用户确认后走既有"确认→快照→执行"流程（对齐 VISION §5）。
- **5.6 importance 累计触发反思**（Generative Agents）：✅ 2026-08-29 落地——daily-review 步骤 2 内嵌确定性计算（近 24h 新条目 Σ(confidence×recurrence)），>12 触发跨条目归纳 insight（带引用条目标题）。确定性触发+LLM 反思，替代纯固定节奏。
- **5.7 自动课程**（Voyager）：✅ 2026-08-29 落地——daily-review 步骤 4：logs/lesson-course.json 状态文件比对，同主题连续第 2 天→生成 packs/drafts/workticket-<短名>.md 工单草稿（问题/建议改动/验证方式三节，仅草稿不执行），并更新状态文件。授权边界不变：结构性改动仍须用户确认。
- daily-review 随 5.4-5.7 整合为 6 步版，maxRunTime 600→900（步骤增多）。

### 远期分析（记录触发条件，暂不实施）

- **5.8 提示词元优化**（GEPA/DSPy/TextGrad）：metric 已备（task-metrics --json）；障碍 = 个人场景样本量小（噪声大）+ APPEND_SYSTEM.md 改动重置缓存前缀（成本敏感）。触发条件：interventions corrective 记录 ≥50 条（现 1 条）。
  **范围分层设计（2026-08-29 细化）**：
  - Tier 1（非缓存面提示词，零缓存成本，可先行）：pi-memory extract prompt、task-summarizer prompt、任务/回顾 prompt。metric：产物质量代理（extract 条目被 lifecycle 淘汰/合并的比例、summarizer 草稿采纳率、任务结果重做率）+ corrective 关联。样本门槛降至 ≥10 条可观察。
  - Tier 2（注入面：APPEND_SYSTEM.md/注入块）：维持原触发（corrective≥50 + golden --full 绿 + 命中率不降），缓存重置成本计入优化收益核算。
- **5.9 GEP 式经验表示固化**（arXiv:2604.15097 实证：文档式 skill 包控制信号不稳定，紧凑结构化表示最优）：
  - ✅ links 双向链接 2026-08-29 落地（预案内唯一 schema 增列，v6）：入库时标题 bigram-jaccard≥0.34 自动单链最优邻居（与 5.5 聚合同口径，links 连通分量即聚合候选图基础）；superseded 取代关系入链；检索结果显示关联数；零工具 schema 变化零注入面变化；单测覆盖建链/幂等/自环/ADD 分支
  - 读取侧消费（检索未命中回退邻居遍历）留观察后决定；LoRA 铺垫（VISION §6）数据面持续积累（P1/P2 结构化字段已就绪），等量变
  - schema 冻结维持：除 links 外不再增列，字段演进需重新评估

### 2026-08-31 追加记录（WikiSkill arXiv:2608.27454 借鉴，仅记录不实施）

- **点 5.10 原子提案纪律**（论文 §3.2.3：Skill Proposer 每轮只产一个原子提案/patch 单技能）：daily-review 每轮最多 1 个 workticket，取优先级最高者先做，避免一次改动过多无法归因。触发条件（暂不实施）：工单历史 ≥10 条可评估采纳率时再定稿；当前 lesson-course/workticket 机制刚落地，样本不足。
