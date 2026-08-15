# 多环境使用指南（Termux / WSL2 / Linux / macOS）

pi-tools 仓库通过 GitHub 在多台设备/多个环境间同步。不同环境（Termux/Android、WSL2、Linux 桌面、macOS）的配置、记忆、使用经验存在差异，本指南说明如何识别环境、避免配置与记忆冲突。

## 环境识别

| 环境 | 检测方法 | 特征 |
|------|----------|------|
| Termux/Android | `/storage/emulated/0` 存在 | `uname -a` 含 `PRoot`；`pkg` 包管理器 |
| WSL2 | `/proc/version` 含 `microsoft` | `/mnt/c/` 挂载；WSLg 显示 |
| Linux | 其余 | apt/dnf/pacman 等 |
| macOS | `uname` = Darwin | `brew`；`xclip` 需改 `pbcopy` |

pi-memory 扩展自动检测环境（`PI_MEMORY_ENV` 环境变量可显式覆盖），无需手动设置。

## 记忆环境标签（P0 已实施）

记忆条目带 `environments` 字段（`all`/`termux`/`wsl2`/`linux`/`macos`/`windows`）：

- **注入过滤**：每轮注入只显示 `all` + 当前环境的条目——Termux 会话看不到 WSL2 专属经验，反之亦然
- **检索过滤**：`memory_search`/`memory_recall` 默认只召回当前环境条目；`env` 参数可指定（`env: 'all'` 不过滤）；`/memory search --env=wsl2` 同理
- **打标规则**：
  - 手动 `memory_store`：缺省 `all`（通用知识）；环境专属知识显式传 `environment` 参数（如 `'termux'`）
  - 自动提取：默认打当前环境标签（会话内操作与环境强相关）
  - 已有条目回填已按关键词完成（`termux` 89 条 / `all` 175 条），误标时编辑 `memory/entries.json` 修正
- **判定原则**：知识本身与环境相关才打标（如"Termux 录音快捷键"→termux）；只是"在某个环境里发现"的通用知识标 `all`（如"pi 补全 value 整体替换前缀"→all）

## 运行时数据冲突消解（P1）

| 文件 | 入库策略 | 说明 |
|------|----------|------|
| `memory/entries.json` | **入库共享** | 长期记忆跨环境共享（已带环境标签，注入/检索自动过滤）。多机交替 push 时**以最新 push 为准**，pull 冲突时用 `git checkout --theirs` 保留远程后重放本地重要改动 |
| `memory/notes.json` | **不入库**（.gitignore） | 当前笔记，会话级、环境特定 |
| `memory/summaries.json` | **不入库**（.gitignore） | 会话摘要，环境特定 |
| `memory/checkpoints/` | **不入库** | 瞬时快照 |
| `agent/sessions/` | **不入库** | 对话历史，需 `pi-backup create --include-sessions` 归档 |
| `logs/` | **不入库** | 运行时日志 |

**entries.json 冲突处理流程**：
1. `git pull` 报冲突 → `git checkout --theirs memory/entries.json`（保留远程版本）
2. `git add memory/entries.json` 完成合并
3. 若本地有刚存的重要记忆未推送，从 `git stash` 或本地备份中手工合并（pi-memory 会在下次会话自动重新提取会话内容，一般无需手工）

## 配置层（每环境独立）

| 文件 | 策略 | 说明 |
|------|------|------|
| `agent/settings.json` + `models.json` | **每环境独立配置**，不跨机覆盖 | 各机器按能力配置（WSL2 有 GPU 可上大模型；Termux 用 base）；首次 clone 后手动配置 |
| `agent/auth.json` | **每环境独立** | API 凭据不跨机同步（安全）；`pi-backup create --with-auth` 仅迁移用，勿日常覆盖 |
| `agent/pi-voice.json` | 按需 | 含 whisperToken/whisperDevice，每环境独立或手动拷贝；**rebuild 语音重建以此文件存在为触发条件**（不存在则跳过语音依赖，`--voice` 强制） |
| `pi-link.json` | **每环境独立**（gitignored） | pi-link 多设备互联设备清单（host/user/port/selfName/allowUnattended）；运行时文件 `pi-link-active.json`/`pi-link-state.json`/`pi-link-outbox.json` 同理不入库。多设备接入流程见 `agent/extensions/pi-link/README.md` |
| `~/.tmux.conf` / `~/.termux/` / `~/.config/alacritty/` | 归档收录（`pi-backup create`） | 各环境终端配置差异大（WSL2 需 WSLg 调优，见 docs/alacritty-tmux-setup.md；Termux 需 extended-keys） |

## 常见环境差异坑

| 主题 | Termux | WSL2 | Linux 桌面 | **Windows 便携版**（pi-portable，见 portable/README.md） |
|------|--------|------|-----------|
| tmux 组合键 | 需 `extended-keys` 透传 | 需 `extended-keys` | 一般无需 |
| 录音/语音 | Termux:API + whisper（见 TERMUX-DEV-NOTES.md） | **parec → RDPSource + WSLg 音频桥**（需 Windows 麦克风权限；rdp-source 曾遇连接即卡死，根因是权限弹窗未处理） | 麦克风直连（parec/arecord） | **ffmpeg dshow 录音** → 本地 whisper（18767，small+zh+opencc 简体）→ SAPI 朗读 |
| TTS | termux-tts-speak（系统引擎） | **piper 神经 TTS**（自然中文，`ttsEngine:auto` 自动选）或 espeak-ng 拼音合成 | 同 WSL2 | Windows SAPI（PowerShell） |
| whisper 推理 | CPU（int8，base 档位） | **GPU cuda/float16 可用**（RTX 实测；依赖 nvidia-cublas/cudnn，重建 `--voice` 时提示）；base 小模型 GPU 收益有限，medium/large 才显著 | GPU 可用 | CPU（small；需 GPU 则装 nvidia-cublas/cudnn ~1GB） |
| 搜索 | 本机 searxng（8889） | 本机 searxng（8889） | 本机 searxng（8889） | 本地 searxng（8890，cn.bing+360search） |
| tmux | tmux 原生 | tmux 原生 | tmux 原生 | **pi-tmux 原生后端**（无 tmux：bash -c+pidfile/taskkill） |
| 浏览器 | CloakBrowser headless | 可 headless/有 X | 有 X | CloakBrowser（.cloakbrowser/ 定制版，--no-proxy-server） |
| 剪贴板 | 不适用 | `xclip`/WSLg 集成 | `xclip`/`wl-copy` |
| 回车输入 | ICRNL 转 `\n`（Kitty 解析为 shift+enter） | 正常 | 正常 | 正常 |
| GPU | 无 | 可用（d3d12） | 可用 | 可用（whisper 未启用） |

## 环境切换日常流程

```bash
# 每次切换环境后
git pull          # 拉取共享更新（entries.json 冲突按上文处理）
# 本机独立配置（仅首次）
#   settings.json / models.json / auth.json 按本机配置
```

```bash
# 定期同步（在任一环境）
pi-backup sync    # 推送（含 entries.json 记忆）
```
