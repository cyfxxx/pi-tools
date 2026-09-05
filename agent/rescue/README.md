# Pi 救援模式

Pi 救援模式是一套智能崩溃分析与多层冗余恢复系统，在 Pi 自我修改或运行时发生崩溃时，自动分析原因并选择最合适的恢复策略。

## 概述

系统由三个核心组件协作：

1. **崩溃分析器** (`pi-crash-analyzer.sh`)：分析 stderr 输出，分类崩溃类型
2. **审计日志** (`pi-recovery-audit.sh`)：记录每次恢复的完整上下文
3. **智能路由器** (`pi-wrapper.sh`)：根据崩溃类型选择恢复策略

## 恢复层级

| 层级 | 触发条件 | 恢复动作 |
|---|---|---|
| **L1** | 崩溃 1-2 次 | 重试累积，不干预 |
| **L2** | 崩溃 3+ 次 | 根据崩溃类型执行对应恢复（npm install / rebuild / 禁用扩展 / 恢复配置 / 清除代理 / kill 竞争 / 切换模型） |
| **L3** | 崩溃 7+ 次 / 同类型连续失败 2 次 | 启动救援模式 pi（最小化配置，修复问题） |
| **L4** | npm pi 损坏 / L3 失败 | 从本地源码缓存恢复（预编译 dist 覆盖 npm 安装） |

```
pi 崩溃
  ↓
[1] 捕获 stderr 到临时文件
  ↓
[2] 分析器识别崩溃类型
  ↓
[3] 同类型连续失败 2 次？ → 是：升级策略
  ↓
[4] 根据类型执行对应恢复
  ↓
[5] 健康检查（pi --version + 最小化启动）
  ↓
[6] 成功 → 重启 / 失败 → 停止
```

## 崩溃类型与恢复策略

| 类型 | 识别模式 | 恢复动作 |
|---|---|---|
| `missing_module` | `ERR_MODULE_NOT_FOUND` | 重装 npm 依赖 |
| `syntax_error` | `SyntaxError: Invalid or unexpected token` | rebuild 恢复补丁 |
| `extension_fail` | `Failed to load extension` | 临时禁用问题扩展 |
| `config_corrupt` | `JSON.parse` / settings 错误 | 从快照恢复配置 |
| `proxy_error` | `Invalid URL protocol` / socks | 清除代理环境变量 |
| `lock_contention` | `无法获取调度锁` | kill 竞争实例 |
| `provider_error` | `503` / `server_error` | 切换 lastGood 模型 |
| `node_compat` | `ERR_MODULE_NOT_FOUND` for `node:` 前缀 | 升级 Node.js |
| `unknown` | 以上均不匹配 | 累积计数，达阈值升级 |

## 防越修越坏机制

1. **同类型连续失败检测**：同一崩溃类型连续失败 2 次 → 跳过该策略，升级到下一层
2. **恢复前自动快照**：每次恢复前自动创建快照
3. **恢复后健康检查**：`pi --version` + 最小化启动测试
4. **审计日志**：记录每次恢复的完整上下文（类型、摘要、动作、结果、耗时）
5. **最大恢复轮数**：单次启动最多 5 轮恢复循环，超出后停止并记录

## 文件结构

```
~/.pi/
├── agent/rescue/
│   ├── rescue-config.json      # 救援模式配置
│   ├── rescue-prompt.md        # 救援模式提示词
│   └── README.md               # 本文档
├── logs/
│   └── recovery-audit.jsonl    # 恢复审计日志（JSONL 格式）
├── .snapshots/                 # 快照目录
├── pi-source/                  # L4: git clone 源码（depth=1）
├── pi-source-cache/            # L4: 预编译产物
│   ├── version.json            # 版本信息
│   ├── dist/                   # coding-agent 编译产物
│   ├── npm-shrinkwrap.json     # 依赖锁定
│   └── package.json            # 包描述
└── scripts/
    ├── pi-wrapper.sh           # 启动脚本（智能恢复核心）
    ├── pi-crash-analyzer.sh    # 崩溃类型分析器
    ├── pi-recovery-audit.sh    # 审计日志模块
    ├── pi-source-build.sh      # L4: 源码编译脚本
    ├── pi-snapshot.sh          # 快照管理脚本
    └── pi-rescue.sh            # 手动救援脚本
```

## 审计日志格式

每次恢复操作写入 `~/.pi/logs/recovery-audit.jsonl`：

```json
{
  "ts": 1788592001983,
  "crashCount": 3,
  "exitCode": 1,
  "crashType": "missing_module",
  "snippet": "Cannot find package '@earendil-works/pi-server'",
  "action": "npm_install",
  "success": true,
  "consecutiveFail": false,
  "durationMs": 103,
  "detail": "installed 101 packages"
}
```

查看最近恢复记录：
```bash
tail -5 ~/.pi/logs/recovery-audit.jsonl | python3 -m json.tool
```

## 健康检查

恢复后自动执行：
1. `pi --version`（10s 超时）
2. `pi --no-extensions --no-skills --no-session -p '{"ok":true}'`（20s 超时）

两项均通过才认为恢复成功。

## 手动操作

### 查看崩溃分析
```bash
# 分析指定日志文件
bash ~/.pi/scripts/pi-crash-analyzer.sh /tmp/pi-crash-xxx.log

# 查看恢复审计日志
tail -10 ~/.pi/logs/recovery-audit.jsonl | python3 -m json.tool
```

### 手动救援
```bash
bash ~/.pi/scripts/pi-rescue.sh
```

### 查看快照
```bash
bash ~/.pi/scripts/pi-snapshot.sh list
```

### 手动构建 L4 缓存
```bash
# 首次构建（clone + build + bundle）
bash ~/.pi/scripts/pi-source-build.sh

# 强制重建（即使缓存已存在）
bash ~/.pi/scripts/pi-source-build.sh --force

# 不使用代理构建
bash ~/.pi/scripts/pi-source-build.sh --no-proxy
```

### 查看 L4 缓存状态
```bash
cat ~/.pi/pi-source-cache/version.json | python3 -m json.tool
```

### 手动构建 L4 缓存
```bash
# 首次构建（clone + build + bundle）
bash ~/.pi/scripts/pi-source-build.sh

# 强制重建（即使缓存已存在）
bash ~/.pi/scripts/pi-source-build.sh --force

# 不使用代理构建
bash ~/.pi/scripts/pi-source-build.sh --no-proxy
```

### 查看 L4 缓存状态
```bash
cat ~/.pi/pi-source-cache/version.json | python3 -m json.tool
```

## 配置

### 阈值

```bash
CRASH_THRESHOLD=3           # 未达此值时重试累积
RESCUE_PI_THRESHOLD=7       # 救援模式 pi 阈值
MAX_RECOVERY_ROUNDS=5       # 单次启动最大恢复轮数
CRASH_WINDOW_MS=86400000    # 崩溃计数时间窗（24h）
```

## 使用场景

### 场景 1：npm 包损坏（missing_module）

1. pi 因缺少 `@earendil-works/pi-server` 崩溃
2. 分析器识别为 `missing_module`
3. 自动执行 `npm install` 重装依赖
4. 健康检查通过 → 重启成功

### 场景 2：扩展修改导致崩溃（extension_fail）

1. 用户修改扩展代码后 pi 崩溃
2. 分析器识别为 `extension_fail`，提取扩展名
3. 自动临时禁用问题扩展（`index.ts → index.ts.disabled`）
4. 健康检查通过 → 重启，可在救援模式中修复扩展

### 场景 3：配置文件损坏（config_corrupt）

1. settings.json 格式错误导致崩溃
2. 分析器识别为 `config_corrupt`
3. 自动从快照恢复配置
4. 健康检查通过 → 重启成功

### 场景 4：连续失败升级

1. 同一崩溃类型连续失败 2 次
2. 系统跳过该策略，升级到 L4 源码恢复
3. 如果 L4 也失败 → 启动救援模式 pi
4. 如果救援模式也失败 → 记录日志，停止恢复

### 场景 5：npm pi 完全损坏（L4 源码恢复）

1. npm 安装的 pi 因磁盘损坏/误删/版本冲突完全不可用
2. L2 的 `recover_missing_module`（npm install）也失败
3. 自动触发 L4：检查 `pi-source-cache/` 预编译缓存
4. 有缓存 → 直接覆盖 npm 安装的 dist 目录
5. 无缓存 → 尝试实时构建（clone + build + bundle）
6. 健康检查通过 → 重启成功
