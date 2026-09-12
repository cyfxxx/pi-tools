# pi-voice — 语音交流扩展

> 在 Android Termux 上为 pi 提供双向语音交流：麦克风录音 → 本地 Whisper 转写 → 语音输入；回复自动朗读（Termux 系统 TTS）。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 语音输入、语音输出、转写服务 |
| 相关文档 | [pi-whisper.sh](./scripts/pi-whisper.sh), [pi-sherpa.sh](./scripts/pi-sherpa.sh) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、安装与启动](#六安装与启动)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 在 Termux 环境下需要语音交互能力：
- 用户希望通过语音输入指令
- 系统回复需要语音朗读
- 需要支持离线转写

### 1.2 设计理念

- **完全本地转写**：faster-whisper，无需 API key，离线可用
- **双向语音**：录音转写 + TTS 朗读
- **隐私保护**：录音文件即用即弃，不持久化
- **平台适配**：支持 Termux/Linux/Windows 多平台

---

## 二、架构

### 2.1 系统架构图

```
用户说话 → termux-microphone-record 录 m4a
         → ffmpeg 转 16kHz wav
         → whisper 常驻服务（localhost:18766）
         → 转写文本 → pasteToEditor / sendUserMessage
pi 回复  → message_end 事件 → 提取文本 → termux-tts-speak 朗读
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 命令层 | `commands.ts` | 注册 /voice 命令及子命令 |
| 核心层 | `core.ts` | 录音、转写、TTS 核心逻辑 |
| 听写层 | `dictation.ts` | 听写模式状态机 |
| 平台层 | `platform.ts` | 平台适配（Termux/Linux/Windows） |
| 配置层 | `config.ts` | 配置加载、环境变量解析 |

---

## 三、功能

### 3.1 核心功能

| 功能 | 说明 |
|------|------|
| 语音输入 | 麦克风录音 → 转写 → 文本输入 |
| 语音输出 | 回复自动朗读（TTS） |
| 听写模式 | 录音中按回车切段，逐段转写 |
| 模型切换 | tiny/base/small/medium/large-v3 |
| 设备切换 | cpu/gpu/auto |
| 速度测试 | 录 5 秒测 RTF |

### 3.2 命令清单

| 命令 | 说明 |
|------|------|
| `/voice` | 开始/停止录音并转写（快捷键 `Ctrl+Alt+R`） |
| `/voice start` | 开始录音 |
| `/voice stop` | 停止录音并转写 |
| `/voice cancel` | 取消录音 |
| `/voice tts on\|off` | 开关自动朗读回复 |
| `/voice tts speak [文本]` | 手动朗读 |
| `/voice tts status` | 查看朗读状态 |
| `/voice model` | 列出模型 |
| `/voice model <名>` | 切换模型 |
| `/voice device` | 查看推理设备 |
| `/voice device <cpu\|gpu\|auto>` | 切换设备 |
| `/voice bench` | 录 5 秒测转写速度 |
| `/voice backend` | 切换转写后端 |
| `/voice wake on\|off` | 开关唤醒监听 |
| `/voice doctor` | 诊断语音功能 |

### 3.3 听写模式

**使用方法**：
1. `/voice start` 或快捷键开始录音
2. 每说完一段按**回车**：立即停止录音并转写，文本追加进输入框
3. 按回车确认：**输入框有内容则正常发送**，**输入框为空则开始下一段录音**
4. 全部说完用 `Ctrl+Alt+R`/`/voice` 正常停止

**特点**：
- 转写文本始终进输入框（不随 `autoSend` 直发）
- 各段文本追加到输入框，统一修改后发送
- 录音时长到上限自动转写

### 3.4 转写后端

| 后端 | 模型 | 准确率 | 速度（RTF） | 适用 |
|------|------|--------|------|------|
| whisper（默认） | faster-whisper base/small/medium | 中 | 手机 CPU 慢 | 稳定、可切换模型 |
| sherpa | SenseVoice int8（229MB，端侧） | **高** | **极快（RTF≈0.04）** | 中文为主、追求速度与准确 |

### 3.5 KWS 唤醒监听

仅 Linux（parec 持续采 PCM 流式上传检测）；Termux 录音 API（MediaRecorder）无实时 PCM 流，不支持。

```bash
/voice wake on          # 进入监听
/voice wake off         # 停止监听
/voice wake auto on     # 开启自动监听
/voice wake auto off    # 关闭自动监听
```

---

## 四、配置项

### 4.1 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_VOICE_WHISPER_ENDPOINT` | `http://127.0.0.1:18766` | 转写服务地址 |
| `PI_VOICE_WHISPER_TOKEN` | 空 | whisper 服务 Bearer token |
| `PI_VOICE_MIC_BIN` | `termux-microphone-record` | 录音命令 |
| `PI_VOICE_FFMPEG_BIN` | `ffmpeg` | 转码命令 |
| `PI_VOICE_TTS_BIN` | `termux-tts-speak` | 朗读命令 |
| `PI_VOICE_TTS_ENABLED` | `0` | 自动朗读回复开关 |
| `PI_VOICE_TTS_MAX_CHARS` | `400` | 单次朗读最大字符数 |
| `PI_VOICE_AUTO_SEND` | `0` | 转写后直接发送 |
| `PI_VOICE_MAX_SECONDS` | `120` | 录音上限秒数 |
| `PI_VOICE_LANGUAGE` | `zh` | 转写语言 |
| `PI_VOICE_WHISPER_MODEL` | `base` | 转写模型 |
| `PI_VOICE_PLATFORM` | `auto` | 平台强制 |
| `PI_VOICE_STT_BACKEND` | `whisper` | 转写后端 |

### 4.2 配置文件

`~/.pi/agent/pi-voice.json`：

```json
{
  "whisperEndpoint": "http://127.0.0.1:18766",
  "whisperToken": "",
  "whisperModel": "base",
  "language": "zh",
  "autoSend": false,
  "maxSeconds": 120,
  "ttsEnabled": false,
  "ttsMaxChars": 400,
  "sttBackend": "whisper"
}
```

> 注意：环境变量优先于 json；由环境变量定义的字段不会写入 json。

---

## 五、使用方法

### 5.1 基本用法

```bash
# 开始录音（快捷键 Ctrl+Alt+R）
/voice

# 停止录音并转写
/voice stop

# 查看转写模型
/voice model

# 切换转写模型
/voice model small

# 开关自动朗读
/voice tts on
/voice tts off

# 手动朗读
/voice tts speak 你好世界

# 诊断语音功能
/voice doctor
```

### 5.2 听写模式

```bash
# 开始听写
/voice start

# 每说完一段按回车
# 文本会追加到输入框

# 全部说完后发送
# 按回车确认
```

### 5.3 模型切换

```bash
# 列出可用模型
/voice model

# 切换模型（需重启 whisper 服务）
/voice model small

# 测试转写速度
/voice bench
```

### 5.4 TTS 控制

```bash
# 开关自动朗读
/voice tts on
/voice tts off

# 手动朗读
/voice tts speak 你好世界

# 查看 TTS 状态
/voice tts status
```

---

## 六、安装与启动

### 6.1 安装依赖

```bash
# 1. 转写后端（一次性）
python3 -m venv /opt/pi-whisper/venv
/opt/pi-whisper/venv/bin/pip install faster-whisper opencc-python-reimplemented
~/.pi/scripts/pi-whisper.sh start        # 常驻服务启动

# （可选，推荐）sherpa SenseVoice 后端
python3 -m venv /opt/pi-sherpa/venv
/opt/pi-sherpa/venv/bin/pip install sherpa-onnx numpy
~/.pi/scripts/pi-sherpa.sh start        # 端口 18768

# 2. 录音依赖
pkg install termux-api        # Termux 侧
apt-get install ffmpeg        # PRoot 侧

# 3. 扩展自动发现
# 重启 pi 或 /reload 后即可使用

# 4. tmux 透传组合键（快捷键必需）
# ~/.tmux.conf 加入：set -g extended-keys always
# 然后重启 tmux server
```

### 6.2 鉴权配置（可选）

```bash
# 1. 生成令牌
python3 -c "import json; json.dump({'whisperToken':'<随机token>'}, open('$HOME/.pi/agent/pi-voice.json','w'))"

# 2. 重启服务
~/.pi/scripts/pi-whisper.sh restart

# 3. 验证
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18766/health   # 401
```

### 6.3 存储与权限

- 录音默认存到 `/storage/emulated/0/pi-voice/`（Android 共享存储）
- 每次录音的前转换记录为 m4a + wav，转写完成后立即删除
- 权限：在 Android 设置授予 Termux:API 麦克风权限

---

## 七、已知问题

### 7.1 录音相关

- **"m4a 转 wav 失败"**：转码失败提示现在附带 ffmpeg 具体错误，据此判断是写入竞态还是文件损坏
- **"录音启动失败"**：启动验证判定服务端"假成功"，已自动清理重试一次仍失败
- **"录音异常提前结束"**：录音进程意外退出且服务端也已停止
- **"未识别到语音内容"**：whisper 返回空文本，可切换更大模型提升识别率
- **重启后"只能开不能关"**：pi 重启会丢失录音状态，新版扩展启动时自动清理孤儿进程

### 7.2 权限相关

- **录音权限**：`/voice doctor` 显示"麦克风权限未授予" → Android 设置 → 应用 → Termux:API → 麦克风 → 允许
- **转写服务不可达**：`~/.pi/scripts/pi-whisper.sh status`；未运行则执行 `start`

### 7.3 性能相关

- **转写慢**：`/voice bench` 测速，按 RTF 建议用 `/voice model tiny/base/small` 切换
- **TTS 无声音**：确认 Android 已启用 TTS 引擎（设置 → 系统 → 无障碍 → 文字转语音）

### 7.4 唤醒相关

- **唤醒词无反应**：三诊断法——①验证基线：手动录音→转写；②单测唤醒链路；③按三类故障面分流
- **autoWake 后台监听实现要点**：配置项放 config.ts，逻辑在 core.ts；开关走扩展 slash 命令子命令

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-voice
npm install
npx vitest run
```

### 8.2 测试覆盖

- 录音状态机
- 转写逻辑
- TTS 控制
- 平台适配
- 配置加载

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现语音交流功能 |