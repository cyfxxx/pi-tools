# packs：统一外部技能仓库

把"成功实现、可复现、有保存价值"的长任务沉淀为可复用技能包。**packs 是唯一的外部技能仓库**（2026-08 起并入原 skill-store）。

## 目录结构

```
packs/
├── drafts/     # 草稿（scripts/task-summarizer.mjs 自动生成，待人工确认）
├── <name>/     # 已确认技能包：SKILL.md 入口 + bin/lib/references/workflows 等资源
└── README.md   # 本说明
```

约定：
- **不再有 active/ 中间态**：草稿确认后直接在 `packs/` 下建 `<name>/` 包（含 SKILL.md）；未确认的留在 `drafts/`
- **同类型合并**：确认草稿时若 packs 已有同类型技能 → 合并/优化进现有包，不另立新包（例：colab-cli 草稿并入 colab-bridge；comfyui-agent 旧稿并入 comfyui-agent 包），合并后删草稿
- drafts 草稿文件名 `<短名>.SKILL.md`，YAML frontmatter：name/description（1-2 句、不带时间戳，缓存友好）

## 流程

1. **生成**：`scripts/task-summarizer.mjs` 批量总结任务，识别"成功实现+可复现+有保存价值"的长任务 → 写 SKILL.md 草稿到 `packs/drafts/`
2. **确认**：人工审阅草稿（name/description/步骤准确、可复现、无时间戳），确认后在 `packs/` 建包；不合格删除
3. **激活**：packs 不入 `agent/skills/`（防系统提示词膨胀），需要时按需启用（/skill 或手动引用 SKILL.md）
4. **清理**：长期未激活的包定期归档删除

## 经验沉淀机制（自我优化，必做）

每个包执行完任务后必须总结经验（对齐 agent/skills 的"使用后改进"范式）：

1. **收尾清点**：执行过程与 SKILL.md 步骤/路径/结论的偏差（工具坑、新发现、流程缺陷、输出约束不足）——正反面皆记，证据导向（命令、路径、现象）
2. **落点**：追加到包根 `EXPERIENCE.md`（无则建，模板含日期/技能名/环境）。格式：
   ```
   ## YYYY-MM-DD <子技能/模块>
   - 环境: <termux-ubuntu proot aarch64 等，必须标注，防跨设备误会>
   - 场景/经验: ...
   ```
3. **合并**：未合并条目 ≥3 条或用户要求时，合并进 SKILL.md 正文（只改相关章节，不重写全文）并清 EXPERIENCE.md 对应条目
4. **跨包复用**：有跨包通用价值的工具坑（网络通道、依赖安装、API 变化）同时 `memory_store`（带环境标签）
5. **技能缺陷**：流程本身暴露的问题（命令失效/字段过时/章节不合理）直接改 SKILL.md 对应章节，不只写经验文件

各包 SKILL.md 末尾应有"使用后经验沉淀"引导段（pdf-toolkit/gamedev 已落地为范本）；存量包下次使用时先补段再执行。

## 更新与整合原则（整合优先，禁止直接覆盖）

对 packs 技能做远程拉取更新或整合相似技能时：

1. **远程更新拉取**（如 gamedev 重拉上游）：
   - 禁止整目录直接覆盖（会丢失本地沉淀与优化，本地是超集）
   - 流程：拉取到临时目录 → `diff -r` 对照本地 → 本地未改动的目录/文件增量合入，本地改过的（含经验文件、环境备注、定制段落）以本地为准手工合并 → 上游新增目录增量收编
   - 合并前先读本地 EXPERIENCE.md 与 git log，确认哪些是本地定制
2. **整合相似技能**：新技能与已有包/技能重叠 → 合并进现有包（例：colab-cli 并入 colab-bridge），双方经验条目都保留并去重；不另立新包
3. **收编外部技能**：优先提炼通用能力 + 专用能力分类 + 繁重能力记录（见 pdf-toolkit 三层结构），不整树复制；来源与授权记录在包 README
4. 更新后立即把本次整合经验追加到 EXPERIENCE.md（本条也适用）

### 外部技能引入完整流程（2026-08-27 吸收 drafts/external-skill-pack-integration + skill-pack-adoption）

**A. 多源整合模式**（用户说"找技能包/整合开源技能/收纳技能"时）：

1. **调研选源**：GitHub 搜索 + web_search，关键词带技能领域；筛选条件 star/近期更新/许可声明/README 完整度；选 2-3 个**互补**源（架构、工具链、方法论各有所长），避免同质源；逐个 fetch 到 /tmp 审阅，记录各自结构与独有贡献点
2. **许可核对（先于一切改写）**：每个源确认 LICENSE；取最严格许可作为整合版许可（例：三源中 CC BY-NC-SA 4.0 最严则全包用该许可）；包内 README 附"来源-许可-贡献"对照表，引入处标注出处
3. **平台适配（pi 格式）**：统一 frontmatter（name/description）、路径结构、命令面；去重相似能力；保留各自方法论精髓
4. **实测验证**：最小用例跑通全链路，记录坑

**B. 单包验收模式**（从 GitHub 拿到现成技能包 zip/release 时）：

1. **选包与下载**：优先有正式 release tag、近期提交、issue 有回应的仓库；下载 zip 到本地，不直接执行来源不明安装脚本
2. **解压审查（安装前必做）**：SKILL.md frontmatter 合法；脚本无危险操作（递归删除/数据外传/混淆）；依赖清单可审计；审查不合格直接丢弃
3. **安装**：包体放 `packs/<name>/` 保持原结构；外部 CLI 依赖单独安装，以 `<cli> --version` 出版本号为就绪判据
4. **对照官方文档核验命令面**：逐一核对封装子命令与官方当前版本一致（版本漂移常见）；完成平台侧前置条件（例：微信开发者工具需先开启「服务端口」）
5. **冒烟测试**：建最小示例工程，只跑 1-2 条核心命令验证完整链路，通过后删临时工程
6. **归档**：写使用总结，更新 packs/README.md，git 提交推送（remote 含 token 时先恢复无凭证 URL）

两种模式收尾都必须：验证结果/坑追加到包 EXPERIENCE.md；远程源更新重拉时回到第 1 条"禁止整目录覆盖"流程。

## 防膨胀守则

- 草稿进 drafts 前由脚本标注"建议"，未确认不建包
- description 控制 1-2 句、不含时间戳（缓存友好）
- 同时激活的外部技能保持少量（≤3），其余按需临时启用

## 当前包

| 包 | 用途 |
|---|---|
| `comfyui-agent/` | ComfyUI 出图/工作流管理（CLI `bin/comfyui`，9 个内置 API 模板，`references/WORKFLOWS.md` 实例实测文档） |
| `colab-bridge/` | Colab（免费 GPU）远程执行：自研桥 `bin/colab_exec`（备胎）+ 官方 google-colab-cli 方案（首选，`references/colab-cli.md`） |
| `gamedev/` | 游戏开发技能组（skills/design、web、workflow） |
| `reverse-skill/` | 逆向/CTF 技能包（含 burp-mcp 等） |
| `dg-piagent/` | pi-agent SDK 开发助手（教程同步维护，API 基线 v0.83.0，含 sdk_doc/场景 references） |
| `wechatide-skill/` | 微信开发者工具 agent 技能包（skillhub v0.3.9，外部收纳）：通过官方 `wechatide` CLI 驱动 IDE——安装/编译/预览/上传/自动化调试/云开发。9 个 scene 子技能 + tools.yaml 注册表；CLI 需 Windows/macOS 侧运行（WSL 走 interop，本地实测笔记见包内 LOCAL-NOTES.md） |
| `novel-writing/` | 长篇网文工程化写作系统：六大协议（大纲/规划目录/草案/正文/体检/存档）+ 一致性/叙事/输出条例 + 文风溯源/去AI指纹 + 50章分批/事实锁/状态回证/伏笔追踪/双重审查。整合 tianming-skill 等 3 个开源仓库并优化（CC BY-NC-SA 4.0，来源见包内 README） |
| `embedded-dev/` | 嵌入式/MCU 开发 AI 技能入口：构建/烧录/调试/串口/协议领域路由 + 开源工具链命令速查 + 执行闭环（证据驱动）。整合 embeddedskills(MIT) 与 embed-ai-tool(无LICENSE仅引用) 的通用能力；专用工具（llm-pid-tuner/garycli/on-MCU agent 等）记录在 references/specialized-tools.md |
| `pcb-design/` | PCB/硬件设计 AI 技能入口：KiCad 工具链路由 + 设计审查契约（最小清单/证据分级）+ ERC/DRC/Gerber/SPICE/EMC 命令速查。提炼 kicad-happy(MIT)/skidl-skills(MIT)/hardware-agency-agents(MIT)；MCP server 与 ML 布局记录在 references/specialized-tools.md |
| `cangjie-skill/` | 长内容蒸馏元技能（外部收纳 kangarooking/cangjie-skill @5f03a4c，MIT）：RIA-TV++ 七阶段管线把书/长视频转写/播客蒸馏成原子化可执行 skills——Adler 整书分析→5 提取器并行→三重验证（通过率 25-50%）→RIA++ 六维构造→Zettelkasten 关联→压力测试（诱饵题+混淆题）→交付；原文不动，pi 适配与验收规范见包内 README |
| `pdf-toolkit/` | PDF 处理：通用能力 CLI `bin/pdf_core`（提取/合并/拆分/旋转/加密/水印/渲染/报告）+ 表单填写与扫描件 OCR 子技能；去水印/签名/压缩/Stirling/MinerU 等繁重能力记录在 references/specialized-tools.md。整合 anthropics/pdf skill 技术栈 |
| `media-toolkit/` | 图片/视频/游戏美术处理：通用 CLI `bin/media_core`（图片：转换/压缩/水印/批量；视频：转码/剪辑/拼接/抽帧/音频/GIF/字幕；游戏：精灵表拆分/图集打包/资产优化）+ 三个子技能（image-basics/video-basics/game-art）；TexturePacker/GIMP/whisper 等繁重能力记录在 references/specialized-tools.md。全部本地执行（ImageMagick+ffmpeg+Pillow） |
| `knowledge-fetch/` | 零 LLM 知识订阅搭建（渠道调研/抓取脚本/去重过滤容错/定时任务接入）。已验证实例 `/root/.pi/scripts/knowledge-fetch.py` v2（5 section，接入 daily-health-check）。来源：drafts/knowledge-fetch-setup（2026-08-27 升格） |

## 与 pi-backup 的关系

packs 入库 Git（/root/.pi 仓库），随 pi-backup 同步，不依赖本机单独备份。