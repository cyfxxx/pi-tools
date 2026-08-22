# comfyui-agent

把远程 ComfyUI（其他有 GPU 设备上的实例）变成 pi 的完整工具。本机无需 GPU，通过 ComfyUI 原生 HTTP API 直连操作。

## 为什么不是 MCP

pi 官方不内置 MCP host（README: "No MCP"）。本项目选择最直接的路线：**单文件 Python CLI（仅 stdlib）+ HTTP API**，零依赖、可调试、全流程可控。MCP 生态的项目（comfy-mcp、comfyui-mcp-server 等）作为参考吸收了设计精华，但协议不依赖它们。

## 吸收的精华（来自社区与官方项目）

| 来源 | 吸收点 |
|---|---|
| ComfyUI_Skills_OpenClaw | CLI 作为 agent 主接口；把复杂工作流收敛为少量参数（schema 思想） |
| comfyui-mcp-server (joenorton) | `PARAM_*` 占位符 → 本项目 `{{...}}` 占位符体系 |
| ComfyUI-Agent-Kit | 一个能力多 agent 适配的组织思路；内置工作流模板 |
| comfy-python-sdk | workflow 加载→注入参数→run→取输出的对象式流程（改写为 CLI 语义） |
| Comfy-Org/comfy-skills | skill 化交付：SKILL.md + 可执行的简化命令面 |

## 结构

```
comfyui-agent/
├── SKILL.md              # pi 集成入口（skill frontmatter + 完整用法）
├── bin/comfyui           # 入口脚本（→ python3 lib/comfyui.py）
├── lib/comfyui.py        # 单文件 CLI：stdlib only
├── workflows/            # 内置 API 模板（builtin:<文件名> 引用）：
│                         #   txt2img(SD) / flux2_klein_t2i|edit / flux2_kv_ref
│                         #   / zit_txt2img / z_anime_txt2img / ltx23_i2v(_noaudio)
├── references/API.md     # ComfyUI HTTP API 参考
├── references/WORKFLOWS.md # 实例实测工作流映射、提示词规范、模型目录速查
└── config.example.json   # 多实例配置示例
```

## 快速开始

```bash
bin/comfyui servers add default http://<GPU机IP>:8188
bin/comfyui status
bin/comfyui models unet        # 按 /models 目录直读模型（先看实例有什么模型）
bin/comfyui run builtin:flux2_klein_t2i -p '{"prompt":"a cat","width":512,"height":512}' -o ./out
```

> 本机（FLUX.2 klein/Z-Image/LTX-2.3 环境，无 SD checkpoint）的可用内置模板与提示词规范：见 `references/WORKFLOWS.md`；`builtin:txt2img` 仅适用 SD 系实例。

作为 pi skill：在 `~/.pi/agent/settings.json` 的 `skills` 数组加入 `"+../packs/comfyui-agent/SKILL.md"`，重启 pi 后生效，对话中自然触发。

## 安全

ComfyUI 无内置鉴权。远程实例不得直接暴露公网；推荐 tailscale、ssh 隧道或带 token 反代。连接配置位于 `~/.config/comfyui-agent/config.json`（git 忽略，不入库）。

## License
MIT（本包整合代码与文档）。ComfyUI 相关知识遵循其各自许可。