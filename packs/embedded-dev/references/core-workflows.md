# 核心工作流命令速查（core workflows）

开源工具链为主的实战命令。原创提炼，命令均可在 Linux/macOS/Windows(Git Bash) 直接执行。

## 构建

```bash
# GCC+CMake 交叉构建（通用 MCU）
cmake -B build -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j && arm-none-eabi-size build/fw.elf

# 裸 Makefile
make -j$(nproc) 2>&1 | tee build.log    # 失败先看首个 error，后续 error 多为连锁

# PlatformIO
pio run -e <env>                          # 构建指定环境
pio project config                        # 查看解析后的有效配置

# ESP-IDF
idf.py set-target esp32s3 && idf.py build

# Keil UV4（Windows）
UV4 -b project.uvprojx -o build_log.txt -j0
# IAR
IarBuild project.ewp -build Release
```

编译错误处理顺序：第一个 error → 缺头文件查 include path → undefined reference 查链接脚本/源文件列表 → LTO/优化级相关错误关优化复现。

## 烧录

```bash
# OpenOCD：interface + target 两段配置；常见对：
#   ST-Link   -> interface/stlink.cfg        (+ hla_layout)
#   CMSIS-DAP -> interface/cmsis-dap.cfg
openocd -f interface/cmsis-dap.cfg -f target/stm32f4x.cfg \
        -c "program build/fw.elf verify reset exit"

# probe-rs（自动识别芯片）
probe-rs list                             # 枚举探针
probe-rs chip list | grep -i stm32        # 查支持芯片全名
probe-rs download --chip STM32F407VGTx build/fw.elf
probe-rs reset --chip STM32F407VGTx

# J-Link 脚本式烧录 flash.jlink：
#   r
#   h
#   loadfile build/fw.hex
#   r
#   g
#   q
JLinkExe -device STM32F407VG -if SWD -speed 4000 -autoconnect 1 -CommanderScript flash.jlink

# ESP-IDF
idf.py -p /dev/ttyUSB0 flash monitor      # flash+monitor 一条龙
```

烧录失败排查树：探针枚举不到 → 驱动/udev 规则；target 连不上 → SWD 接线/供电/复位脚；flash write protected → `-c "flash_protect off"` 或 option bytes；芯片读保护 → connect under reset 全片擦除。

## 运行观察

```bash
# RTT（probe-rs，推荐，不占串口）
probe-rs attach --chip STM32F407VGTx --log-format "{t} {L} {s}" build/fw.elf

# Semihosting（OpenOCD）
openocd -f ... -c "arm semihosting enable"

# 串口三连（裸命令版）
python3 -m serial.tools.miniterm /dev/ttyUSB0 115200 --eol CRLF
stty -F /dev/ttyUSB0 115200 raw -echo; timeout 15 cat /dev/ttyUSB0 > boot.log
cat boot.log | grep -iE "error|warn|assert|fault|panic|hardfault"

# 先监听后复位（抓早期启动日志）
python3 -m serial.tools.miniterm /dev/ttyUSB0 115200 &
sleep 1 && openocd -f ... -c "init; reset run; shutdown"
```

## GDB 常用会话

```bash
openocd -f interface/cmsis-dap.cfg -f target/stm32f4x.cfg &     # :3333
arm-none-eabi-gdb build/fw.elf \
  -ex "target extended-remote :3333" \
  -ex "monitor reset halt" \
  -ex "break main" -ex "continue" \
  -ex "info registers" -ex "backtrace"
```

HardFault 分析：`info registers` 看 LR/PC → 判断 MSP/PSP 栈 → `x/20wx $sp` 找压栈帧 → 对照 map 文件定位函数。

## CAN / Modbus 快测

```bash
# SocketCAN
sudo ip link set can0 up type can bitrate 500000
candump can0 &            # 监听
cansend can0 123#DEADBEEF # 发送

# Modbus TCP 读保持寄存器（pymodbus）
python3 - <<'EOF'
from pymodbus.client import ModbusTcpClient
c = ModbusTcpClient("192.168.1.10", 502)
c.connect()
print(c.read_holding_registers(0, 10, slave=1).registers)
EOF
```
