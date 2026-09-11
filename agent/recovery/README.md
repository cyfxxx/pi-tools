# Pi 救援模式

Pi 救援模式是一套智能崩溃分析与多层冗余恢复系统，在 Pi 自我修改或运行时发生崩溃时，自动分析原因并选择最合适的恢复策略。

## 概述

系统由三个核心组件协作：

1. **崩溃分析器** (`pi-crash-analyzer.sh`)：分析 stderr 输出，分类崩溃类型
2. **审计日志** (`pi-recovery-audit.sh`)：记录每次恢复的完整上下文
3. **智能路由器** (`pi-wrapper.sh`)：根据崩溃类型选择恢复策略

## 恢复层级（新逻辑）

新逻辑下，wrapper 不再按"崩溃类型→固定动作"的旧表格分派，而是先分类再启动修复 pi：

| 分类 | 判据 | 动作 |
|---|---|---|
| `transient` | API 5xx/429、网络超时、ECONNREFUSED 等 | 指数退避重试，不修复 |
| `external` | pi 核心正常，外部因素（扩展/配置/依赖/权限/磁盘） | 启动当前 pi（`--no-extensions --no-skills`）作为修复者，让它读崩溃日志并自行修复外部问题 |
| `pi_self` | pi 核心自身损坏（dist 语法错误/缺失/依赖不匹配） | 启动源码缓存的 pi 作为修复者，让它修复坏的 pi |

wrapper 只负责检查、分类、启动修复进程；实际修复操作由 pi 自身完成（要么用当前 pi 修外部问题，要么用源码缓存的 pi 修坏的 pi）。这样既避免了脚本误修复，又让用户能在 TUI 中看到修复过程。

如果新逻辑的修复 pi 失败，wrapper 会回退到原有的细粒度恢复链（见下表）。

### 旧恢复层级（作为回退）

| 层级 | 触发条件 | 恢复动作 |
|---|---|---|
| **L1** | 崩溃 1-2 次 | 重试累积，不干预 |
| **L2** | 崩溃 3+ 次 | 根据崩溃类型执行对应恢复（npm install / rebuild / 禁用扩展 / 恢复配置 / 清除代理 / kill 竞争 / 切换模型） |
| **L3** | 崩溃 7+ 次 / 同类型连续失败 | 启动救援模式 pi（有完整工具能力，自动诊断+修复） |
| **L4** | npm pi 损坏 / L3 失败 | 从本地源码缓存恢复（预编译 dist 覆盖 npm 安装 + 同步依赖） |

```
pi 崩溃
  ↓
[1] 捕获 stderr 到临时文件
  ↓
[2] 分析器识别崩溃类型
  ↓
[3] 同类型连续失败？ → 是：升级策略
  ↓
[4] 根据类型执行对应恢复
  ↓
[5] 健康检查（完整启动测试）
  ↓
[6] 成功 → 重启 / 失败 → 停止
```

## 崩溃类型与恢复策略

新分类体系（wrapper 先分类，再决定动作）：

| 类型 | 识别模式 | 恢复动作 |
|---|---|---|
| `transient` | `50[0-9]` / `429` / `ECONNREFUSED` / `ETIMEDOUT` / `socket hang up` / `rate.limit` / `stream interrupted` / `timeout.*exceeded` | 指数退避重试，不修复 |
| `external` | 扩展/配置/依赖/权限/磁盘导致的崩溃（pi 核心正常） | 启动当前 pi（`--no-extensions --no-skills`）读崩溃日志并自行修复外部问题 |
| `pi_self` | 错误明确指向 `pi-coding-agent/dist/`（含 `SyntaxError` / `ParseError` / `does not provide an export named` / `ERR_MODULE_NOT_FOUND`） | 启动源码缓存的 pi 修复坏的 pi |

旧分类体系（作为回退，仍在 `pi-crash-analyzer.sh` 中保留）：

| 类型 | 识别模式 | 恢复动作 |
|---|---|---|
| `missing_module` | `ERR_MODULE_NOT_FOUND` | 重装 npm 依赖 |
| `syntax_error` | `SyntaxError` (本地文件上下文) | rebuild 恢复补丁 |
| `extension_fail` | `Failed to load extension` | 临时禁用问题扩展（先 `node --check` 飞行校验，源码有语法错误就不禁用） |
| `config_corrupt` | settings.json 相关错误 | 从快照恢复配置 |
| `proxy_error` | `Invalid URL protocol` / socks | 清除代理环境变量 |
| `lock_contention` | `EADDRINUSE` / `无法获取调度锁` | kill 竞争实例 |
| `provider_error` | `502` / `503` / `429` / `server_error` | 切换 lastGood 模型 |
| `node_compat` | `ERR_MODULE_NOT_FOUND` for `node:` 前缀 | 升级 Node.js |
| `cli_argument_error` | `Unknown option` / `unknown flag` | 自动修复参数 |
| `network_error` | `ECONNREFUSED` / `ETIMEDOUT` / DNS | 指数退避重试 |
| `permission_error` | `EACCES` / `permission denied` | 修复文件权限 |
| `oom_error` | `JavaScript heap out of memory` | 清理内存 / 增加限制 |
| `disk_full` | `ENOSPC` / `No space left on device` | 清理磁盘空间 |
| `timeout_error` | 进程超时 / 挂死 | 强制终止并重启 |
| `unknown` | 以上均不匹配 | 累积计数，达阈值升级 |

## 防越修越坏机制

1. **同类型连续失败检测**：检查最近 3 条审计记录，同类型失败 2 次 → 跳过该策略，升级到下一层
2. **恢复前自动快照**：每次恢复前自动创建快照
3. **恢复后健康检查**：完整启动测试（非交互式 prompt 响应）
4. **审计日志**：记录每次恢复的完整上下文（类型、摘要、动作、结果、耗时）
5. **最大恢复轮数**：单次启动最多 5 轮恢复循环，超出后停止并记录
6. **版本验证**：L4 恢复前对比缓存版本与 npm 版本

## 文件结构

```
~/.pi/
├── agent/recovery/
│   ├── rescue-config.json      # 救援模式配置
│   ├── rescue-prompt.md        # 救援模式提示词（含工具使用指令）
│   ├── README.md               # 本文档
│   ├── source/                 # L4: git clone 源码（depth=1）
│   └── cache/                  # L4: 预编译产物
│       ├── version.json        # 版本信息
│       ├── dist/               # coding-agent 编译产物
│       ├── npm-shrinkwrap.json # 依赖锁定
│       └── package.json        # 包描述
├── logs/
│   └── recovery-audit.jsonl    # 恢复审计日志（JSONL 格式）
├── .snapshots/                 # 快照目录
└── scripts/
    ├── pi-wrapper.sh           # 启动脚本（智能恢复核心）
    ├── crash-recovery/
    │   ├── pi-crash-analyzer.sh    # 崩溃类型分析器
    │   ├── pi-recovery-audit.sh    # 审计日志模块
    │   └── pi-rescue.sh            # 手动救援脚本
    ├── pi-source-build.sh      # L4: 源码编译脚本
    └── test/
        └── test-recovery.sh    # 冗余系统测试套件
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
1. `pi --version`（10s 超时）— 验证 Node 可执行 + 入口文件存在
2. `pi --no-extensions --no-skills --no-session -p 'Say exactly: ok'`（30s 超时）— 完整模块加载测试

两项均通过才认为恢复成功。

## 救援模式

当 L4 源码恢复也失败时，启动救援模式 pi：

- **核心工具可用**：bash、read、write、edit 等内置工具
- **自动接收崩溃日志路径**：直接分析问题
- **提示词要求动手修复**：执行修复命令，不是只给建议
- **自动验证修复结果**

救援模式 pi 可以执行的操作：
- 读取崩溃日志分析原因
- 恢复损坏的配置文件（git checkout）
- 重装依赖（npm install）
- 同步 L4 源码恢复的依赖
- 禁用问题扩展
- 验证修复结果

## 手动操作

### 查看崩溃分析
```bash
# 分析指定日志文件
bash ~/.pi/scripts/crash-recovery/pi-crash-analyzer.sh /tmp/pi-crash-xxx.log

# 查看恢复审计日志
tail -10 ~/.pi/logs/recovery-audit.jsonl | python3 -m json.tool
```

### 手动救援
```bash
bash ~/.pi/scripts/crash-recovery/pi-rescue.sh
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
cat ~/.pi/agent/recovery/cache/version.json | python3 -m json.tool
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

1. 同一崩溃类型连续失败
2. 系统跳过该策略，升级到 L4 源码恢复
3. 如果 L4 也失败 → 启动救援模式 pi（有完整工具能力，自动修复）
4. 如果救援模式也失败 → 记录日志，停止恢复

### 场景 5：npm pi 完全损坏（L4 源码恢复）

1. npm 安装的 pi 因磁盘损坏/误删/版本冲突完全不可用
2. L2 的 `recover_missing_module`（npm install）也失败
3. 自动触发 L4：检查 `agent/recovery/cache/` 预编译缓存
4. 有缓存 → 覆盖 npm dist + 同步源码 node_modules 依赖
5. 无缓存 → 尝试实时构建（clone + build + bundle）
6. 健康检查通过 → 重启成功

### 场景 6：dist 损坏 + 依赖版本不匹配（本次修复）

1. 源码构建的 dist 引用 `@earendil-works/pi-tui` 新 API
2. npm 安装的嵌套 `node_modules/pi-tui` 是旧版本
3. L4 恢复时自动同步源码 `node_modules` 到 npm 目录
4. 健康检查通过 → 重启成功

## 测试

```bash
# 运行完整测试套件
bash /tmp/test-recovery.sh

# 测试崩溃分析器
echo 'ERR_MODULE_NOT_FOUND: test' > /tmp/test.log
bash ~/.pi/scripts/crash-recovery/pi-crash-analyzer.sh /tmp/test.log

# 查看测试结果
cat ~/.pi/logs/recovery-audit.jsonl | tail -5
```
