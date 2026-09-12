# 常见问题

> 收集用户常见问题和简短回答，便于快速查阅。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 更新日期 | 2026-09-12 |
| 适用范围 | Pi 使用常见问题 |
| 相关文档 | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md), [README.md](../README.md) |

---

## 目录

- [一、安装与配置](#一安装与配置)
- [二、使用问题](#二使用问题)
- [三、扩展相关](#三扩展相关)
- [四、数据与备份](#四数据与备份)
- [五、性能优化](#五性能优化)

---

## 一、安装与配置

### Q: 如何安装 Pi？

```bash
git clone https://github.com/cyfxxx/pi-tools.git ~/.pi
cd ~/.pi && bash scripts/rebuild.sh --yes
```

详见 [README.md](../README.md) → 新设备恢复引导

### Q: 如何更新 Pi？

```bash
cd ~/.pi && git pull origin master
bash scripts/rebuild.sh --yes
```

### Q: 如何配置模型？

编辑 `agent/settings.json`，配置 `provider` 和 `model` 字段。

详见 [ENVIRONMENTS.md](./operations/ENVIRONMENTS.md) → 配置层

### Q: 如何配置 API 密钥？

创建 `agent/auth.json`：

```json
{
  "deepseek": "your-api-key"
}
```

> ⚠ 密钥文件已 gitignore，不要提交到仓库。

---

## 二、使用问题

### Q: 如何备份 Pi？

```bash
# 本地备份
pi-backup create

# GitHub 同步
pi-backup sync
```

详见 [README.md](../README.md) → 备份与恢复

### Q: 如何恢复会话？

```bash
pi-backup list          # 查看可用备份
pi-backup restore --backup <路径>  # 从备份恢复
```

### Q: 如何查看记忆库？

```bash
pi /memory status       # 查看统计
pi /memory search <关键词>  # 搜索记忆
```

### Q: 如何压缩上下文？

```bash
pi /compact             # 手动压缩
```

---

## 三、扩展相关

### Q: 如何禁用扩展？

在 `agent/settings.json` 的 `extensions` 数组中添加 `!` 前缀：

```json
{
  "extensions": ["!pi-voice"]
}
```

### Q: 扩展不工作怎么办？

```bash
# 1. 检查扩展加载
cd agent/extensions && node tests/conflict-check.mjs

# 2. 重新构建
bash scripts/rebuild.sh --yes

# 3. 重启 pi
pi --reload
```

### Q: 如何开发新扩展？

详见 [PI-EXT-DEV-NOTES.md](./development/PI-EXT-DEV-NOTES.md)

---

## 四、数据与备份

### Q: 记忆数据在哪里？

`data/memory/entries.json`（长期记忆）

### Q: 如何导出记忆？

```bash
pi-backup create --include-memory
```

### Q: 如何清理旧记忆？

```bash
pi /memory status       # 查看统计
pi /memory forget <ID>  # 删除特定记忆
```

### Q: 会话历史在哪里？

`agent/sessions/`（gitignored）

---

## 五、性能优化

### Q: 如何提高响应速度？

1. 使用 `pi /compact` 压缩上下文
2. 检查缓存命中率：`node agent/extensions/pi-context/scripts/usage-stats.mjs`
3. 优化工具输出：配置 `prune` 阈值

### Q: 缓存命中率低怎么办？

```bash
# 检查缓存统计
node agent/extensions/pi-context/scripts/usage-stats.mjs

# 检查缓存注入面
cd agent/extensions && node tests/cache-guard.mjs
```

详见 [AGENTS-DETAILS.md](./development/AGENTS-DETAILS.md) → 缓存治理

### Q: 如何监控资源使用？

```bash
pi /usage-diag         # 查看用量诊断
pi /auto stats         # 查看自动运行统计
```

---

## 六、其他

### Q: 如何报告问题？

1. 检查 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
2. 查看 [GitHub Issues](https://github.com/earendil-works/pi-coding-agent/issues)
3. 提供环境信息、错误信息、复现步骤

### Q: 如何贡献代码？

详见 [PI-EXT-DEV-NOTES.md](./development/PI-EXT-DEV-NOTES.md) → 开发流程

### Q: 文档在哪里？

```bash
# 查看文档索引
cat README.md | grep -A 20 "深度文档索引"

# 检查文档质量
node scripts/docs-check.mjs
```