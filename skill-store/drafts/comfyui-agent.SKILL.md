---
name: comfyui-agent
description: 把远程 ComfyUI 作为 pi 工具的接入与使用流程：注册服务器、CLI 跑图、管理工作流，适配本机无 GPU + 远程 GPU 机的场景。
---

# comfyui-agent：把远程 ComfyUI 变成 pi 的工具

整合包位于 `~/.pi/packs/comfyui-agent`（git 仓库，随主仓库同步）。CLI 入口 `bin/comfyui`（python3 单文件，stdlib only，核心逻辑 `lib/comfyui.py`），直连 ComfyUI 原生 HTTP API（/prompt + /history 轮询 + /view），不需要额外服务端组件。

## 前置条件

- 远程 GPU 机已部署 ComfyUI 并以 `--listen 0.0.0.0` 启动；建议走 tailscale / ssh 隧道访问，避免裸暴露端口。
- 本机无 GPU 也可以（pi 只做 API 调用方）。

## 使用流程

1. 注册服务器：

   ```bash
   bin/comfyui servers add <别名> <http://远程机:8188> [token]
   bin/comfyui servers list
   ```

   配置保存在 `~/.config/comfyui-agent/config.json`，可用环境变量 `COMFYUI_AGENT_CONFIG` 覆盖路径。

2. 查看可用资源：

   ```bash
   bin/comfyui status          # 服务器健康/队列
   bin/comfyui models          # 可用模型（ckpt/lora/vae 等）
   bin/comfyui nodes           # 可用节点
   ```

3. 跑图（四种数据源，`--json` 输出供 pi 解析）：

   ```bash
   bin/comfyui run builtin:txt2img          # 内置文生图
   bin/comfyui run @远程UI导出的工作流.json   # 引用远程端保存的工作流
   bin/comfyui run <本地API格式json文件>
   echo '<api json>' | bin/comfyui run -    # 标准输入
   ```

   参数化占位符：`{{prompt}}` 必填文本、`{{int:steps=20}}` / `{{float:cfg}}` 数值参数（带默认值可选）、`{{seed:seed}}`（缺省随机）、`{{ckpt=默认.safetensors}}` 模型选择。必填占位符缺失会报错提示。

4. 队列与产物：

   ```bash
   bin/comfyui queue           # 查看队列
   bin/comfyui upload <本地文件> <远程路径>   # 上传素材/模型
   bin/comfyui workflows list|get|save       # 管理工作流
   ```

## 与 pi 的集成约定

- 不注册进 settings.json skills 数组（防止提示词膨胀、零注入）。需要时手动加载：

  ```bash
  pi --skill /root/.pi/packs/comfyui-agent/SKILL.md
  ```

  或直接 read SKILL.md 按指令执行（命令输出统一 `--json`，便于 pi 解析）。
- 回归验证：`/tmp/mock_comfyui.py` 提供 mock 服务器，可跑 mock 端到端测试。