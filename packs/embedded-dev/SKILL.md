---
name: embedded-dev
description: 嵌入式/MCU 开发的 AI 辅助技能入口：构建、烧录、调试、串口、协议测试的领域地图与工具链路由，含上游技能集目录与专用工具索引。做嵌入式固件开发、烧录调试、硬件联测时使用。
---

# embedded-dev：嵌入式开发 AI 技能整合包

整合自两个上游开源技能集的通用能力，去重后形成统一领域地图。本包是**知识层**（路由 + 决策原则 + 命令速查），完整可执行脚本按需从上游获取（见 `references/upstream-catalog.md`）。

## 何时使用

- 编译/烧录 MCU 固件（Keil / IAR / GCC+CMake / PlatformIO / ESP-IDF / Makefile）
- OpenOCD / J-Link / probe-rs 烧录调试、GDB 源码级调试
- 串口监视抓日志、RTT/Semihosting 输出捕获
- Modbus / CAN 总线调试
- 需要判断"该用哪个工具链/哪个上游 skill"时

## 领域路由表

| 任务 | 开源工具链（优先） | 商业 IDE 工具链 | 上游参考 |
|---|---|---|---|
| 构建 | gcc/cmake/makefile, PlatformIO, ESP-IDF | Keil UV4 CLI, IAR IarBuild | upstream-catalog §构建 |
| 烧录 | openocd（ST-Link/CMSIS-DAP/DAPLink）, probe-rs, esptool | J-Link Commander, Keil 内置 | upstream-catalog §烧录 |
| 调试 | gdb + openocd gdb-server, probe-rs, RTT | J-Link GDB Server, Semihosting | upstream-catalog §调试 |
| 观察 | serial(pyserial), RTT, ITM/SWO | 同左 | upstream-catalog §观察 |
| 协议 | python-can, pymodbus | Vector/VISA 仪器（专用） | upstream-catalog §协议 |

选型决策：目标芯片支持开源探针 → openocd/probe-rs；仅厂商授权调试器 → 对应商业工具；多工具链工程 → workflow 编排（见 core-workflows.md）。

## 执行闭环（证据驱动）

```
需求 → 读工程画像 → 构建 → 失败?修编译错
     → 烧录 → 失败?查连接/复位/保护位
     → 运行时观察(串口/RTT/寄存器) → 证据匹配预期?
     → 否: 诊断→补丁→重建复烧   是: 完成
```

每一级证据独立确认：代码级（文件已改）≠ 构建级（编译通过）≠ 运行级（硬件行为符合预期）。向用户汇报时注明当前处于哪一级。

## 关键设计原则（提炼自两上游的共同精华）

1. **探测优先级固定**：显式用户输入 > 工程 Profile > 自动检测 > 列出候选并询问。禁止静默猜测。
2. **失败分类先行**：`environment-missing`（依赖未装）/ `connection-failure`（设备打不开）/ `permission-problem`（无权限，如 dialout 组）/ `ambiguous-context`（多个合理候选冲突）/ `target-response-abnormal`（连上了但行为异常）。先归类再处理，不同类不同动作。
3. **写回 Profile**：每次确认的端口/波特率/芯片型号/工具链路径写回工程配置，下游步骤直接复用，避免重复探测。
4. **早期启动日志**：怕错过 boot 输出时用"先监听后复位"模式，不要事后重跑。
5. **Windows 注意**：COM 口名带引号传 shell；路径反斜杠转义；驱动缺失时先装 CH340/CP210x 驱动再排查。

## 快速命令速查

```bash
# 探针与串口探测
ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null; openocd -f interface/cmsis-dap.cfg -f target/stm32f1x.cfg -c "init; targets; shutdown"
probe-rs list                          # probe-rs 探针枚举

# 烧录（三选一）
openocd -f <cfg...> -c "program fw.elf verify reset exit"
probe-rs download --chip STM32F103C8 fw.elf && probe-rs reset --chip STM32F103C8
JLinkExe -device STM32F103C8 -if SWD -speed 4000 -CommanderScript flash.jlink

# GDB 调试会话
openocd -f <cfg...> &   # gdb-port 3333
arm-none-eabi-gdb fw.elf -ex "target extended-remote :3333" -ex "monitor reset halt" -ex "b main" -ex "c"

# 串口监视（无上游脚本时的裸命令）
python3 -m serial.tools.miniterm /dev/ttyUSB0 115200
stty -F /dev/ttyUSB0 115200 raw -echo && timeout 10 cat /dev/ttyUSB0 | tee run.log
```

Linux 串口权限：`sudo usermod -aG dialout $USER` 后重新插拔。

## 完整能力启用

本包只含知识层。需要可执行脚本级能力时：

```bash
# MIT 许可，可直接克隆使用（12 个子命令式 skill，config.json 配置体系）
git clone https://github.com/zhinkgit/embeddedskills.git ~/.pi/packs/upstream/embeddedskills

# 无 LICENSE，默认版权保留：仅个人学习使用，勿复制分发；克隆前确认用途合规
git clone https://github.com/LeoKemp223/embed-ai-tool.git ~/.pi/packs/upstream/embed-ai-tool
```

详细对照（36 个上游 skill 的功能清单与本包映射）：`references/upstream-catalog.md`
核心工作流详解：`references/core-workflows.md`
专用工具索引（PID 调参/垂直 agent/on-MCU agent 等）：`references/specialized-tools.md`

## 许可与来源

- 整合提炼基于 [zhinkgit/embeddedskills](https://github.com/zhinkgit/embeddedskills)（MIT）与 [LeoKemp223/embed-ai-tool](https://github.com/LeoKemp223/embed-ai-tool)（无 LICENSE，仅记录引用）的设计思想与公开文档描述，本文档为原创提炼，未复制上游受版权保护的代码或文本
- 上游清单与许可边界见 `references/upstream-catalog.md`

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（无则建；工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件正文并清条目。
