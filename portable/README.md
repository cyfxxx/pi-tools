# 便携 pi（Portable pi）使用说明

单文件夹便携包：Node + pi + 配置全部在 `pi-portable/` 内，可整体拷到 U 盘/其他机器移动使用，不注册系统、不写系统目录。

## 首次构建（新机器/首次使用）

1. 新建空文件夹（如 `pi-portable`），把本目录下脚本（`setup.ps1`/`start.bat`/`start.ps1`/`verify.ps1`/`diag.bat`/`README.md`）放进去
2. 从现有机器拷贝 `~/.pi` 到包内 `.pi/`（含 `agent/` 扩展与配置、`sessions/` 会话、`memory/` 记忆；`settings.json`/`models.json`/`auth.json` 含密钥，自行决定）
3. 右键 `setup.ps1` → "使用 PowerShell 运行"（自动：下载 Node LTS → 本地安装 pi → 生成启动器）
4. 运行 `verify.ps1` 验证环境

## 日常使用

- **启动**：双击 `start.bat`（或 `start.ps1`）——固定 cd 到包内 `workspace/`，USERPROFILE/PI_CODING_AGENT_DIR 重定向——配置/会话/记忆全落包内 `.pi/`
- **继续会话**：`start.bat --continue`

## 目录结构

```
pi-portable/
├── node/          Node LTS 便携版（setup 生成）
├── pi-global/     pi 本体（npm --prefix 本地安装）
├── workspace/     工作区（固定 cwd，项目文件放这里）
├── .pi/           配置区（agent/sessions/memory——从现机器拷贝）
├── setup.ps1      构建器（新机器跑一次）
├── start.bat      启动器（批处理）
├── start.ps1      启动器（PowerShell）
├── verify.ps1     环境验证
└── diag.bat       诊断（node 版本/zstd/fd/配置检查）
```

## 会话恢复（--continue）

- pi 的会话目录按 cwd 编码：`sessions/--<路径编码>--/`（WSL `/root` → `--root--`；Windows 启动器固定 cwd=包内 `workspace/` → `--E-pi-portable-workspace--`）
- 构建时把 WSL 当前会话预置到 `workspace` 对应目录——`--continue` 直接恢复
- 之后便携 pi 的新会话写同一目录，`--continue` 持续有效
- 手动恢复特定会话：`start.bat --session <路径>`（pi 支持直接文件路径参数）

## 升级 pi

删除 `pi-global/` 后重跑 `setup.ps1`（Node 已存在会跳过，版本不匹配自动重装 LTS）。

## 已知限制

- **searxng/whisper** 是 Python 服务不在包内——搜索/语音需目标机器另装
- **pi-voice** 在 Windows 无录音依赖（parec/termux 不存在），构建时已从包内移除该扩展；Linux 环境使用可从 `~/.pi/agent/extensions` 拷回
- Windows 上 pi 本地扩展的 settings 排除受 projectTrusted（信任项目目录）限制——未信任时不生效，物理删除扩展目录最可靠

## 备份/迁移

整个 `pi-portable/` 目录拷走即可（含配置与记忆）。密钥文件自行决定是否携带。
