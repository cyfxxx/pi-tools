# 专用工具索引（specialized tools）

调研中发现的有价值但**不并入通用技能**的项目记录。按专用领域分类，需要时按图索骥。

## LLM 控制调参（PID 专用）

| 项目 | Stars | 说明 |
|---|---|---|
| [KINGSTON-115/llm-pid-tuner](https://github.com/KINGSTON-115/llm-pid-tuner) | ★834 | 基于 LLM 的 PID 自动调参 CLI。Release 提供 Windows exe 开箱即用；支持 MATLAB/Simulink 仿真联动；config.json 填 API；提示词可自定义；dev 分支有中英双语最新文档；B站/YouTube 教程 + QQ 群。适合电机/温控等回路整定 |
| [Zw-awa/Automatically-adjust-PID-parameters](https://github.com/Zw-awa/Automatically-adjust-PID-parameters) | ★4 | 离线分析 + 串口在线调参工作流，STM32 就绪 |
| [MartinZapf/llm-pid-benchmark](https://github.com/MartinZapf/llm-pid-benchmark) | ★2 | 测前沿 LLM 迭代调 PID 能力的 benchmark（Claude/GPT/Gemini） |
| william-engineer/LLM-PID-Autotuner | ★1 | 大惯性工业热系统单向加热对象的 LLM 自整定 |
| 37chengshan/codex-pid-tuner | ★1 | Codex skill 形态，无外部 API key |

不整合原因：控制理论专用领域，与固件工程流程无交集；有需求时直接用 llm-pid-tuner。

## 垂直嵌入式 Agent（端到端执行器）

| 项目 | Stars | 说明 |
|---|---|---|
| [garycli/garycli](https://github.com/garycli/garycli) | ★146 | AI-native 嵌入式工程 agent：自然语言 → 代码 → 编译 → 烧录 → 运行时证据 → 诊断修复闭环。证据分级（代码级/构建级/运行级）。支持 STM32/RP2040/ESP/CanMV K230。官网 garycli.com，Apache 2.0 |
| [Ecro/embedeval](https://github.com/Ecro/embedeval) | ★11 | LLM 嵌入式固件开发能力 benchmark，可用于评估不同 skill 集/模型组合 |

不整合原因：自成体系的独立 agent，与 pi 的扩展/skill 架构不兼容；其"证据分级"思想已提炼进本包 SKILL.md 执行闭环一节。

## on-MCU AI Agent（反向方向：MCU 上跑 agent）

| 项目 | Stars | 说明 |
|---|---|---|
| [M64GitHub/WireClaw](https://github.com/M64GitHub/WireClaw) | ★182 | ESP32 AI agent：持久记忆+离线规则引擎，Telegram 接入，本地 7×24 |
| [device-context-protocol/dcp](https://github.com/device-context-protocol/dcp) | ★57 | Device Context Protocol：LLM 桥接物理设备，27.6KB flash / 0.6KB RAM，帧 <50B |
| beancookie/xiaoclaw | ★42 | ESP32-S3 本地语音唤醒 + 云 TTS 固件 |
| atiti/espclaw | ★8 | ESP32 原生 agent runtime：Lua 组件/OTA/Web/UART 控制 |
| bennyzen/zenclaw | ★6 | Rust 写的 ESP32(S3/P4) 全自主 agent |

不整合原因：目标平台是 MCU 固件本身而非宿主机开发流程，属另一技术栈。

## EAT 内的场景专用技能（依赖特定硬件/软件）

以下 embed-ai-tool 技能依赖额外硬件或商业软件，通用性受限，仅在对应场景启用：

- `visa-debug` — VISA 仪器编程（示波器/电源/万用表，需 NI-VISA 或 PyVISA）
- `logic-analyzer` — 逻辑分析仪控制（需 sigrok/PulseView 及硬件）
- `rtos-debug` — FreeRTOS/Zephyr 线程感知调试（需 GDB + RTOS 符号）
- `memory-analysis` / `static-analysis` — map 文件内存分析 / cppcheck 类静态检查
- `build-iar` — IAR EWARM（商业许可）
