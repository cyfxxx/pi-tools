# 自优化基线报告（SELF-OPTIMIZING-BASELINE）

> 采集：2026-08-20 | 更新：2026-08-26（扩展/技能数量回填） | 用途：后续所有优化改动以本基线为对照，凡影响指标必须复测回填。

## 1. 运行环境

| 项 | 值 |
|---|---|
| pi 版本 | 0.84.2 |
| provider / model | opencode-go / deepseek-v4-flash |
| thinking | max |
| 扩展 | 11（pi-context/pi-autopilot/pi-link/pi-memory/pi-voice/pi-browser/pi-web-search/pi-tmux/plan-mode/subagent/pi-intervention） |
| 技能 | 6（backup/code-review/full-audit/translate-zh/bug-diagnosis/repo-optimize；description 均含负例，长清单已外置 references/） |

### 今日新增能力（2026-08-20 晚，均已回归）

- **pi-context 内容路由**：工具输出三阶段（JSON 结构压缩 → 错误脱水 → 通用截断），写时确定性变换（+9 单测）
- **pi-memory bi-temporal**：v5 validUntil + memory_search asof 回溯查询（104 用例）
- **skills 规范化**：4 技能 description 负例 + version；正文 -100 行外置 references/

## 2. 缓存命中基线（scripts/usage-stats.mjs）

| 会话 | 轮数 | 命中率 | 断裂 | 浪费 token |
|---|---|---|---|---|
| 08-19 17:41 | 2 | 49.8% ⚠ | 0 | 0 |
| 08-19 19:07 | 13 | 61.7% ⚠ | 4 | 2.0M（压测会话） |
| 08-19 19:20 | 17 | 76.1% ⚠ | 3 | 1.55M（压测会话） |
| 08-19 21:33 | 2 | 90.2% | 0 | 0 |
| 08-19 21:46 | 33 | 91.7% | 2（A×1 C×1） | 108K（当前会话） |

- **目标 97%，实测实弹 97.7%（daily-health 08-20 实弹）已达标**；规律运营成本（长停顿后首轮无缓存）计入《路线图》§4 P1 已闭环。低命中率会话为缓存治理压测或跨会话边界。
- **A 类断裂主因（2026-08-20 实证）**：compaction 改写 / 早期消息改写（thinking 剪枝阈值 64K/120K/80K 已调）/ 大工具输出改写 / provider 缓存键。**记忆注入非主因**（尾部注入、确定性、≤500 token）。

## 3. 记忆库基线（memory_stats）

| 项 | 值 |
|---|---|
| 总条目 | 529（活跃 378）→ 软删挂起 151；schema v2 + v5 validUntil（bi-temporal 回溯） |
| 存储 | 0.25 MB / 2 MB（告警线 1.8MB，2026-08-20 放宽） |
| 会话摘要 | 21 |
| 被取代条目 | 25 |
| 冷数据（>30 天未访问） | 0（无需立即清理） |
| 注入块 | 496 token（4 条目 + 2 摘要），无写入时构建确定性 ✔ |

## 4. 回归基线（test-all.sh --fast）

- 结果：**全绿 ✔**（2026-08-20 06:1x）——10 套扩展 vitest 全部通过（pi-intervention 已入列）、tsc typecheck 通过；--fast 跳过 subagent/注册面/conflict-check/发现完整性。

## 5. 关键事实（供归因，勿误判）

1. 注入块位于消息尾部（user 之后），变化仅重发自身（≤500 token）。
2. 注入构建确定性：同库同输入同输出（已验证两次调用一致）。
3. usage-stats A 类断裂诊断已更正（2026-08-20），不再指向记忆操作。
4. 8-19 低命中率会话是压测，不代表稳态。

## 6. 复测命令

```bash
node scripts/usage-stats.mjs                    # 命中率/断裂
bash scripts/test-all.sh --fast                 # 回归门禁
# memory_stats 工具查看记忆库占用与冷数据
```
