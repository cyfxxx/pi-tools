# 便携 pi（Portable pi）使用说明

单文件夹便携包：Node + pi + 配置全部在 `pi-portable/` 内，可整体拷到 U 盘/其他机器移动使用，不注册系统、不写系统目录。

## 两个概念：种子 vs 实例

- **种子（本目录 `portable/`）**：仓库里的构建脚本与模板——新设备从这里拷贝
- **实例**：完整便携包（如 `E:\pi-portable`）——种子 + node/pi-global 等运行时 + 配置数据

## 实例目录结构

```
pi-portable/
├── start.bat / start.ps1   入口启动器（根目录，最显眼）
├── bin/                    管理脚本（setup/verify/diag/sync/update-pi/update-portable/patch）
├── node/                   Node LTS 便携版（setup 生成）
├── pi-global/              pi 本体（npm --prefix 本地安装）
├── tools/                  工具组件（ffmpeg/PortableGit/ca-bundle/tmux shim）
├── agent/                  配置/会话/扩展唯一真身（仓库工作副本 + 运行时；.pi\agent junction 指向）
├── memory/                 pi-memory 数据（entries.json 入库共享；.pi\memory junction 指向）
├── .pi/                    junction 区（agent/memory 链接 + pi-link 运行时）[隐藏]
├── .ssh/ AppData/ Microsoft/  Windows 运行时（SSH 密钥/程序数据）[隐藏]
├── docs/ scripts/ searxng/ systemd/ tmux/ keys/  仓库内容（Linux 部署相关，Windows 便携包用不到）
└── README.md .gitignore .git    pi-tools 仓库
```

> **agent/memory 为什么在包根**：pi-tools 仓库工作副本（git 跟踪扩展源码/记忆），同时是运行时真身——经 `.pi\agent`、`.pi\memory` 两个 junction 统一（`start.bat` 的 `PI_CODING_AGENT_DIR=.pi\agent`、`HOME=包根` 透明访问）。junction 创建：`cmd /c mklink /J ".pi\agent" "agent"`（先删旧目录）。

## 首次构建（新机器）

1. 新建空文件夹（如 `pi-portable`），把种子 `portable/` 全部内容拷进去（`bin/`、`start.bat`、`start.ps1`、`ca-bundle.crt`、`tools/`、`README.md`）
2. 拷贝配置：从现有实例拷 `agent/`（含扩展源码与配置、sessions 会话；`settings.json`/`models.json`/`auth.json` 含密钥，自行决定）与 `memory/`
3. 运行 `.\bin\setup.ps1`（自动：下载 Node LTS → npmmirror 装 pi → 下载 ffmpeg/PortableGit/Chrome → 装扩展运行时依赖 → 拷入 ca-bundle/tmux shim）
4. 运行 `.\bin\verify.ps1` 验证环境
5. 建 junction：`cmd /c mklink /J ".pi\agent" "agent"` + `cmd /c mklink /J ".pi\memory" "memory"`

## 日常使用

| 命令 | 用途 |
|---|---|
| `.\start.bat --continue` | 启动 + 恢复会话（入口） |
| `.\bin\verify.ps1` | 环境验证（node/pi/扩展/homedir） |
| `.\bin\diag.bat` | 诊断（node 版本/zstd/fd/rg/pi 入口/配置） |
| `.\bin\update-pi.ps1` | **升级 pi 本体**（npm 原地升级 pi-global + 重跑补丁 + 验证） |
| `.\bin\update-portable.ps1` | **同步扩展代码**（拉仓库最新扩展/技能，保留本地配置） |
| `.\bin\sync.ps1` | 提交推送本地改动到 GitHub（SSH 443） |
| `.\bin\setup.ps1` | 构建器（新机器跑一次；重跑幂等） |

## 会话恢复（--continue）

- pi 的会话目录按 cwd 编码：`sessions/--<路径编码>--/`（WSL `/root` → `--root--`；Windows 启动器 cwd=包根 → `--E-pi-portable--`）
- 构建时把原环境会话快照预置到对应编码目录——`--continue` 直接恢复
- 手动恢复特定会话：`start.bat --session <路径>`（pi 支持直接文件路径参数）

## 工具组件（tools/）

`bin\setup.ps1` 自动准备语音/git 所需组件：

| 组件 | 来源 | 说明 |
|---|---|---|
| `tools/ffmpeg/bin/ffmpeg.exe` | gh-proxy 镜像下载（BtbN 构建，~85MB，双源 fallback） | pi-voice 录音（dshow）+ 音频处理；start.bat 的 `PI_VOICE_MIC_BIN` 引用 |
| `tools/PortableGit/` | gh-proxy 镜像下载（git-for-windows v2.55.0.4 .7z，~57MB，Windows tar 解压） | 无系统 git 的机器可用；`tools/PortableGit/cmd/git.exe` |
| `tools/ca-bundle.crt` | 种子自带（216K，仓库入库） | GIT_SSL_CAINFO（GitHub 证书链被墙环境的 git 用） |
| `tools/tmux/tmux.cmd` | 种子自带 | tmux shim → `wsl.exe tmux %*`（pi-tmux 扩展在 Windows 调 WSL 后端；start.bat 已加 PATH） |
| `tools/chrome-win64/` | setup 下载（npmmirror chrome-for-testing 146.0.7680.165，~191MB zip） | pi-browser 用（`CLOAKBROWSER_BINARY_PATH` 指向 chrome.exe——cloakbrowser 官方本地覆盖；cloakbrowser 定制版 GitHub 下载被墙时的替代） |

> 大文件（ffmpeg/PortableGit）不入库，setup 首次运行下载；小文件（ca-bundle/shim）随种子拷贝。

## 升级 pi

```powershell
powershell -ExecutionPolicy Bypass -File E:\pi-portable\bin\update-pi.ps1
```

不要用 pi 内置更新命令（走系统 npm 路径解析，便携环境不可靠）。脚本自动：npm 原地升级 pi-global（npmmirror 镜像）→ 重跑补丁（patch-footer-live-context.mjs，传 dist 参数）→ verify；失败提示回退命令。

## 更新扩展代码

```powershell
powershell -ExecutionPolicy Bypass -File E:\pi-portable\bin\update-portable.ps1
```

拉仓库最新扩展/技能（robocopy 同步 agent/extensions 等 5 个目录，保留本地 settings/auth），pi-voice 保留（Windows 原生语音 71209d3 起支持）。

## 已知限制

- **searxng/whisper** 是 Python 服务不在包内——搜索/语音需目标机器另装（pi-voice 在 Windows 走 WSL whisper 127.0.0.1）
- 大文件（node/pi-global/tools/ffmpeg 等）不入库——新设备 setup 自动下载
- Windows 上 pi 本地扩展的 settings 排除受 projectTrusted 限制——未信任时不生效（物理删除目录最可靠）

## 备份/迁移

整个 `pi-portable/` 目录拷走即可（含配置与记忆）。密钥文件（settings.json/auth.json/.ssh）自行决定是否携带。
