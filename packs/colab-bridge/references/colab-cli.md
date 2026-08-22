# colab-cli：官方 Google Colab CLI（推荐方案）

> 本文档由草稿 colab-cli.SKILL.md 合并而来（2026-08）。用官方 `google-colab-cli` 把免费 Colab（T4 GPU）当 pi 的远程执行后端，**替代自制桥成为首选**（自制 colab-bridge 保留为无 Google 网络时的备胎）。
> 依赖 Google 网络可达（VPN）。

## 安装（含版本坑）

```bash
pip install --break-system-packages -i https://pypi.org/simple google-colab-cli
```

- PEP668 环境必须 `--break-system-packages`
- 国内 pip 镜像在 VPN 下 TLS 中断，走官方源 `-i https://pypi.org/simple`
- **版本坑**：jupyter-kernel-client 1.0.1 把 `KernelClient` 改名为 `JupyterKernelClient`，CLI 0.6.0 报 AttributeError；必须降级：

  ```bash
  pip install --break-system-packages jupyter-kernel-client==0.15.0
  ```

- 网络前置：VPN 必需，需通 `accounts.google.com`、`colab.research.google.com` 与 sandbox 域名

## 首次认证

```bash
colab --auth=oauth2 sessions
```

默认 oauth2（内置 Google 官方 client id）：浏览器授权后把 code 粘贴回终端，token 缓存到 `~/.config/colab-cli/token.json`。

## 使用链路（已全量验证）

一次性跑脚本（自动释放资源）：

```bash
colab run --gpu T4 script.py
```

交互式开发：

```bash
colab new -s <会话名> --gpu T4     # 建会话
colab exec                          # stdin 传 Python 代码
colab exec -f file.py               # 或传文件
colab upload <本地> <远端>          # 传文件
colab download <远端> <本地>        # 取回
colab stop <会话名>                 # 结束
```

免费账号实测 T4 可用（Tesla T4 15360MiB）；免费层有会话时长/空闲限制，环境会重置。

## pi 集成注意

- tmux_run 后台跑 colab 命令时，命令尾部必须加 `; exec true`，否则 shell 不退出、pi 收不到完成通知
- Google 网络不可达时切自制桥备胎：`bin/colab_exec`（本包，HTTP 桥 + 隧道，见 README.md）