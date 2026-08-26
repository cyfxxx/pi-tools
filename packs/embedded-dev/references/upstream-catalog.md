# 上游技能集目录（upstream catalog）

两个上游仓库的完整技能清单、功能定位与本包映射。检索时间：2026-08。

## zhinkgit/embeddedskills（MIT，可整合）

仓库：<https://github.com/zhinkgit/embeddedskills> · ★594 · Python · 12 个 skill · 子命令式 CLI + `.embeddedskills/config.json` 配置体系

| Skill | 功能 | 本包映射 |
|---|---|---|
| `gcc` | arm-none-eabi-gcc 构建 | core-workflows §构建 |
| `keil` | Keil MDK UV4 CLI 构建烧录 | upstream 引用 |
| `eide` | Embedded IDE (VSCode) 工程构建 | upstream 引用 |
| `openocd` | 探针/烧录/擦除/GDB Server/Telnet 在线调试/Semihosting/ITM | core-workflows §烧录§调试 |
| `jlink` | J-Link Commander/GDB Server/RTT | core-workflows §烧录 |
| `probe-rs` | Rust 探针工具链烧录调试 RTT | core-workflows §烧录 |
| `serial` | 串口枚举收发监视脚本 | core-workflows §观察 |
| `can` | python-can 总线调试 | upstream 引用 |
| `net` | 网络通信调试 | upstream 引用 |
| `ssh` | 远程板卡 SSH 操作 | 通用能力，无需收录 |
| `terminal` | 终端交互代理 | 通用能力，无需收录 |
| `workflow` | 跨后端编排（决策树：CLI 参数 > config > auto） | core-workflows §闭环 |

安装：`git clone https://github.com/zhinkgit/embeddedskills.git`，各 skill 目录含 SKILL.md + scripts/ + config.json。

## LeoKemp223/embed-ai-tool（无 LICENSE ⚠ 仅记录引用）

仓库：<https://github.com/LeoKemp223/embed-ai-tool> · ★865 · Python · 24 个 skill 分 6 类
**许可边界**：仓库未附 LICENSE，默认保留所有权利。本包不复制其代码与文本；使用前自行确认合规，勿再分发。

| 分类 | Skills | 说明 |
|---|---|---|
| 构建(6) | build-cmake / build-keil / build-iar / build-platformio / build-idf / build-makefile | 六种工具链统一构建入口 |
| 烧录(5) | flash-keil / flash-openocd / flash-jlink / flash-platformio / flash-idf | 对应工具链烧录 |
| 调试(4) | debug-gdb-openocd / debug-jlink / debug-platformio / rtos-debug | GDB 源码级 + RTOS 线程感知（场景专用） |
| 串口(2) | serial-monitor / serial-shell | 监视抓日志 / Shell 交互 |
| 协议(3) | modbus-debug / can-debug / visa-debug | VISA 为仪器测量专用 |
| 分析(4) | memory-analysis / static-analysis / logic-analyzer / workflow | 逻辑分析仪需硬件，均偏专用 |

设计亮点（仅描述思想）：Project Profile 工程画像贯穿全流程；五类失败分类学；`--wait-reset` 先监听后复位模式。

## 两上游重叠与去重结论

Keil/J-Link/OpenOCD/串口/CAN/workflow 双方重叠 → 本包以开源工具链为主线提炼命令速查，商业工具链记录入口。
EAT 独有价值：IAR 支持、RTOS 线程感知、VISA、逻辑分析仪、静态/内存分析（均为专用场景，见 specialized-tools.md）。
ES 独有价值：probe-rs、EIDE、子命令式 CLI、config.json 决策树解析。

## 其他同类项目（未整合，备查）

| 项目 | Stars | 定位 | 不整合原因 |
|---|---|---|---|
| EricSun787/stm32-development-workflow | ★24 | Claude Code STM32 专用 skill | 芯片专用于 STM32+CubeCLT |
| bahaabdelwahed/embedded-claude-plugin | ★5 | 嵌入式工作流 Claude 插件 | 覆盖面窄 |
| qarnet/serial-mcp | ★5 | Rust 串口 MCP server | MCP 形态，按需单独启用 |
| okhsunrog/flashprobe-mcp | ★4 | probe-rs/espflash MCP server | 同上 |
| cunjun/McuBuddy | ★4 | MCP 连真实硬件调试 | 同上 |
