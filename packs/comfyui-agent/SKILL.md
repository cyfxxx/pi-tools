---
name: comfyui-agent
description: 让 pi 把远程 ComfyUI（其他有 GPU 的设备上运行的实例）当作图像生成工具使用。提供完整操控：连接配置（servers add/status）、提交并等待工作流（run）、参数化占位符（{{prompt}}/{{int:steps}}/{{seed:seed}}）、自动下载输出图、列出模型/节点/队列、上传输入图（img2img）、远程工作流获取与保存。无 GPU 本机通过 HTTP API 直连远程 ComfyUI，无需 MCP、无需第三方 Python 依赖。触发词：出图、生图、跑工作流、ComfyUI、文生图、图生图、图像生成。
---

# ComfyUI Agent（远程 ComfyUI 操控）

通过本 skill 把远程 ComfyUI 实例变成 pi 的工具：**提交工作流 → 参数化 → 等结果 → 把图下载到本地**。

> **命令路径**：文中的 `comfyui ...` 实际执行路径是**本 skill 目录下的 `bin/comfyui`**（与 SKILL.md 同级）。
> 执行方式：`cd <skill目录> && bin/comfyui ...` 或直接用绝对路径 `<skill目录>/bin/comfyui ...`。
> 建议首次配置时在 `~/.bashrc`/`~/.zshrc` 加 alias：`alias comfyui='<skill目录>/bin/comfyui'`。

## 0. 首次配置（一次性）

1. 远程 GPU 机启动 ComfyUI：`python main.py --listen 0.0.0.0`（建议用 tailscale/ssh 隧道，勿直连公网）
2. 登记实例：

```bash
comfyui servers list                      # 查看已登记
comfyui servers add default http://<远程机IP>:8188
comfyui status                            # 自检：版本/显卡/队列
```

3. 常见故障：
   - `连接失败` → 检查远程机是否 `--listen 0.0.0.0`、防火墙、地址端口
   - `/view` 404 → 确认图确实生成（见 run 输出）
   - 模型缺失 → `comfyui models checkpoints` 看远程有哪些模型，`run` 时用 `--params` 指定实际存在的 ckpt

## 1. 命令一览

| 命令 | 作用 |
|---|---|
| `comfyui status [-s 名称]` | 实例状态：版本、显卡、队列长度 |
| `comfyui nodes [节点类型]` | 节点目录（object_info），查自定义节点接口 |
| `comfyui models <checkpoints\|loras\|vaes\|clips\|samplers\|schedulers\|upscale>` | 列出远程可用模型/采样器 |
| `comfyui run <源> [-p 参数] [-o 输出目录]` | 提交工作流并等待完成、下载输出（核心） |
| `comfyui queue list / clear` | 队列状态 / 清空 |
| `comfyui upload <本地图>` | 上传输入图（img2img 等用），返回 subfolder/type |
| `comfyui workflows list / get <名> / save <名> --file <json>` | 管理远程已保存工作流 |
| `comfyui servers add <名> <base_url> / rm / list` | 多设备管理 |

所有命令带 `-s <server名>` 选设备、`-b <base_url>` 临时指定地址、`--json` 输出 JSON。

## 2. 工作流源（run 的 src）

| 形式 | 示例 | 说明 |
|---|---|---|
| 内置模板 | `builtin:txt2img` | 通用文生图（SD/SDXL 均可），占位符参数化 |
| 本地 API 文件 | `./my_workflow.json` | ComfyUI 里导出 "Save (API Format)" 的 JSON |
| 远程已保存 | `@我的工作流` | 从远程拉取 UI 格式并尽力转换（链接+widget 可转，复杂图建议导出 API 格式） |
| stdin | `-` | 管道传入 API prompt JSON |

## 3. 参数化（精华机制）

在 workflow JSON 的**字符串值**中写占位符，run 时以 `-p '{"键":值}'` 注入：

| 占位符 | 类型 | 说明 |
|---|---|---|
| `{{prompt}}` | str | 必填 |
| `{{negative=默认值}}` | str | 带默认值 |
| `{{int:steps=20}}` `{{float:cfg=7.0}}` `{{bool:flag}}` | 类型化 | 自动转换类型 |
| `{{seed:seed}}` | int | 不传则随机 |
| `{{ckpt=模型名.safetensors}}` | str | 模型名（先用 `models checkpoints` 确认存在） |

未提供的必填参数会直接报错提示；找不到默认模型时逐字段排查。

**固定业务工作流**：把常用图存成本地 API JSON（用占位符替换要变的字段），以后 `comfyui run <文件> -p '{"prompt":"...","ckpt":"xxx.safetensors"}'` 即可复用。

## 4. 标准出图流程

```bash
# 1) 确认模型可用
comfyui models checkpoints

# 2) 跑一个内置文生图
comfyui run builtin:txt2img \
  -p '{"prompt":"a cat wearing sunglasses, studio lighting","steps":25,"seed":42}' \
  -o ./comfyui_outputs

# 3) 输出：状态、耗时、每张图路径；pi 用 read 查看图片向用户展示
```

img2img：`comfyui upload xxx.png` → 得到 `subfolder/type` → 写 workflow 引用 `{"class_type":"LoadImage","inputs":{"image":"<上传返回的name>"}}`（或本地模板放入该节点）→ run。

## 5. 排错速查

- 提交报 HTTP 400 → 检查 workflow 节点 class_type 是否存在（`comfyui nodes`），inputs 是否齐全
- 运行 error（status: error）→ CLI 会输出具体节点异常（缺模型/显存不足/节点报错）
- 长时间没完成 → `queue list` 看是否有其他任务堆积；显存不足会排队
- 连接不稳 → CLI 轮询最多重试 6 次后报错

## 6. 安全须知

- 远程实例务必加访问控制：tailscale（推荐）、ssh -L 隧道、或 nginx 反代加 token
- 不要把远程地址写进公共配置；`config.json` 放用户目录、不入 git
- workflow 是代码：只运行你自己/可信来源的工作流

## 7. 参考文档

- [references/API.md](references/API.md)：ComfyUI 原生 HTTP API 端点详解（底层调试用）
- README.md：架构与设计取舍