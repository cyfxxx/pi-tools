# Pi 救援模式

Pi 救援模式是一套冗余安全措施，用于在 Pi 进行自我修改和优化时发生崩溃或重启失败的情况下，自动或手动恢复系统。

## 概述

当 Pi 在进行自我修改和优化时，可能会因为代码修改错误、配置文件损坏等原因导致崩溃。救援模式提供了多层次的恢复机制：

1. **自动快照**：每次启动前自动保存当前状态
2. **配置恢复**：崩溃时自动从快照或 git 恢复配置
3. **救援模式 pi**：多次崩溃后启动最小化的 pi 程序来修复问题

## 自动恢复流程

```
崩溃 1-2 次: 等待用户手动处理
崩溃 3-4 次: 回滚 lastGood 模型（现有逻辑）
崩溃 5-6 次: 自动恢复配置文件（快照 → git）
崩溃 7+ 次: 启动救援模式 pi
```

## 文件结构

```
~/.pi/
├── agent/
│   ├── rescue/
│   │   ├── rescue-config.json    # 救援模式配置
│   │   └── rescue-prompt.md      # 救援模式提示词
│   └── .pi-autopilot-crash.json  # 崩溃计数
├── .snapshots/                   # 快照目录
│   └── snapshot_YYYYMMDD_HHMMSS/
│       ├── settings.json         # 配置快照
│       ├── modes.json            # 模式配置快照
│       ├── extensions.list       # 扩展列表快照
│       ├── git-commit            # git 提交哈希
│       └── git-status            # git 状态
└── scripts/
    ├── pi-wrapper.sh             # 启动脚本（已增强）
    ├── pi-snapshot.sh            # 快照管理脚本
    └── pi-rescue.sh              # 手动救援脚本
```

## 救援模式 pi

救援模式 pi 是一个最小化的 pi 实例，具有以下特点：

- **无扩展**：不加载任何扩展，避免扩展问题导致崩溃
- **无技能**：不加载任何技能，减少潜在问题
- **专用提示词**：告诉 pi 它的职责是修复主程序问题
- **低思考级别**：使用 low 思考级别，快速响应

### 启动救援模式 pi

**自动启动**：
当连续崩溃达到 7 次时，pi-wrapper.sh 会自动启动救援模式 pi。

**手动启动**：
```bash
# 使用救援脚本
bash ~/.pi/scripts/pi-rescue.sh

# 或直接启动
node ~/.pi/agent/node_modules/.bin/pi \
  --no-extensions \
  --no-skills \
  --append-system-prompt ~/.pi/agent/rescue/rescue-prompt.md
```

### 救援模式 pi 的职责

1. **诊断问题**：分析崩溃日志和错误信息
2. **修复配置**：恢复损坏的配置文件
3. **恢复代码**：如果扩展代码被修改导致崩溃，恢复到正常状态
4. **验证修复**：确保修复后主程序可以正常启动

## 快照管理

### 自动快照

每次 pi 启动前会自动创建快照，保存以下内容：
- `settings.json`：主配置文件
- `modes.json`：模式配置
- 扩展列表
- git 状态

### 手动快照管理

使用 `pi-snapshot.sh` 脚本：

```bash
# 创建快照
bash ~/.pi/scripts/pi-snapshot.sh create

# 列出快照
bash ~/.pi/scripts/pi-snapshot.sh list

# 恢复快照
bash ~/.pi/scripts/pi-snapshot.sh restore <snapshot-path>
```

## 手动救援

使用 `pi-rescue.sh` 脚本进行手动救援：

```bash
bash ~/.pi/scripts/pi-rescue.sh
```

菜单选项：
1. 查看崩溃日志
2. 恢复配置文件
3. 恢复到快照
4. 重新安装依赖
5. 重新运行 rebuild
6. 启动救援模式 pi
7. 退出

## 配置

### 救援阈值

在 `pi-wrapper.sh` 中配置：

```bash
CRASH_THRESHOLD=3        # 回滚 lastGood 模型
RESCUE_THRESHOLD=5       # 恢复配置文件
RESCUE_PI_THRESHOLD=7    # 启动救援模式 pi
```

### 救援配置

救援配置文件位于 `~/.pi/agent/rescue/rescue-config.json`：

```json
{
  "description": "救援模式配置 - 用于修复主程序崩溃问题",
  "extensions": [],
  "skills": [],
  "systemPrompt": null,
  "appendSystemPrompt": "~/.pi/agent/rescue/rescue-prompt.md",
  "thinking": "low"
}
```

## 使用场景

### 场景 1：扩展修改导致崩溃

1. 用户修改了某个扩展的代码
2. pi 启动后崩溃
3. 连续崩溃 3 次后回滚 lastGood 模型
4. 如果仍崩溃，连续崩溃 5 次后自动恢复配置
5. 如果还崩溃，连续崩溃 7 次后启动救援模式 pi
6. 在救援模式 pi 中修复扩展代码
7. 重启主 pi

### 场景 2：配置文件损坏

1. 用户手动修改 settings.json 导致格式错误
2. pi 启动后崩溃
3. 自动从快照恢复 settings.json
4. 重启 pi

### 场景 3：自我修改失败

1. pi 自动优化代码时修改错误
2. 重启后崩溃
3. 自动从 git 恢复配置
4. 如果 git 恢复失败，启动救援模式 pi
5. 在救援模式 pi 中修复代码

## 注意事项

1. **快照保留**：默认保留最近 10 个快照，旧快照会自动清理
2. **git 恢复**：只恢复配置文件，不恢复扩展代码
3. **救援模式 pi**：不保存会话，退出后需要手动重启主 pi
4. **版本兼容**：救援模式 pi 使用当前安装的 pi 版本，确保兼容性

## 与现有机制的关系

救援模式与现有的崩溃恢复机制是互补的：

- **现有机制**：回滚 lastGood 模型（3 次崩溃）
- **救援模式**：恢复配置文件（5 次崩溃）+ 启动最小化 pi（7 次崩溃）

这种分层设计确保了在不同严重程度的问题下都有对应的恢复措施。
