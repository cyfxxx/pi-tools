# pi-voice — 语音交流扩展

在 Android Termux 上为 pi 提供双向语音交流：麦克风录音 → 本地 Whisper 转写 → 语音输入；回复自动朗读（Termux 系统 TTS）。

## 功能

- **/voice** 开始/停止录音并转写（`Ctrl+Shift+R` 主快捷键；`Ctrl+Alt+R` 备选，Android 软键盘无 Shift 键时可按键）
- **/voice start|stop|cancel|doctor|model|bench** 录音子命令、依赖诊断、模型切换、速度基准
- **听写模式**：录音中按**回车** = 结束当前段并转写（状态条显示「⚙ 转写中…」），完成后**自动续录**下一段；用快捷键/命令停止为正常退出（不续录）。各段文本追加到输入框，最后统一修改后发送
- **/voice model** 列出模型；`/voice model <名>` 切换（tiny/base/small/medium/large-v3，重启 whisper 服务生效）
- **/voice bench** 录 5 秒音频测转写速度，输出实时率 RTF 与换模型建议
- **/tts on|off** 开关自动朗读回复（状态持久化到配置文件，重启仍生效）；**/tts speak [文本]** 手动朗读；**/tts status** 查看后端与服务状态
- 转写文本默认**插入输入框**供确认（配置 `autoSend` 为 true 时直接发送）
- 录音时长到上限（`maxSeconds`）自动转写；`/tts status` 显示自动转写结果暂存
- 完全本地转写（faster-whisper），无需 API key，离线可用
- 快捷键依赖终端转发修饰键序列：**tmux 会话须启用 `extended-keys`**（见下"安装与启动"第 4 步）；Android 软键盘默认无 Shift 键，按 Ctrl+Shift+R 需外接键盘或改用 `Ctrl+Alt+R`（软键盘有 CTRL/ALT 键）或 `/voice` 命令
- 录音中回车拦截依赖核心补丁 `scripts/patch-voice-enter.mjs`（pi update 后需重跑，`rebuild.sh` 会自动执行；**未打补丁时回车键会被扩展无条件吞掉（输入提交/菜单选择失效），且扩展检测不到补丁时将自动禁用回车听写并提示**，其余功能正常）

## 架构

```
用户说话 → termux-microphone-record 录 m4a（状态机：idle→recording→transcribing→idle）
         → ffmpeg 转 16kHz wav
         → whisper 常驻服务（localhost:18766, faster-whisper base/int8）
         → 转写文本 → pasteToEditor / sendUserMessage
pi 回复  → message_end 事件 → 提取文本 → termux-tts-speak 朗读
```

- 状态机在 `dictation.ts`（纯逻辑 + 依赖注入，可单测）；`index.ts` 只做命令注册与 UI 接线
- 隐私（即用即弃）：录音文件转写完成后立即删除；启动时与 `session_shutdown` 时清理超过 24h 的残留音频
- 安全：可配置共享 Bearer token 保护 whisper 服务（见下文"鉴权"）

## 依赖

| 组件 | 用途 | 来源 |
|------|------|------|
| `faster-whisper`（/opt/pi-whisper/venv） | 本地语音转写 | pip |
| `termux-microphone-record` | Android 麦克风录音 | `pkg install termux-api` + Termux:API 应用 |
| `ffmpeg` | m4a → wav 转码 | `apt-get install ffmpeg` |
| `termux-tts-speak` | 系统语音朗读（中文） | Termux:TTS（内置） |
| tmux `extended-keys` | 透传 Ctrl+Shift+R 修饰键序列 | 见"安装与启动"第 4 步 |

## 安装与启动

```bash
# 1. 转写后端（一次性）
python3 -m venv /opt/pi-whisper/venv
/opt/pi-whisper/venv/bin/pip install faster-whisper
~/.pi/scripts/pi-whisper.sh start        # 常驻服务启动（含断线自恢复提示）

# 2. 录音依赖
pkg install termux-api        # Termux 侧；再装 Termux:API 应用并授权麦克风
apt-get install ffmpeg        # PRoot 侧

# 3. 扩展自动发现（pi 0.83+ 从 ~/.pi/agent/extensions/ 自动加载索引）
#    重启 pi 或 /reload 后即可使用 Ctrl+Shift+R / /voice

# 4. tmux 透传组合键（快捷键必需，一次配置）
#    ~/.tmux.conf 加入：set -g extended-keys always
#    然后重启 tmux server：tmux kill-server; 重新连接后 pi 键序列才透传
```

> 国内网络：模型从 hf-mirror.com 下载（`HF_ENDPOINT`/`HF_HUB_DISABLE_XET` 已固化在 `whisper-server.py`）。

## 存储与权限

- 录音默认存到 **`/storage/emulated/0/pi-voice/`**（Android 共享存储）：Termux:API 的 MediaRecorder 无法打开 PRoot 容器内路径（会报 `open failed: ENOENT`），这是录音"无反应/停不掉"的根因。可用 `PI_VOICE_TMP_DIR` 覆盖；非 Android 环境自动回落 `/tmp/pi-voice`。
- 每次录音的前转换记录为 m4a + wav，转写完成后立即删除（即用即弃）；启动与 `session_shutdown` 时清理超过 24h 的残留。
- 权限：在 Android 设置授予 **Termux:API 麦克风**权限；Termux 还需存储访问权限（读写 `/storage/emulated/0/pi-voice/`）。

## 配置

环境变量或 `~/.pi/agent/pi-voice.json`（JSON 字段同名）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_VOICE_WHISPER_ENDPOINT` | `http://127.0.0.1:18766` | 转写服务地址 |
| `PI_VOICE_WHISPER_TOKEN` | 空 | whisper 服务 Bearer token（空 = 不鉴权） |
| `PI_VOICE_MIC_BIN` | `termux-microphone-record` | 录音命令 |
| `PI_VOICE_FFMPEG_BIN` | `ffmpeg` | 转码命令 |
| `PI_VOICE_TTS_BIN` | `termux-tts-speak` | 朗读命令 |
| `PI_VOICE_TTS_ENABLED` | `1` | 自动朗读回复开关（`/tts on|off` 落盘持久化） |
| `PI_VOICE_TTS_MAX_CHARS` | `400` | 单次朗读最大字符数 |
| `PI_VOICE_AUTO_SEND` | `0` | 转写后直接发送（不插入编辑框） |
| `PI_VOICE_MAX_SECONDS` | `120` | 录音上限秒数（0 = 手动停止） |
| `PI_VOICE_LANGUAGE` | 空 | 转写语言（空 = 自动检测） |
| `PI_VOICE_WHISPER_MODEL` | `base` | 转写模型（tiny/base/small/medium/large-v3；`/voice model` 切换并重启服务） |

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
/voice      开始录音（提示"录音中"）→ 再按一次 Ctrl+Shift+R 停止并转写，结果插入输入框供确认
/voice start/stop/cancel/doctor
/voice model         列出当前与可用模型
/voice model <名称>  切换模型（重启 whisper 服务，加载/下载耗时）
/voice bench         录 5 秒测转写速度（RTF 与换模型建议）
/tts on|off 开关自动朗读回复（状态持久化）；无参数等价切换
/tts speak  朗读最近一条回复；/tts speak <文本> 朗读指定文本
/tts status 朗读开关、最近回复长度、自动转写暂存、whisper 服务状态
```

**听写模式**：`/voice start` 或快捷键开始录音后，每说完一段按**回车**：立即停止录音并转写（状态条显示「⚙ 转写中…」），文本追加进输入框，随后自动开始下一段录音；继续口述、回车切段。全部说完用 `Ctrl+Shift+R`/`Ctrl+Alt+R`/`/voice` 正常停止（不自动续录），修改输入框中的累积文本后发送。听写模式下转写文本始终进输入框（不随 `autoSend` 直发）。录音中回车切段**依赖核心补丁** `scripts/patch-voice-enter.mjs`（pi update 后重跑，或直接跑 `rebuild.sh`；**未检测到补丁时扩展自动禁用回车键**，避免回车被吞导致输入提交失效，其余功能正常）。

录音超过 `maxSeconds` 会自动停止转写（此时无编辑框上下文：`autoSend` 开启则直发，否则暂存，可用 `/tts status` 查看）。

## Troubleshooting

- **重启后“只能开不能关”、反复显示录音中**：pi 重启会丢失录音状态，若重启前正在录音，遗留的孤儿录音进程会占用麦克风（termux-microphone-record 单实例），新录音立即退出且退出码为 0。新版扩展启动时自动执行 `-q` 清理孤儿进程；若仍占用，手动执行 `termux-microphone-record -q` 后重试。
- **录音权限**：`/voice doctor` 显示“麦克风权限未授予” → Android 设置 → 应用 → Termux:API → 麦克风 → 允许。
- **转写服务不可达**：`~/.pi/scripts/pi-whisper.sh status`；未运行则执行 `start`。
- **转写慢**：`/voice bench` 测速，按 RTF 建议用 `/voice model tiny/base/small` 切换（切换会重启服务并重新加载模型）。
- **TTS 无声音**：确认 Android 已启用 TTS 引擎（设置 → 系统 → 无障碍 → 文字转语音），中文语音包需安装。