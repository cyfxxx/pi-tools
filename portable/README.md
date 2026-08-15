# 便携 pi（Portable pi）使用说明

单文件夹便携包：Node + pi + 配置全部在 `pi-portable/` 内，可整体拷到 U 盘/其他机器移动使用，不注册系统、不写系统目录。

## 两个概念：种子 vs 实例

- **种子（本目录 `portable/`）**：仓库里的构建脚本与模板——新设备从这里拷贝
- **实例**：完整便携包（如 `E:\pi-portable`）——种子 + node/pi-global 等运行时 + 配置数据

## 实例目录结构

```
pi-portable/
├── start.bat / start.ps1   入口启动器（根目录，最显眼）
├── bin/                    管理脚本（setup/verify/diag/sync/update-pi/update-portable/patch/check-restart/check-services/searxng-setup/whisper-setup）
├── node/                   Node LTS 便携版（setup 生成；**需 Node 24+**——zstd 压缩支持，旧版安装失败）
├── pi-global/              pi 本体（npm --prefix 本地安装）
├── tools/                  工具组件（ffmpeg/PortableGit/ca-bundle/uv/便携 Python/searxng 实例/whisper 实例）
├── .cloakbrowser/          pi-browser 官方 stealth 定制 Chromium（解压后 537MB，gitignored）
├── agent/                  配置/会话/扩展唯一真身（仓库工作副本 + 运行时；.pi\agent junction 指向）
├── memory/                 pi-memory 数据（entries.json 入库共享；.pi\memory junction 指向）
├── .pi/                    junction 区（agent/memory 链接 + pi-link 运行时）[隐藏]
├── .ssh/ AppData/ Microsoft/  Windows 运行时（SSH 密钥/程序数据）[隐藏]
├── deploy/               部署配置（systemd unit 模板 / tmux 配置与状态脚本 / pi-link 公钥合集；Linux 部署相关，Windows 便携包用不到）[git 跟踪]
└── README.md .gitignore .git    pi-tools 仓库
```

> **agent/memory 为什么在包根**：pi-tools 仓库工作副本（git 跟踪扩展源码/记忆），同时是运行时真身——经 `.pi\agent`、`.pi\memory` 两个 junction 统一（`start.bat` 的 `PI_CODING_AGENT_DIR=.pi\agent`、`HOME=包根` 透明访问）。junction 创建：`cmd /c mklink /J ".pi\agent" "agent"`（先删旧目录）。**自动自愈**：压缩/解压可能把 junction 压平成真实目录（表现为 `.pi\agent` 缺 bin/，fd/rg 报 not found），`start.bat`/`start.ps1` 启动时运行 `bin/repair-junctions.js` 自动检测并重建（合并运行期状态回真身、keep-newer、幂等；文件被占用时本次做能做的并下次启动补完）。

## 首次构建（新机器）

1. 新建空文件夹（如 `pi-portable`），把种子 `portable/` 全部内容拷进去（`bin/`、`start.bat`、`start.ps1`、`ca-bundle.crt`、`tools/`、`README.md`），另从仓库拷 `scripts/whisper-server.py`（whisper 服务端，check-services.js 依赖）
2. 拷贝配置：从现有实例拷 `agent/`（含扩展源码与配置、sessions 会话；`settings.json`/`models.json`/`auth.json` 含密钥，自行决定）与 `memory/`
3. 运行 `.\bin\setup.ps1`（自动：下载 Node LTS → npmmirror 装 pi → 下载 ffmpeg/PortableGit/uv → **自动创建 `memory/` 并建 `.pi\agent`/`.pi\memory` 两个 junction** → 装扩展依赖 → 应用核心补丁（patch-footer/voice-enter/plan-tools；Termux 专属 playwright-core 与 tab-arg-completion 补丁不适用于 Windows）→ 拷入 ca-bundle/tmux shim；重跑幂等）
4. 运行 `.\bin\verify.ps1` 验证环境（核心组件全 [OK]，含 junction 有效性/三补丁 marker/配置路径漂移检查；可选组件缺失属正常）
5. 可选组件按需构建：`.\bin\searxng-setup.ps1`（本地搜索 8890）/ `.\bin\whisper-setup.ps1`（转写 18767）/ 手动部署浏览器（pi-browser README）
6. `.\start.bat --continue` 启动（junction 自愈兜底，服务自动拉起）

## 日常使用

| 命令 | 用途 |
|---|---|
| `.\start.bat --continue` | 启动 + 恢复会话（入口；自动拉起 searxng/whisper 服务——bin/check-services.js 端口检测） |
| `.\bin\verify.ps1` | 环境验证（node/pi/扩展/homedir/junction/补丁 marker/配置漂移） |
| `.\bin\diag.bat` | 诊断（node 版本/zstd/fd/rg/pi 入口/配置） |
| `.\bin\update-pi.ps1` | **升级 pi 本体**（npm 原地升级 pi-global + 重跑补丁 + 验证） |
| `.\bin\update-portable.ps1` | **同步扩展代码**（拉仓库最新扩展/技能，保留本地配置） |
| `.\bin\sync.ps1` | 提交推送本地改动到 GitHub（SSH 443） |
| `.\bin\setup.ps1` | 构建器（新机器跑一次；重跑幂等） |
| `bash scripts\test-all.sh`（PI_HOME=包根） | 全量回归（9 扩展 vitest + tsc + subagent + 冲突检查；tsconfig.local.json 缺失自动生成；scripts/ 从仓库同步） |

## 会话恢复（--continue）

- pi 的会话目录按 cwd 编码：`sessions/--<路径编码>--/`（WSL `/root` → `--root--`；Windows 启动器 cwd=包根 → `--E--pi-portable--`（E: 冒号/反斜杠各编码一个 `-`））
- 构建时把原环境会话快照预置到对应编码目录——`--continue` 直接恢复
- 手动恢复特定会话：`start.bat --session <路径>`（pi 支持直接文件路径参数）

## 工具组件（tools/）

`bin\setup.ps1` 自动准备语音/git 所需组件：

| 组件 | 来源 | 说明 |
|---|---|---|
| `tools/ffmpeg/bin/ffmpeg.exe` | gh-proxy 镜像下载（BtbN 构建，~170MB，多源 fallback） | pi-voice 录音（dshow）+ 音频处理；start.bat 的 `PI_VOICE_MIC_BIN` 引用（固定 `ffmpeg\bin\` 结构，解压自动整理） |
| `tools/PortableGit/` | gh-proxy 镜像下载（git-for-windows v2.55.0.4 .7z，~57MB，Windows tar 解压） | 无系统 git 的机器可用；`tools/PortableGit/cmd/git.exe` |
| `tools/ca-bundle.crt` | 种子自带（216K，仓库入库） | GIT_SSL_CAINFO（GitHub 证书链被墙环境的 git 用） |
| `tools/tmux/tmux.cmd` | 种子自带 | tmux shim → `wsl.exe tmux %*`（兜底；pi-tmux 主路径为 Windows 原生后端 bash -c + taskkill，不依赖 WSL） |
| `tools/uv/uv.exe` + `tools/python/` | setup.ps1 下载 uv.exe（~15MB，多源 fallback）+ uv 便携 Python 3.12（UV_PYTHON_INSTALL_DIR） | searxng/whisper venv 的 Python 运行时（searxng-setup/whisper-setup 自动创建 venv） |
| `tools/searxng/` | 重建：`bin\searxng-setup.ps1`（源码下载+venv+依赖+补丁+配置，幂等） | 本地搜索服务（端口 8890；cn.bing+360search 引擎；Windows 补丁：SelectorEventLoop+pwd） |
| `tools/whisper/` | 重建：`bin\whisper-setup.ps1`（venv+faster-whisper+opencc） | 本地转写服务（端口 18767；模型 small+强制中文+opencc 繁→简；模型缓存 tools/whisper/models） |

> **服务启动方式（重要）**：`check-services.js` 直接 spawn **base python**（`tools/python/cpython-*/python.exe`）+ `PYTHONPATH` 注入 venv site-packages，**不执行 venv 的 `Scripts\python.exe`**——那是 uv trampoline，其内部 spawn 的 base python 不受 `windowsHide` 控制，会弹出两个常驻终端窗口（searxng/whisper 各一）。venv 仅作包仓库。服务日志：`.pi\logs\searxng.log` / `.pi\logs\whisper.log`。
| `.cloakbrowser/` | 手动下载官方定制版 zip（zip 约 562MB，解压后 537MB；GitHub 直连慢可走下载工具） | pi-browser 浏览器（stealth 指纹完整：webdriver=false 等）；npmmirror 普通 Chrome 可作替代（CLOAKBROWSER_BINARY_PATH 指向） |

> 大文件（ffmpeg/PortableGit）不入库，setup 首次运行下载；小文件（ca-bundle/shim）随种子拷贝。

## 下载与镜像（2026-08-15 重建实测）

setup.ps1 下载用 **curl 测速 + 多源自动换源**：

- `--speed-limit 51200 --speed-time 15`：速度连续 15s 低于 50KB/s 自动换源（慢速不死等）
- `--max-time 900` 总超时兜底；下载后**大小 ≥1KB + magic 头验证**（zip/7z/gzip/MZ）——代理可能返回 200 但内容为错误页
- 失败自动删残文件再换源；已下载的 zip 有效（>1MB）则跳过重下（解压失败重跑不重下）

**镜像池**（按 2026-08-15 实测速度排序，直连兜底）：

| 镜像 | 实测状态 |
|---|---|
| `ghproxy.net` | ✅ 可用，362KB/s（首选） |
| `gh.ddlc.top` | ✅ 可用，180KB/s |
| `gh-proxy.com` | ✅ 可用，49KB/s |
| `gh-proxy.net` / `ghfast.top` / `ghproxy.cc` | ❌ 错误页/连接失败（已剔除） |

Node 压缩包与 LTS 版本查询另有 npmmirror 镜像 fallback（国内 20MB/s）。

## 升级 pi

```powershell
powershell -ExecutionPolicy Bypass -File E:\pi-portable\bin\update-pi.ps1
```

不要用 pi 内置更新命令（走系统 npm 路径解析，便携环境不可靠）。脚本自动：npm 原地升级 pi-global（npmmirror 镜像）→ 重跑 3 个核心补丁（patch-footer-live-context / patch-voice-enter / patch-plan-tools，bin/ 优先、scripts/ 兜底，传 dist 参数）→ verify；失败提示回退命令。

## 更新扩展代码

```powershell
powershell -ExecutionPolicy Bypass -File E:\pi-portable\bin\update-portable.ps1
```

拉仓库最新扩展/技能（robocopy 同步 agent/extensions 等 5 个目录，保留本地 settings/auth），pi-voice 保留（Windows 原生语音自 2026-08-14 起支持，提交 71209d3）。

## 已知限制

- **服务自启**：start.bat 启动时 bin/check-services.js 检测 8890/18767 端口，未监听自动拉起（spawn python detached——cmd 嵌套实测失败）
- **pi-tmux Windows 原生后端**（runTmux win32 分支：bash -c + --noprofile 执行 + 日志落盘 + pidfile/taskkill 树杀；不依赖 WSL。限制：bash -c 会话无 stdin 交互（tmux_send 仅 Ctrl-C/读取/停止），长驻命令需自写循环如 `while true; do ...; sleep 5; done`）
- **pi-browser**：官方 stealth 定制版已部署 .cloakbrowser/（zip 562MB 解压后 537MB）；impl.ts 自动探测（优先定制版→回退 npmmirror）；--no-proxy-server 强制直连（系统代理干扰 ERR_NETWORK_ACCESS_DENIED）
- **pi-voice**：ffmpeg dshow 录音 + whisper small/zh/opencc 简体 + SAPI 朗读；回车听写需核心补丁（patch-voice-enter.mjs——便携包 PI_DIST/win32 探测已适配）
- **whisper GPU 推理未启用**（需 nvidia-cublas/cudnn pip 包 ~1GB；small CPU 实时率可接受）
- 大文件（node/pi-global/tools/.cloakbrowser 等）不入库——新设备 setup 自动下载/重建
- Windows 上 pi 本地扩展的 settings 排除受 projectTrusted 限制——未信任时不生效（物理删除目录最可靠）

## 备份/迁移

整个 `pi-portable/` 目录拷走即可（含配置与记忆）。密钥文件（settings.json/auth.json/.ssh）自行决定是否携带。
