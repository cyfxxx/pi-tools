# pi-voice — 语音交流扩展

在 Android Termux 上为 pi 提供双向语音交流：麦克风录音 → 本地 Whisper 转写 → 语音输入；回复自动朗读（Termux 系统 TTS）。

## 功能

- **子命令 Tab 补全**：输入 `/voice` 按 **Tab**（自动补全命令名并加空格）**再按 Tab** 显示子命令列表；或直接输入 `/voice `（带空格）按 Tab。子命令随输入过滤（如 `tts s` 只显示 `tts status`）。注意：无空格时 Tab 只补全命令名，两次 Tab 才出子命令（pi-tui 行为，其他扩展命令同理）
- **/voice** 开始/停止录音并转写（快捷键 `Ctrl+Alt+R`；软键盘/外接键盘均可，或用 `/voice` 命令）
- **/voice <start|stop|cancel|tts|doctor|model|device|bench|help>** 录音/朗读子命令（`/voice help` 查看全部用法）；无参数 = 录音中则停止转写，否则开始录音
- **听写模式**：录音中按**回车** = 结束当前段并转写（状态条显示「⚙ 转写中…」），文本插入输入框后**不自动续录**（等待确认）；再次按回车：**输入框有内容 = 正常发送**（放行提交），**输入框为空 = 开始下一段录音**（听写循环）。用快捷键/命令停止为正常退出。各段文本追加到输入框，统一修改后发送
- **录音时长精确控制**：时长由扩展在 Node 侧计时（服务端 `-l 0` 不限时，规避 MediaRecorder 时间戳漂移），到 `maxSeconds` 自动 `-q` 优雅收尾并转写
- **/voice model** 列出模型；`/voice model <名>` 切换（tiny/base/small/medium/large-v3，重启 whisper 服务生效）
- **/voice device** 查看推理设备（配置 + 服务端实际）；`/voice device <cpu|gpu|auto>` 切换（GPU 被游戏/渲染占用时切 cpu 保稳定，重启服务生效）
- **/voice bench** 录 5 秒音频测转写速度，输出实时率 RTF 与换模型建议
- **/voice tts on|off** 开关自动朗读回复（状态持久化到配置文件，重启仍生效）；**/voice tts speak [文本]** 手动朗读（JSON/纯符号内容会过滤并提示）；**/voice tts status** 查看朗读开关、队列与后端状态
- **TTS 自动朗读语义**：默认关闭（非语音状态不朗读）；语音输入（开始录音/语音直发）后自动开启朗读，键盘输入自动关闭——形成语音对话闭环；手动 `/voice tts on|off` 后不再自动切换。只朗读最终回复（`message_end` 中 `stopReason=stop`），中间轮与 JSON/结构化摘要自动过滤；**串行队列合并策略**：同时只朗读一条，新回复到来时丢弃中间待读内容（中间内容无需朗读），杜绝 TTS 进程堆积。**僵尸进程兜底清理**：扩展启动时自动执行 `pkill -f termux-tts-speak; pkill -f 'termux-api TextToSpeech'`，且启动时清空 tmpDir 全部残留音频（进程重启后必然无进行中录音）
- 转写文本默认**插入输入框**供确认（配置 `autoSend` 为 true 时直接发送）
- 录音时长到上限（`maxSeconds`）自动转写；`/voice tts status` 显示自动转写结果暂存
- 完全本地转写（faster-whisper），无需 API key，离线可用
- 快捷键依赖终端转发修饰键序列：**tmux 会话须启用 `extended-keys`**（见下"安装与启动"第 4 步）；录音快捷键仅 `Ctrl+Alt+R`（Ctrl+Shift+R 已移除——与部分终端/输入法冲突易误触），也可直接用 `/voice` 命令
- 录音中回车拦截依赖核心补丁 `scripts/patch-voice-enter.mjs`（pi update 后需重跑，`rebuild.sh` 会自动执行；**未检测到补丁时扩展自动禁用回车听写**——不注册回车快捷键，避免回车被吞导致输入提交/菜单选择失效，其余功能正常）

## 架构

```
用户说话 → termux-microphone-record 录 m4a（状态机：idle→recording→transcribing→idle）
         → ffmpeg 转 16kHz wav
         → whisper 常驻服务（localhost:18766, faster-whisper base/int8）
         → 转写文本 → pasteToEditor / sendUserMessage
pi 回复  → message_end 事件 → 提取文本 → termux-tts-speak 朗读
```

- 状态机在 `dictation.ts`（纯逻辑 + 依赖注入，可单测）；`index.ts` 只做命令注册与 UI 接线
- **启动健壮性**：正常场景 pgrep 门控跳过清理序列实现快启；spawn 后 8s 启动验证检测"假成功"（服务端响应但未写文件）并自动重试；**就绪提示**：启动录音后状态条先显示「⏳ 启动麦克风中…」，录音文件实际生成（麦克风真在录，延迟实测 1-2s）后自动切换「🎤 录音中」——避免初始化窗口说话丢开头；Termux:API 的 CLI 连接断线（SocketListener EOF 已知问题，录制本身不受影响）时通过 `-i` 查询服务端，仍在录制则无感续录不打断；服务端确已停止才按异常提前结束处理（提示附实际时长）
- **停止窗口保护（2026-08 审计）**：停止录音（-q 往返 ~3s）期间 new start 会被拒绝（"正在停止上一段录音"）——否则新录音会被全局停止信号误停（Linux 模块级 recorder 同样受影响）
- 隐私（即用即弃）：录音文件转写完成后立即删除；清空 tmpDir 全部残留音频（启动时与 `session_shutdown` 时）
- 安全：可配置共享 Bearer token 保护 whisper 服务（见下文"鉴权"）

## 依赖

| 组件 | 用途 | 来源 |
|------|------|------|
| `faster-whisper`（/opt/pi-whisper/venv） | 本地语音转写 | pip |
| `opencc-python-reimplemented` | 转写结果繁→简（缺失时中文输出繁体） | pip（同 venv） |
| `termux-microphone-record` | Android 麦克风录音 | `pkg install termux-api` + Termux:API 应用 |
| `ffmpeg` | m4a → wav 转码（仅 termux；linux 平台直出 wav 不需要） | `apt-get install ffmpeg` |
| `termux-tts-speak` | 系统语音朗读（中文；termux 平台） | Termux:TTS（内置） |
| `espeak-ng` + `paplay` | 本地朗读（linux 平台：生成 wav + PulseAudio 播放） | `apt-get install espeak-ng pulseaudio-utils` |
| tmux `extended-keys` | 透传 Ctrl+Alt+R 修饰键序列 | 见“安装与启动”第 4 步 |

## 平台适配

| 平台 | 录音 | 转码 | TTS |
|------|------|------|-----|
| termux（Android，默认） | termux-microphone-record（m4a） | ffmpeg m4a→wav | termux-tts-speak |
| linux（桌面/WSL） | parec → `linuxMicDevice`（默认 RDPSource）直出 wav | 不需要 | espeak-ng 生成 wav + paplay → `linuxTtsSink`（默认 RDPSink） |
| windows（便携版） | ffmpeg dshow（`micBin`+`micDevice`）直出 wav | 不需要 | SAPI 朗读 |

- 平台由 `platform` 配置项决定：`auto`（探测：有 termux 工具 → termux，否则 linux）/ `termux` / `linux` / `windows`（便携版）；探测逻辑见 `platform.ts`
- **Windows 便携版服务自启**：`ensureWhisperService` 默认启动走 `bin/check-services.js`（spawn python detached，端口 18767、small 模型、venv 路径），随 start.bat 自动拉起；无需手动 `pi-whisper.sh`
- 新增设备适配：在 `platform.ts` 增加 spec 分支即可（录音命令构造 + TTS 构造 + 安装指引），上层 core/dictation 无需改动
- WSL 注意：麦克风需 Windows 隐私权限允许；`PULSE_SERVER` 指向 WSLg（`unix:/mnt/wslg/PulseServer`）；录音输入源/输出 sink 见 `pactl list sources/sinks`
- linux TTS 引擎 `ttsEngine`：`auto`（检测到 piper 命令 → 用 piper 神经 TTS（中文自然，需安装 piper-tts + 模型，模型路径 `linuxPiperModel`），否则 espeak-ng）/ `espeak-ng` / `piper`
- **GPU 推理**：whisper 服务 `whisperDevice`（`auto`/`cpu`/`cuda`，默认 auto = nvidia-smi 可用则 cuda + float16）。GPU 依赖：`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`（ctranslate2 CUDA 库，需 LD_LIBRARY_PATH 指向 venv nvidia 目录，pi-whisper.sh 已处理）；base 小模型 GPU 收益有限，medium/large-v3 才有显著加速

## 安装与启动

```bash
# 1. 转写后端（一次性）
python3 -m venv /opt/pi-whisper/venv
/opt/pi-whisper/venv/bin/pip install faster-whisper opencc-python-reimplemented
~/.pi/scripts/pi-whisper.sh start        # 常驻服务启动（含断线自恢复提示）

# 2. 录音依赖
pkg install termux-api        # Termux 侧；再装 Termux:API 应用并授权麦克风
apt-get install ffmpeg        # PRoot 侧

# 3. 扩展自动发现（pi 0.83+ 从 ~/.pi/agent/extensions/ 自动加载索引）
#    重启 pi 或 /reload 后即可使用 Ctrl+Alt+R / /voice

# 4. tmux 透传组合键（快捷键必需，一次配置）
#    ~/.tmux.conf 加入：set -g extended-keys always
#    然后重启 tmux server：tmux kill-server; 重新连接后 pi 键序列才透传
```

> 国内网络：模型从 hf-mirror.com 下载（`HF_ENDPOINT`/`HF_HUB_DISABLE_XET` 已固化在 `whisper-server.py`）。

## 存储与权限

- 录音默认存到 **`/storage/emulated/0/pi-voice/`**（Android 共享存储）：Termux:API 的 MediaRecorder 无法打开 PRoot 容器内路径（会报 `open failed: ENOENT`），这是录音"无反应/停不掉"的根因。可用 `PI_VOICE_TMP_DIR` 覆盖；非 Android 环境自动回落 `/tmp/pi-voice`。
- 每次录音的前转换记录为 m4a + wav，转写完成后立即删除（即用即弃）；清空 tmpDir 全部残留音频（启动时与 `session_shutdown` 时）。
- 权限：在 Android 设置授予 **Termux:API 麦克风**权限；Termux 还需存储访问权限（读写 `/storage/emulated/0/pi-voice/`）。

## 配置

环境变量或 `~/.pi/agent/pi-voice.json`（JSON 字段同名）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_VOICE_WHISPER_ENDPOINT` | `http://127.0.0.1:18766` | 转写服务地址（Windows 便携版 = `http://127.0.0.1:18767`——见 pi-voice.json，避开 WSL 转发占用） |
| `PI_VOICE_WHISPER_TOKEN` | 空 | whisper 服务 Bearer token（空 = 不鉴权） |
| `PI_VOICE_MIC_BIN` | `termux-microphone-record` | 录音命令 |
| `PI_VOICE_FFMPEG_BIN` | `ffmpeg` | 转码命令 |
| `PI_VOICE_TTS_BIN` | `termux-tts-speak` | 朗读命令 |
| `PI_VOICE_TTS_ENABLED` | `0` | 自动朗读回复开关（默认关闭，语音输入自动开启；`/voice tts on|off` 落盘持久化并切换为手动模式） |
| `PI_VOICE_TTS_MAX_CHARS` | `400` | 单次朗读最大字符数 |
| `PI_VOICE_AUTO_SEND` | `0` | 转写后直接发送（不插入编辑框） |
| `PI_VOICE_MAX_SECONDS` | `120` | 录音上限秒数（0 = 手动停止） |
| `PI_VOICE_LANGUAGE` | `zh`（json 已设） | 转写语言（空 = 自动检测）。固定 `zh` 避免 whisper 自动检测误判英文；请求时通过 `?lang=` 传给服务端，改动即时生效 |
| `PI_VOICE_WHISPER_MODEL` | `base` | 转写模型（tiny/base/small/medium/large-v3；`/voice model` 切换并重启服务） |
| `PI_VOICE_PLATFORM` | `auto` | 平台强制（auto/termux/linux/windows——自动探测：win32→windows，termux 工具存在→termux，否则 linux） |
| `PI_VOICE_MIC_DEVICE` / `PI_VOICE_LINUX_MIC_DEVICE` | 空 / `RDPSource` | 录音设备（termux 忽略；Linux 如 `RDPSource`） |
| `PI_VOICE_TTS_ENGINE` / `PI_VOICE_PIPER_MODEL` | `auto` / 模型路径 | Linux TTS 引擎（auto/piper/sapi/espeak）+ piper 模型 |
| `PI_VOICE_WHISPER_DEVICE` / `PI_VOICE_WHISPER_SCRIPT` | `auto` / 脚本路径 | whisper 计算设备 + 服务脚本 |

> 注意：环境变量优先于 json；由环境变量定义的字段不会写入 json。

模型选择：`/voice model` 查看/切换（写入 `pi-voice.json` 的 `whisperModel` 并重启 whisper 服务）。也可直接设环境变量 `PI_VOICE_WHISPER_MODEL`（服务端启动时读取，默认 `base`）。中文推荐 `small`（更准，速度取决于手机 CPU）；切换前可用 `/voice bench` 评估当前设备速度（RTF > 1 建议降级，< 0.5 可升档）。首次使用某模型会从 hf-mirror.com 下载，耗时较长。

## 鉴权（可选）

whisper 服务默认只监听 `127.0.0.1`。若希望额外加一层防护：

```bash
# 1. 生成令牌并写入共享配置（扩展与服务端都从这里读）
python3 -c "import json; json.dump({'whisperToken':'<随机token>'}, open('$HOME/.pi/agent/pi-voice.json','w'))"
# 2. 重启服务（pi-whisper.sh start 会自动注入 PI_WHISPER_TOKEN）
~/.pi/scripts/pi-whisper.sh restart
# 3. 验证：无 token 请求应 401
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18766/health   # 401
```

## 使用

```
/voice      开始录音（提示"录音中"）→ 再按一次 Ctrl+Alt+R 停止并转写，结果插入输入框供确认
/voice start/stop/cancel/doctor
/voice model         列出当前与可用模型
/voice model <名称>  切换模型（重启 whisper 服务，加载/下载耗时）
/voice bench         录 5 秒测转写速度（RTF 与换模型建议）
/voice tts on|off 开关自动朗读回复（状态持久化）；无参数显示用法
/voice tts speak  朗读最近一条回复；/voice tts speak <文本> 朗读指定文本
/voice tts status 朗读开关、最近回复长度、自动转写暂存、whisper 服务状态
/voice help       全部子命令用法（含未知子命令提示）
```

**听写模式**：`/voice start` 或快捷键开始录音后，每说完一段按**回车**：立即停止录音并转写（状态条显示「⚙ 转写中…」），文本追加进输入框，随后**不再自动续录**；按回车确认：**输入框有内容则正常发送**（不会清空或丢字），**输入框为空则开始下一段录音**。全部说完用 `Ctrl+Alt+R`/`/voice` 正常停止。听写模式下转写文本始终进输入框（不随 `autoSend` 直发）。

> 回车键位说明：`enter` 是 pi 的保留键（`tui.input.submit`，扩展注册会被静默丢弃），扩展实际注册 `return` + `shift+enter` 覆盖两种解析路径（键盘栏回车 `\r`；Termux TTY ICRNL 转 `\n` 时 Kit yy 解析为 `shift+enter`）。录音中回车切段**依赖核心补丁** `scripts/patch-voice-enter.mjs`（pi update 后重跑，或直接跑 `rebuild.sh`；**未检测到补丁时扩展自动禁用回车键**，避免回车被吞导致输入提交失效，其余功能正常）。

录音超过 `maxSeconds` 会自动停止转写（此时无编辑框上下文：`autoSend` 开启则直发，否则暂存，可用 `/voice tts status` 查看）。

## Troubleshooting

- **“m4a 转 wav 失败（moov atom not found / Invalid data 等）”**：转码失败提示现在**附带 ffmpeg 具体错误**（截断 200 字符），据此判断是写入竞态（moov 未写完，转码前已等待文件稳定并重试 3 次）还是文件损坏。Termux:API 的 MediaRecorder 在进程退出后仍会写文件尾部；若频繁出现，检查 `/storage/emulated/0/pi-voice/` 是否可写、是否有残留录音进程占用麦克风（`termux-microphone-record -q`）。
- **“录音启动失败：服务端未实际开始录音（无音频文件生成）”**：启动验证（8s 内文件未生成）判定服务端"假成功"（响应了但没写文件，常见于 MediaRecorderService 刚清理完的状态错乱），已自动清理重试一次仍失败。等几秒再试；持续出现可执行 `termux-microphone-record -q` 手动清理后重试。
- **“录音异常提前结束（Xs）”**：录音进程意外退出且服务端也已停止（排查时先看提示中的实际秒数：几秒 = 启动级故障，几十秒 = 中途中断）。常见诱因：其他应用抢占麦克风（AudioFocus）、系统后台限制 Termux:API、音频栈偶发错误。若 Xs 较长但文件完整，转写仍会正常进行。
- **“未识别到语音内容”**：whisper 返回空文本。先确认说话音量（检测到声音但 < -45dB 时会提示"未检测到声音信号"）；环境噪声大或语速快时可切换更大模型（`/voice model small`）提升识别率。
- **重启后“只能开不能关”、反复显示录音中**：pi 重启会丢失录音状态，若重启前正在录音，遗留的孤儿录音进程会占用麦克风（termux-microphone-record 单实例），新录音立即退出且退出码为 0。新版扩展启动时自动执行 `-q` 清理孤儿进程；若仍占用，手动执行 `termux-microphone-record -q` 后重试。
- **录音权限**：`/voice doctor` 显示“麦克风权限未授予” → Android 设置 → 应用 → Termux:API → 麦克风 → 允许。
- **转写服务不可达**：`~/.pi/scripts/pi-whisper.sh status`；未运行则执行 `start`。
- **转写慢**：`/voice bench` 测速，按 RTF 建议用 `/voice model tiny/base/small` 切换（切换会重启服务并重新加载模型）。
- **TTS 无声音**：确认 Android 已启用 TTS 引擎（设置 → 系统 → 无障碍 → 文字转语音），中文语音包需安装。