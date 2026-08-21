# ComfyUI 原生 HTTP API 参考（v1）

本文档供 pi 在底层调试/自定义工作流时查阅。所有端点均由 ComfyUI 服务器自身提供，无需任何中间层。

服务默认端口 **8188**；远程实例需 `--listen 0.0.0.0` 启动（默认只监听 127.0.0.1）。

## 端点速览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/system_stats` | 版本、python、os、设备（显卡型号/显存） |
| GET | `/object_info` | 全部节点类型定义（含输入 schema、候选值如 ckpt_name 列表） |
| GET | `/object_info/<类型>` | 单个节点定义 |
| POST | `/prompt` | 提交 workflow API prompt；body `{"prompt":{...},"client_id":"..."}` → `{"prompt_id":"..."}` |
| GET | `/queue` | `{"queue_running":[...],"queue_pending":[...]}` |
| POST | `/queue` | body `{"clear":true}` 清空队列 |
| GET | `/history/<prompt_id>` | 任务结果：outputs 里含 images（filename/subfolder/type/width/height）、status |
| GET | `/history` | 全部历史 |
| POST | `/history/<prompt_id>` | body `{"delete":[id]}` 删除历史 |
| GET | `/view?filename=&subfolder=&type=` | 下载图像（type: output/temp/input） |
| POST | `/upload/image` | multipart 上传输入图，返回 `{"name","subfolder","type":"input"}` |
| GET | `/api/workflows` | 列出已保存工作流名（UI 格式） |
| GET | `/api/workflows/<名>` | 获取工作流 JSON（UI 格式：nodes/links） |
| PUT | `/api/workflows/<名>` | 保存工作流（body 为 UI 格式 JSON） |
| WS | `/ws?clientId=` | 实时进度事件（本集成未用，轮询 /history 替代） |

## prompt 提交格式（API Format）

```
POST /prompt
{
  "prompt": {
    "4":  {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "xxx.safetensors"}},
    "6":  {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["4", 1]}},
    "3":  {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 7.0,
          "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0,
          "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
          "latent_image": ["5", 0]}},
    "8":  {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9":  {"class_type": "SaveImage", "inputs": {"filename_prefix": "out", "images": ["8", 0]}}
  },
  "client_id": "任意随机串"
}
```

要点：
- 每个节点 = `节点id(string) → {class_type, inputs}`
- 输入连线 = `["上游节点id", 上游输出索引]`（索引按该输出的多态顺序，如 CheckpointLoaderSimple: 0=MODEL, 1=CLIP, 2=VAE）
- 节点 id 只要求唯一，与 UI 中编号无关
- UI 格式（nodes/links）与 API 格式不同：UI 导出用 "Save (API Format)" 得到 API 格式；`/api/workflows` 保存的是 UI 格式

## 提交后取结果（本集成策略：轮询）

1. `POST /prompt` → prompt_id
2. 轮询 `GET /history/<prompt_id>` 直到出现该 id：
   - `status.status_str == "error"` → 读取 `status.messages` 中 `execution_error` 事件（含 node_id、node_type、exception_type、exception_message）
   - 完成 → `outputs[节点id].images[]`，每个含 filename/subfolder/type/width/height
3. `GET /view?filename=...&subfolder=...&type=output` → 二进制下载到本地

## 常用节点（内置，无自定义节点依赖）

- `CheckpointLoaderSimple`（ckpt_name）、`CLIPTextEncode`（text/clip）、`EmptyLatentImage`（width/height/batch_size）
- `KSampler`（seed/steps/cfg/sampler_name/scheduler/denoise + model/positive/negative/latent_image）
- `VAEDecode` / `VAEEncode`、`SaveImage`（filename_prefix/images，写 output 目录）、`LoadImage`（image 输入图）
- `LoraLoader`（lora_name/strength_model/strength_clip）、`CLIPLoader`、`VAELoader`
- `UpscaleModelLoader` + `ImageUpscaleWithModel`、`LatentUpscale`

## 调试技巧

- `/object_info` 的 `input.required.<字段>` 若是 `["候选列表", {...}]` 形式，`[0]` 即合法值列表（模型名等）
- 节点不存在 → POST /prompt 返回 400 并指明原因；节点执行出错 → history 的 execution_error
- 队列拥挤判断：`/queue` 的 queue_pending 长度
- 网络隔离建议：ComfyUI 无内置鉴权。远程使用请用 tailscale、ssh -L 隧道或带 token 的反向代理