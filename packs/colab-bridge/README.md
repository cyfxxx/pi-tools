# colab-bridge

把 Google Colab（免费 GPU）变成 pi 的远程 Python/GPU 执行后端。pi 在本机生成代码，提交到 Colab 执行并取回结果；支持文件上传/下载；仅 stdlib、零第三方依赖。

```
colab-bridge/
├── colab/colab-bridge.ipynb   # Colab 专用 notebook：内嵌桥接服务 + 隧道 + 自检，上传即用
├── colab/colab_bridge.py      # 桥接服务源码（notebook 内嵌同一份；可单独部署）
├── bin/colab_exec             # pi 侧 CLI（python3，stdlib only）
└── README.md
```

## 使用流程（一次配置）

1. **Colab 侧**：打开 https://colab.research.google.com → 上传 `colab/colab-bridge.ipynb` → 运行时选 GPU（免费层 TF 配额动态）→ 依次跑完所有 cell。
   - 输出两样东西：`CLOUD_URL`（cloudflared 隧道，免账号）和 `TOKEN`
   - cloudflared 不通时用 notebook 里注释的 tailscale 方案（需 GitHub 登录一次，IP 固定更稳）
2. **pi 侧**：保存连接
   ```bash
   bin/colab_exec conf <CLOUD_URL> <TOKEN>     # 写入 ~/.config/colab-bridge/config.json
   bin/colab_exec status                        # 自检：GPU 型号/显存/Python 版本
   ```

## 命令面

| 命令 | 作用 |
|---|---|
| `colab_exec status` | GPU/健康自检 |
| `colab_exec run '代码'` / `-f 文件` / stdin | 提交 Python 到 Colab（可访问 GPU），返回 stdout/stderr/exit |
| `colab_exec sh '命令'` | 提交 bash（pip install、模型下载等） |
| `colab_exec up <本地> [远端路径]` | 上传文件 |
| `colab_exec down <远端> [本地]` | 下载文件（缺省输出到 stdout） |
| `colab_exec conf <url> <token>` | 保存连接配置 |

通用参数：`-b` 临时 URL、`--token`、`run/sh` 的 `-t` 超时（默认 120s）、`--cwd`、`--json`。退出码透传远端。

## Colab 免费层的现实约束

- 会话上限 12h、空闲 90 分钟断开；断连后**环境全部重置**，需重跑 notebook（模型/依赖需重装）
- GPU 配额动态，高峰期可能拿不到或排队；拿到多为 T4
- 隧道 URL 每次会话变化（cloudflared）或固定（tailscale）
- 适合"临时算一把"：训练小模型、跑实验、ComfyUI 出图、GPU 基准测试；不适合长期服务

## 安全

- 隧道是公网可达入口，**token 必须保管**（notebook 每次会话随机生成并打印）
- 桥接服务只接受带 X-Token 的请求（401 拒绝），但网络传输建议走 https（cloudflared 自带）
- 不要在 Colab 里放敏感凭据；执行代码等价于在远端机器上跑脚本

## 与 comfyui-agent 的关系

同一套思路的姊妹包：comfyui-agent 面向"远程 ComfyUI 出图"，colab-bridge 面向"远程任意代码+GPU"。两者可以叠加（在 Colab 里跑 ComfyUI，再用 comfyui-agent 连上去），但 ComfyUI 权重每次会话要重下，建议优先用 Drive 持久化。