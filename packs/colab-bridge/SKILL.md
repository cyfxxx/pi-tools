---
name: colab-bridge
description: 把 Google Colab（免费 GPU）作为 pi 的远程 Python/GPU 执行后端。用法：colab_exec status/run/sh/up/down。触发词：Colab、谷歌云笔记本、远程 GPU 执行、在 Colab 里跑代码。
---

# Colab Bridge（远程 GPU 执行）

两种方案：
1. **首选**：官方 `google-colab-cli`（0.6.0，需 Google 网络可达）——安装/认证/用法与踩坑见 `references/colab-cli.md`
2. **备胎**：本包自制桥 `bin/colab_exec`（HTTP 桥+隧道，Google 网络不可达时使用），本文档主体即此方案

自制桥：本包让 pi 把代码提交到 Google Colab 执行并取结果：`<skill目录>/bin/colab_exec`。

- 连接配置：`colab_exec conf <url> <token>`（首次）
- 自检：`colab_exec status`
- 提交 Python：`colab_exec run '<代码>'` 或 `-f 文件`、`--cwd`、`-t` 超时、`--json`
- 提交 bash：`colab_exec sh '<命令>'`
- 文件：`colab_exec up <本地> [远端]` / `colab_exec down <远端> [本地]`

Colab 侧需先在 colab.research.google.com 上传运行 `colab/colab-bridge.ipynb`（内嵌服务+隧道，打印 CLOUD_URL 与 TOKEN）。断连后环境重置，需重跑 notebook。

详见 README.md 与 colab/colab-bridge.ipynb 内的说明。

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（无则建；工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件正文并清条目。
