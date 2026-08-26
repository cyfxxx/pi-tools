# 核心工作流命令速查（core workflows）

KiCad 8/9 CLI 为主。原创提炼。Flatpak 安装时前缀 `flatpak run --command=kicad-cli org.kicad.KiCad`。

## 设计规则检查

```bash
# ERC（电气规则）—— 只报错误级，快速过闸
kicad-cli sch erc project.kicad_sch --severity-error --output erc.rpt && cat erc.rpt

# DRC（设计规则）—— 全量含警告
kicad-cli pcb drc project.kicad_pcb --severity-all --output drc.rpt && cat drc.rpt
```

DRC 高频违例处理顺序：clearance 不足 → 查规则约束区/差分对设置；unconnected items → 补线或放过孔；silk over pad → 移丝印或让厂家裁剪；hole clearance → 换封装或确认工艺能力。

## 网表一致性（原理图 ↔ PCB）

```bash
kicad-cli sch export netlist project.kicad_sch -o ref.net
python3 - <<'EOF'
# 提取 PCB 内嵌网表做对比（s-expression 解析）
import re, json
pcb = open("project.kicad_pcb").read()
nets = set(re.findall(r'\(net\s+\d+\s+"([^"]+)"\)', pcb))
ref = open("ref.net").read()
sch_nets = set(re.findall(r'\(net\s+\(code[^)]*\)\(name\s+"([^"]+)"\)', ref))
print("仅原理图有:", sorted(sch_nets - nets - {""}))
print("仅PCB有:", sorted(nets - sch_nets - {""}))
EOF
```

## 制造交付检查

```bash
# Gerber + 钻孔导出
kicad-cli pcb export gerbers project.kicad_pcb -o fab/ --drill --map gerber --glue

# gerbonara 解析自检（pip install gerbonara）
python3 - <<'EOF'
from gerbonara import LayerStack
ls = LayerStack.open("fab")
print("板层:", [l for l in ls.graphic_layers()])
bb = ls.bounding_box()
print(f"板框: {(bb[1].x-bb[0].x):.1f} x {(bb[1].y-bb[0].y):.1f} mm")
EOF

# BOM 导出（MPN 字段是供应链核验的关键）
kicad-cli sch export bom project.kicad_sch -o bom.csv \
  --fields "Reference,Value,Footprint,${QUANTITY}@DNP,MPN,Manufacturer"
```

下单前核对清单：层叠数与厂家能力匹配、最小线宽/间距≥工艺极限、钻孔表完整、丝印可读、拼板方式、阻抗控制需求是否声明。

## SPICE 子电路快验

```bash
# ngspice 批模式跑 RC 滤波器测试台
cat > tb_rc.cir <<'EOF'
RC lowpass check
V1 in 0 AC 1
R1 in out 10k
C1 out 0 100n
.control
ac dec 20 1 10Meg
let mag = db(v(out))
meas ac fc when mag=-3
.endc
.end
EOF
ngspice -b tb_rc.cir 2>&1 | grep -iE "fc|fail"
# 期望截止频率 ≈ 1/(2π·10k·100n) ≈ 159 Hz，偏差>10% 查取值
```

适用子电路类型：RC/LC 滤波器、分压器、运放增益级、LC 谐振、晶振负载电容。装了 LTspice/Xyce 时 kicad-happy 的 spice skill 可自动检测并生成测试台。

## EMC 快查视角（无脚本时的手工要点）

按风险优先级：地平面完整性（分割/开槽跨走线）→ 去耦电容距离与容值组合 → 晶振/时钟线包地与长度 → 开关电源回路面积 → 连接器 I/O 滤波 → 板边辐射（高速线距边缘 ≥3H）。正式预合规测试计划生成用 kicad-happy `emc` skill。

## SKiDL 起步（代码定义电路）

```python
from skidl import *
import skidl

mcu = Part("MCU_Microchip_ATmega", "ATmega328P-AU", footprint="Package_QFP:TQFP-32_7x7mm_P0.8mm")
cap = Part("Device", "C", value="100nF", footprint="Capacitor_SMD:C_0402_1005Metric")
vcc, gnd = Net("VCC"), Net("GND")
mcu["VCC"][0] += vcc; mcu["GND"][0] += gnd; cap[1] += vcc; cap[2] += gnd

ERC()                          # 电气规则检查
generate_netlist()             # 输出网表供 KiCad pcbnew 布局
```

工作流：SKiDL 定义连接关系 → generate_netlist → KiCad 导入网表做 Layout → 改动只回 SKiDL 源码重新生成，原理图永不手改。
