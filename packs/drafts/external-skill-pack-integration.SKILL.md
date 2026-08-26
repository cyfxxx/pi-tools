---
name: external-skill-pack-integration
description: 从 GitHub 调研收集外部技能包，做许可核对、平台适配、结构优化后整合为 pi 格式技能包放入 packs/。用户说"找技能包""整合开源技能""收纳技能"时触发。
---

# 外部技能包整合（packs）

把 GitHub 上分散的开源技能包（prompt/skill 仓库）收集、分析、优化、整合为可复用的本地技能包。已验证实例：`packs/novel-writing`（整合 3 仓库）、`packs/mattpocock-skills`（收纳 8 技能）。

## 适用与不适用

- 适用：用户要求"去 GitHub 找某类技能包并整合到 packs"
- 不适用：仅临时参考单个技能（直接读即可）；已有同类型包时的增量更新（走合并优化，不另立新包）

## 步骤

### 1. 调研选源（web_search + GitHub）

1. 用 GitHub 搜索 + web_search 找候选仓库，关键词带技能领域（如 novel-writing skill、prompts 等）
2. 筛选条件：star 数、最近更新、许可声明、README 完整度
3. 选 2-3 个**互补**的仓库（架构、工具链、写作方法论各有所长），避免同质源
4. 逐个 clone 或 fetch 到 /tmp 审阅，记录各自的结构与独有贡献点

### 2. 许可核对（先于一切改写）

1. 每个源确认许可（LICENSE 文件 / README 声明）
2. 取**最严格**的许可作为整合版许可（如三源中 CC BY-NC-SA 4.0 最严，则全包用该许可）
3. 在包内 README 附"来源-许可-贡献"对照表，引入处标注出处

### 3. 平台适配（pi 格式）

1. 删除 Anthropic/Codex 专属字段（allowed-tools、CODEX_HOME、sync_skill_mirror）、PowerShell 脚本、作者个人蒸馏/偏好文件
2. frontmatter 仅保留 name/description（缓存友好，无时间戳，1-2 句）
3. 引用体系简化：上游 `[REF:xxx]`/`[KERNEL_REF:xxx]` 全局 ID 索引 → 按文件名直接引用的扁平形式

### 4. 优化整合

1. 命名平实化：去掉"天命/法典/铁律/神谕"等修辞化命名，保留同一执行语义
2. 参数可配置：上游写死的常数（字数/缓冲比/配额等）收敛为"可调参数"表，标注默认值而非铁律
3. 补强工程层：上游往往只讲初始化不讲长期使用——新增 engineering.md（分批/事实锁/状态回证/追踪）、templates/、README（怎么建库、怎么迁移现有项目）
4. 脚本独立：依赖仓库内共享模块的脚本重写为无外部依赖单文件

### 5. 产物结构预算（借鉴 virgiliojr94/book-to-skill）

自建或整合的技能包按渐进披露组织，入口轻、细节按需加载：

| 文件 | 角色 | 预算 |
|---|---|---|
| `SKILL.md` | 核心心智模型 + 索引/路由 | ≤4K token，超限拆分 |
| 章节文件/子文档 | 单主题详情，被索引引用按需读 | ≤1K token/文件 |
| 决策表/速查表 | 「何时用哪个」独立成文件（cheatsheet），不混入叙述正文 | ≤1K token |

判断标准：若一个技能常被「只想查其中一小块」地使用 → 必须拆分；整包只有入口文件且超预算 → 先拆再收。

### 6. 蒸馏质量门（借鉴 cangjie-skill 三重验证+压力测试）

会话产出→SKILL 草稿→packs 升格通道的准入标准，正面应对「空壳投喂无草稿产出」——症结是缺准入而非缺内容：

- **三重验证**（全部通过才立包/立草稿）：
  - V1 跨域佐证：方法论在 ≥2 个独立场景被验证过（不同任务/不同项目，非同一案例换说法）
  - V2 预测力：能答出一个源场景没直接覆盖的新问题且结论非平庸
  - V3 非常识：抹掉来源后不是任何有经验者都脱口而出的常识
- **压力测试**：立包前设计诱饵题（看似相关实不适用）与同域混淆题（相邻技能边界）；答错回炉重构而非放行
- **数量预期**：通过率低是特性不是缺陷（上游实测 25-50%）；未过验证的降级为 references 素材/金句，不硬凑成包
- 完整管线见 `packs/cangjie-skill/methodology/`（七阶段），冒烟实测见其 SMOKE-NOTES.md

### 7. 落位与登记

1. 产物放 `/root/.pi/packs/<name>/`（SKILL.md 入口 + bin/lib/references/templates 等）
2. `packs/README.md` 表格登记（包名/用途一行）
3. 入库 git（packs 随 pi-backup 同步，不依赖本机单独备份）

## 产出

- packs/<name>/ 完整技能包 + README 登记
- 若为草稿阶段：写 `packs/drafts/<短名>.SKILL.md`（name/description frontmatter + 步骤正文），待人工确认后建包
