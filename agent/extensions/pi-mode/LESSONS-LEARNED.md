# pi-mode 开发经验总结

## 背景

pi-mode 扩展在开发和优化过程中遇到了多个问题。本文档记录这些问题及其解决方案，供后续扩展开发参考。

## 问题与解决方案

### 1. 可选链语法（`?.`）导致扩展加载失败

**现象**：
```
Error: Failed to load extension "/root/.pi/agent/extensions/pi-mode/index.ts":
ParseError: Unexpected token
/root/.pi/agent/extensions/pi-mode/commands.ts:39:6
```

**原因**：pi 的扩展加载器可能不支持 ES2020+ 语法（如可选链 `?.`）。

**解决方案**：
```typescript
// 之前（使用可选链）
description: getModeConfig(name)?.description || '',

// 之后（使用传统语法）
description: (getModeConfig(name) || {}).description || '',
```

**经验**：扩展代码应使用 ES2018 或更低版本的语法，避免使用可选链、空值合并等新特性。

### 2. 模式切换未更新 modes.json

**现象**：使用 `-m light` 启动后，`/mode` 命令仍显示 `full` 模式。

**原因**：`resolve_mode()` 函数只设置了环境变量 `PI_AGENT_MODE`，但没有更新 `modes.json` 的 `current` 字段。pi-mode 扩展会读取 `modes.json` 来确定当前模式。

**解决方案**：在 `pi-wrapper.sh` 的 `resolve_mode()` 函数中添加更新逻辑：
```bash
# 更新 modes.json 的 current 字段（pi-mode 扩展会读取此字段）
node -e "
  const fs = require('fs');
  const modes = JSON.parse(fs.readFileSync('$modes_file', 'utf-8'));
  if (modes.current !== '$mode_name') {
    modes.current = '$mode_name';
    fs.writeFileSync('$modes_file', JSON.stringify(modes, null, 2) + '\n');
  }
" 2>/dev/null
```

**经验**：扩展配置文件的读写必须保持一致。如果多个地方读取同一配置，修改时必须同步更新。

### 3. 扩展排除不生效

**现象**：light 模式下，被排除的扩展仍然加载。

**原因**：`resolve_mode()` 只使用 `--extension <path>` 逐个加载扩展，但没有先用 `--no-extensions` 禁用自动发现。pi 的扩展自动发现机制仍然会加载所有扩展。

**解决方案**：
```bash
# 之前（只逐个加载）
for ext_path in "$ext_dir"/*/; do
  extra_args+=("--extension" "$ext_path")
done

# 之后（先禁用自动发现，再逐个加载）
extra_args+=("--no-extensions")
for ext_path in "$ext_dir"/*/; do
  extra_args+=("--extension" "$ext_path")
done
```

**经验**：使用 `--extension` 时必须配合 `--no-extensions`，否则自动发现机制会覆盖手动指定的扩展列表。

### 4. 非 full 模式仍加载 AGENTS.md

**现象**：light/quick 模式下，系统仍然加载 `AGENTS.md` 和 `CLAUDE.md` 文件。

**原因**：pi 默认会自动发现并加载上下文文件，除非明确禁用。

**解决方案**：在 `pi-wrapper.sh` 中为非 full 模式添加 `--no-context-files` 标志：
```bash
if [ "$mode_name" != "full" ]; then
  extra_args+=("--no-context-files")
fi
```

**经验**：扩展功能可能与其他 pi 特性（如上下文文件加载）产生交互，需要全面考虑配置项的影响。

### 5. TUI 补全列表缺少子命令

**现象**：在 TUI 中输入 `/mode ` 时，只显示模式名称，不显示 `list`、`help` 等子命令。

**原因**：`getArgumentCompletions` 函数只返回模式名称，没有包含子命令。

**解决方案**：
```typescript
// 之前
getArgumentCompletions: () => {
  return listModeNames().map(name => ({ value: name, ... }))
}

// 之后
getArgumentCompletions: (prefix) => {
  const first = (prefix?.trim().split(/\s+/)[0] ?? "").toLowerCase()
  const items = [
    { value: 'list', label: 'list', description: '列出所有可用模式' },
    { value: 'help', label: 'help', description: '显示帮助信息' },
    ...listModeNames().map(name => ({ value: name, ... }))
  ]
  if (!prefix?.includes(' ')) {
    return items.filter(i => i.value.startsWith(first))
  }
  return items
}
```

**经验**：`getArgumentCompletions` 应该返回完整的子命令列表，而不仅仅是参数值。参考 `pi-context` 扩展的实现。

### 6. 扩展禁用后无法恢复

**现象**：自动修复系统会临时禁用崩溃的扩展（重命名 `index.ts` → `index.ts.disabled`），但恢复后不会重新启用。

**原因**：`disable_extension()` 函数只负责禁用，没有对应的重新启用逻辑。

**解决方案**：添加 `reenable_disabled_extensions()` 函数，在成功启动后调用：
```bash
reenable_disabled_extensions() {
  for ext_dir in "$HOME/.pi/agent/extensions"/*/; do
    if [ -f "$ext_dir/index.ts.disabled" ] && [ ! -f "$ext_dir/index.ts" ]; then
      mv "$ext_dir/index.ts.disabled" "$ext_dir/index.ts"
    fi
  done
}
```

**经验**：临时禁用机制必须有对应的恢复机制，否则会导致扩展永久丢失。

## 最佳实践

### 语法兼容性
- 使用 ES2018 或更低版本的语法
- 避免可选链（`?.`）、空值合并（`??`）、私有字段（`#`）等新特性
- 在目标 Node.js 版本上测试扩展加载

### 配置管理
- 扩展配置文件的读写必须保持一致
- 多个读取方必须同步更新配置
- 使用环境变量传递临时状态（如 `PI_AGENT_MODE`）

### 扩展加载
- 使用 `--extension` 时必须配合 `--no-extensions`
- 显式指定扩展路径比依赖自动发现更可靠
- 测试扩展加载时检查 `--help` 输出确认支持的标志

### TUI 集成
- `getArgumentCompletions` 应返回完整的子命令列表
- 参考其他扩展的实现（如 `pi-context`）
- 测试 TUI 补全时输入命令后按 Tab 键

### 错误处理
- 临时禁用扩展时必须有恢复机制
- 自动修复系统应记录禁用原因
- 成功启动后重新启用被禁用的扩展

## 测试清单

开发新扩展时，检查以下项目：

- [ ] 扩展能在目标 Node.js 版本上加载
- [ ] 命令注册正确，TUI 补全显示完整
- [ ] 配置文件读写一致
- [ ] 与其他扩展无冲突
- [ ] 错误处理完善，不会导致 pi 崩溃
- [ ] 临时禁用后能自动恢复

## 相关文件

- `~/.pi/scripts/pi-wrapper.sh` - 生命周期管理、模式解析
- `~/.pi/agent/extensions/pi-mode/commands.ts` - 命令处理
- `~/.pi/agent/extensions/pi-mode/config.ts` - 配置读写
- `~/.pi/agent/modes.json` - 模式配置文件
