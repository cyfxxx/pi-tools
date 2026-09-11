# packs 技能索引

> ## 如何使用
>
> 1. 若用户需求不被内置 6 个技能覆盖，先查本索引找到匹配技能。
> 2. 命中后对应读取 `packs/<name>/SKILL.md` 了解完整步骤。
> 3. 如涉及子技能（图片/视频/pdf 处理、微信开发、逆向模块），再读二级索引对应章节。
>
> ## 包索引
>
> | 技能 | 触发词 | 用途 |
> |------|--------|------|
> | `cangjie-skill` | 拆书、蒸馏、做 skill、书籍蒸馏、内容提取、知识沉淀 | 把书籍/视频/播客蒸馏为可执行技能 |
> | `colab-bridge` | Colab、远程 GPU、远程 Python 执行 | Google Colab 作为远程 Python/GPU 后端 |
> | `comfyui-agent` | 出图、生图、ComfyUI、文生图、图生图、跑工作流、AI 绘画 | 远程 ComfyUI 图像生成 |
> | `dg-piagent` | 创建 agent、自定义工具、编写扩展、修改系统提示词、管理会话、配置模型 | pi-agent SDK 开发指南 |
> | `embedded-dev` | 嵌入式、MCU、固件、硬件调试 | 嵌入式开发辅助（构建/烧录/调试） |
> | `gamedev` | 游戏开发、游戏制作、Phaser、Godot | 游戏开发工具链 |
> | `knowledge-fetch` | 新闻、订阅、信息渠道、知识订阅、抓取信息、RSS 抓取 | 知识订阅系统搭建 |
> | `media-toolkit` | 图片、视频、美术、图片处理、视频剪辑、游戏美术 | 图片/视频/游戏美术处理 |
> | `novel-writing` | 写小说、网文、长篇写作、小说大纲 | 长篇小说工程化写作 |
> | `pcb-design` | PCB、原理图、硬件、电路板审查、KiCad | PCB/硬件设计辅助 |
> | `pdf-toolkit` | PDF、pdf、文档提取、合并、加密 | PDF 全场景处理 |
> | `repo-size-audit` | 仓库体积、git 体积、git gc、git 仓库审计 | git 仓库体积审计 |
> | `skill-integration` | 技能包、整合、外部技能、GitHub 技能包 | 外部技能包整合流程 |
> | `wechatide-skill` | 微信、IDE、微信开发、小程序 | 微信相关开发辅助 |
>
> ## 二级功能索引
>
> | 技能 | 子技能 / 入口 | 用途 |
> |------|---------|------|
> | `media-toolkit` | `skills/image-basics`：通用图片处理（缩放/裁剪/转换/压缩/水印/批量/PDF→图）→ `skills/video-basics`：通用视频处理（转码/剪辑/拼接/抽帧/音频/GIF/字幕） | 图片/视频/游戏美术处理 |
> | `pdf-toolkit` | `pdf_core`：提取文本/表格/图片/元数据；合并/拆分/旋转/加密/解密；加水印；`skills/pdf-forms`：PDF 表单填写；`skills/pdf-ocr`：扫描件 OCR | PDF 全场景处理 |
>
> _注：二级索引列出核心子技能路径，完整列表请读对应 `SKILL.md` 文件。_
