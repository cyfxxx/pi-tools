# Termux 环境开发注意事项

本机环境实测经验（2026-08 汇总，pi-voice 录音链路反复踩坑总结）。适用于在 Termux（PRoot 容器）内开发涉及 Android 系统 API 的功能。

## 路径与权限

- **Termux:API（Android app）只能访问系统可访问路径**：`/storage/emulated/0/...`；PRoot 容器内路径（`/tmp/...`）会报 `open failed: ENOENT`。录音等文件必须放共享存储
- 共享存储目录需先创建且可写（`/storage/emulated/0/pi-voice/`），并确认 Termux 有存储权限
- 目录属主是 `root:aid_everybody`，Android app 侧以不同身份访问，注意权限位

## termux-microphone-record（Termux:API 录音）

- **调用延迟 ~3s**：每次调用（`-q`/`-i`/启动）都要与 termux-api 通信，批处理/清理序列要合并，避免逐条碎调用
- **`-l`（maxDuration）计时不可靠**：基于 MediaRecorder 媒体时间戳（PTS）而非墙钟，纯音频无视频锚定，实测可提前一半触发。用 `-l 0`（服务端不限时）+ 应用层 setTimeout 计时
- **`-q` 才写 moov atom**：优雅停止才会正常收尾写文件；进程被杀/异常退出时文件缺 moov（转码报 `moov atom not found`）。进程退出后需补发一次 `-q` 强制服务收尾
- **CLI 随机断线（最重要）**：`SocketListener: EOFException / Broken pipe`——CLI socket 连接在录音开始后 0.5~12s 随机断开，bash 进程随之退出，**但服务端 MediaRecorder 继续录制**。判断真实状态必须用 `-i`（输出 JSON `isRecording`），不能以进程退出为准
- **服务端释放慢**：`-q`/pkill 后 MediaRecorderService 需数秒才完全释放；立即重试会**假成功**（响应 `Recording started` 但文件从未生成，CLI 进程存活）
- **假成功检测**：spawn 成功后文件延迟生成（实测 <1s~4s，省电状态更慢），验证窗口须大于文件生成延迟（建议 ≥8s），窗口过短会误杀正常录音
- **清理残留**：`pkill` 杀 CLI 进程**不释放**服务端 MediaRecorder 麦克风占用，必须 `-q`；无残留进程时（`pgrep` 门控）跳过整套清理可省 ~4.7s 启动延迟

## Android 系统特性

- **省电/后台限制**：MediaRecorder 初始化变慢、偶发中途停止；麦克风被其他应用抢占（AudioFocus）也会中途停
- **华为/荣耀**（HwMediaRecorderImpl 日志）：偶发中途停止属已知问题
- **logcat 缓冲区滚动快**：诊断要持续落盘（`logcat -v time > file` 后台运行），事后查日志经常已滚动丢失
- **Termux:API 服务端错误是 verbose 级**，默认被系统过滤，基本盲区——只能靠现象推断 + 应用层日志

## 终端/输入

- **tmux 需 `extended-keys`**：`set -g extended-keys always`，否则 Ctrl+Alt 等修饰键序列不透传
- **回车会被转 `\n`**：Termux TTY ICRNL 把回车转成 `\n`；Kitty 键盘协议激活时 `\n` 被解析为 `shift+enter`（不是 `enter`）——按键匹配要覆盖两种
- **键盘栏**：`~/.termux/termux.properties` 的 `extra-keys` 可加自定义功能键（如 F8）；改后 `termux-reload-settings`

## 网络

- **github.com 直连可能被 DNS fake-IP 污染**（198.18.x.x 超时），api.github.com 正常；推送可用 `git -c http.proxy=http://127.0.0.1:10808 push`（v2ray 10808），不写入 git config
- **GitHub 无持久凭证**：本机无 credential helper / SSH key / gh CLI；推送需用户临时提供 PAT，内联 URL 一次性使用，完成后恢复无凭证 remote，token 不落盘

## whisper（本地转写）

- **语言自动检测不可靠**：base 模型对中文短句/噪声环境易误判英文，固定语言（`?lang=zh` / `PI_WHISPER_LANGUAGE`）解决
- **模型选择**：base 识别率一般，中文建议 small（速度看 CPU，`/voice bench` 实测 RTF）
- 服务：`pi-whisper.sh start` 管理，127.0.0.1:18766，Bearer token 鉴权

## 开发流程提醒

- 涉及 Android API 的黑盒行为：先建观测（logcat 落盘）→ 手动复现 → 再修改；复现不了不修
- 验证环境与用户设备状态会漂移（省电、连续录音、输入法差异），条件性故障要主动构造触发条件
