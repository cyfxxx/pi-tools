# novel-writing — 长篇网文工程化写作技能

面向多卷长篇中文小说（网文）创作的工程化写作系统。核心分工：**执笔者（用户）负责创意、世界观、文风**；本技能负责**跨章节一致性、伏笔回收、节奏与文风稳定**，把"写到几十上百章还没写崩"从靠记忆变成可检查的纪律。

## 定位

- 不是"万能写作提示词"，而是一套可复现的长篇创作协议：规划 → 目录 → 草案 → 正文 → 体检 → 存档 的闭环流程
- 分两层：**创作层**（rules/protocols/craft 负责怎么写好）与**工程层**（engineering 负责记得住、查得着、改得动）
- 对平台无依赖：不绑定任何编辑器/客户端，核心是 Markdown 项目 + 纯 Python 校验脚本

## 用法

1. 建立小说项目工作区（`templates/` 起手 + `engineering.md` 的目录布局）
2. 让用户填充五件知识库：世界基石 / 世界观规则 / 角色档案 / 档案事件 / 文风样本
3. 按 `protocols.md` 的指令流程推进：大纲 → 规划/目录 → 草案 → 正文 → 体检 → 存档
4. 关键关卡读 `rules.md`（一致性/叙事/输出）与 `craft.md`（文风/技法）
5. 长文重点读 `engineering.md`（50 章分批、事实锁、状态回证、伏笔追踪、双重审查）

## 来源与许可

本包为三个公开 GitHub 技能包的分析、优化与整合，整合版采用 **CC BY-NC-SA 4.0**（取三者中最严格的许可），已在引入处标注：

| 来源 | 许可 | 贡献部分 |
|---|---|---|
| [zy-zmc/tianming-skill](https://github.com/zy-zmc/tianming-skill)（134★） | CC BY-NC-SA 4.0 | 分层架构；六大协议；一致性法典；文风溯源/戒律/渲染/去AI指纹；知识库装配契约；冲突值量化 |
| [xiaofeng-928/chinese-longnovel-skill](https://github.com/xiaofeng-928/chinese-longnovel-skill)（70★） | MIT | 50 章分阶段规划；上下文组装与事实锁；状态回证模型；伏笔追踪回收；双重审查+哈希绑定；工程化校验思路 |
| [ExplosiveCoderflome/ani-book-skill](https://github.com/ExplosiveCoderflome/ani-book-skill)（53★） | Apache-2.0 | 连续性账本（fact/payoff/resource）；去 AI 味二稿方法；质量债与恢复工作流 |

## 整合时的优化

与上游原稿相比，本整合版做了以下处理：

- **平台适配**：移除 Anthropic/Codex 专属字段（`allowed-tools`、`CODEX_HOME`、`sync_skill_mirror`）、PowerShell 脚本、软件版题材 JSON、作者个人蒸馏文件；这是 pi 技能格式（frontmatter 仅 name/description，缓存友好无时间戳）
- **引用体系简化**：上游的 `[REF:xxx]`/`[KERNEL_REF:xxx]`/`[VAR:xxx]` 全局 ID 索引，改为按文件名直接引用的扁平形式
- **命名平实化**：去掉"天命/Ω级/内殿铸魂/神谕/法典/铁律"等修辞化命名，保留同一执行语义
- **创作参数可配置**：上游写死的网文向常数（字数 3500-4000、缓冲比 37%、奇点配额 3 等）收敛为 `rules.md` 末尾"可调参数"表，标注为默认值而非铁律
- **补强**：新增 `engineering.md`（50 章分批/事实锁/状态回证/双重审查/连续性账本）与 `templates/`（知识库与伏笔台账模板），并写了本 README（上游只讲初始化，没讲怎么建库、怎么迁移现有小说）
- **脚本独立**：`scripts/count_chars.py` 重写为无外部依赖的单文件（上游依赖仓库内 `公共工具.py`）

## 目录结构

```
novel-writing/
├── README.md          # 本说明（来源/许可/整合说明/用法）
├── SKILL.md           # 技能入口：触发条件 + 指令路由 + 知识库装配契约 + 五步闭环
├── rules.md           # 一致性条例 + 叙事结构 + 输出纪律 + 冲突值量化 + 可调参数
├── protocols.md       # 六大运行协议：大纲/规划目录/草案/正文/体检/存档
├── craft.md           # 文风溯源 + 写作戒律 + 渲染技法 + 去 AI 指纹
├── engineering.md     # 工程机制：50章分批/上下文组装/事实锁/状态回证/伏笔追踪/双重审查/连续性账本
├── templates/         # 知识库模板（世界基石/世界观规则/角色档案/档案事件/文风样本/伏笔台账）
└── scripts/
    └── count_chars.py # 审查字数统计（省略号加权口径，无依赖）
```
