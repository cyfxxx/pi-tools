# 故障排除指南

> 系统化的故障诊断流程，帮助快速定位和解决问题。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 更新日期 | 2026-09-12 |
| 适用范围 | Pi 运行时故障、扩展问题、配置问题 |
| 相关文档 | [FAQ.md](./FAQ.md), [ENVIRONMENTS.md](./operations/ENVIRONMENTS.md) |

---

## 目录

- [一、通用诊断流程](#一通用诊断流程)
- [二、启动问题](#二启动问题)
- [三、扩展问题](#三扩展问题)
- [四、配置问题](#四配置问题)
- [五、网络问题](#五网络问题)
- [六、性能问题](#六性能问题)
- [七、数据问题](#七数据问题)

---

## 一、通用诊断流程

### 1. 快速检查清单

```bash
# 1. 检查 pi 版本
pi --version

# 2. 检查配置文件
python3 -c "import json; json.load(open('agent/settings.json'))" && echo "settings.json OK"

# 3. 检查扩展加载
cd agent/extensions && node tests/conflict-check.mjs

# 4. 检查测试
bash scripts/test/test-all.sh --fast

# 5. 检查日志
tail -50 data/logs/*.log 2>/dev/null || echo "无日志文件"
```

### 2. 问题分类

| 问题类型 | 症状 | 首选文档 |
|----------|------|----------|
| 启动失败 | pi 无法启动 | 本文件 §二 |
| 扩展不工作 | 特定功能异常 | 本文件 §三 |
| 配置错误 | 配置不生效 | 本文件 §四 |
| 网络问题 | 连接失败 | 本文件 §五 |
| 性能问题 | 响应慢 | 本文件 §六 |
| 数据问题 | 记忆/状态异常 | 本文件 §七 |

---

## 二、启动问题

### 2.1 pi 命令找不到

**症状：** `command not found: pi`

**原因：** wrapper 未安装或 PATH 未配置

**解决：**
```bash
# 安装 wrapper
bash scripts/install/install-wrapper.sh

# 或直接运行
./scripts/rebuild.sh --yes
```

### 2.2 启动报错 "Extension runtime not initialized"

**症状：** pi 启动时显示此错误

**原因：** wrapper 接管后，pi-voice 的 dist 探测失败

**解决：**
```bash
# 检查 PI_DIST
echo $PI_DIST

# 重新安装 wrapper
bash scripts/install/install-wrapper.sh
```

### 2.3 配置加载失败

**症状：** 启动时报 JSON 解析错误

**原因：** settings.json 格式错误

**解决：**
```bash
# 验证 JSON 格式
python3 -c "import json; json.load(open('agent/settings.json'))"

# 从备份恢复
git checkout HEAD -- agent/settings.json
```

---

## 三、扩展问题

### 3.1 扩展未加载

**症状：** 扩展功能不可用

**诊断：**
```bash
# 检查扩展目录
ls agent/extensions/<扩展名>/

# 检查扩展注册
cd agent/extensions && node tests/conflict-check.mjs

# 检查 TypeScript 编译
cd agent/extensions && ../node_modules/typescript/bin/tsc -p tsconfig.local.json --noEmit
```

**解决：**
```bash
# 重新构建
bash scripts/rebuild.sh --yes

# 重启 pi
pi --reload
```

### 3.2 扩展冲突

**症状：** 启动时报扩展冲突错误

**原因：** 两个扩展注册了相同的工具或命令

**解决：**
```bash
# 检查冲突
cd agent/extensions && node tests/conflict-check.mjs

# 查看扩展配置
cat agent/settings.json | grep -A 20 '"extensions"'
```

### 3.3 缓存注入面漂移

**症状：** 缓存命中率下降

**诊断：**
```bash
# 检查缓存注入面
cd agent/extensions && node tests/cache-guard.mjs

# 查看缓存统计
node agent/extensions/pi-context/scripts/usage-stats.mjs
```

**解决：**
```bash
# 更新基线
cd agent/extensions && node tests/cache-guard.mjs --update-baseline
```

---

## 四、配置问题

### 4.1 配置不生效

**症状：** 修改配置后功能未变化

**原因：** 配置文件路径错误或格式错误

**解决：**
```bash
# 检查配置文件位置
ls -la agent/settings.json agent/auth.json agent/models.json

# 验证 JSON 格式
python3 -c "import json; json.load(open('agent/settings.json'))"

# 检查环境变量
env | grep PI_
```

### 4.2 多环境配置冲突

**症状：** 跨设备配置不一致

**解决：**
```bash
# 检查环境标签
python3 -c "import json; es=json.load(open('data/memory/entries.json'))['entries']; print(len(es))"

# 同步配置
git pull origin master
```

详见 [ENVIRONMENTS.md](./operations/ENVIRONMENTS.md)

---

## 五、网络问题

### 5.1 SearXNG 搜索超时

**症状：** 搜索请求超时

**原因：** 国内 DNS 干扰

**解决：**
```bash
cd searxng && bash generate-config.sh --force
```

### 5.2 git push 失败

**症状：** 推送被拒绝

**解决：**
```bash
# 拉取最新
git pull --rebase origin master

# 检查远程配置
git remote -v
```

### 5.3 API 连接失败

**症状：** 模型调用失败

**诊断：**
```bash
# 检查网络连接
curl -I https://api.deepseek.com

# 检查 API 配置
cat agent/auth.json
```

---

## 六、性能问题

### 6.1 响应缓慢

**症状：** pi 响应时间过长

**诊断：**
```bash
# 检查上下文大小
node agent/extensions/pi-context/scripts/usage-stats.mjs

# 检查缓存命中率
node agent/extensions/pi-context/scripts/usage-stats.mjs --json
```

**优化：**
```bash
# 压缩上下文
pi /compact

# 检查工具输出大小
ls -lh data/logs/tool-outputs/
```

### 6.2 内存占用高

**症状：** 系统内存不足

**诊断：**
```bash
# 检查 Node.js 内存
ps aux | grep node

# 检查会话大小
ls -lh agent/sessions/
```

---

## 七、数据问题

### 7.1 记忆库损坏

**症状：** 记忆搜索失败

**诊断：**
```bash
# 检查记忆库
python3 -c "import json; print(len(json.load(open('data/memory/entries.json'))['entries']))"

# 检查记忆统计
pi /memory status
```

**恢复：**
```bash
# 从备份恢复
pi-backup restore --backup <备份路径>

# 或从 git 恢复
git checkout HEAD -- data/memory/entries.json
```

### 7.2 会话历史丢失

**症状：** 无法恢复之前的会话

**原因：** 会话文件被删除或损坏

**预防：**
```bash
# 定期备份会话
pi-backup create --include-sessions

# 检查会话目录
ls -la agent/sessions/
```

---

## 八、日志分析

### 8.1 查看日志

```bash
# 查看最近日志
ls -lt data/logs/*.log | head -5

# 查看特定日志
tail -100 data/logs/scheduler/*.log

# 查看错误日志
grep -i error data/logs/*.log
```

### 8.2 启用调试模式

```bash
# 启用详细日志
DEBUG=pi:* pi

# 查看扩展日志
tail -f data/logs/extensions.log
```

---

## 九、获取帮助

### 9.1 社区资源

- Pi 官方文档: https://pi.dev/docs/latest
- GitHub Issues: https://github.com/earendil-works/pi-coding-agent/issues

### 9.2 本地资源

```bash
# 查看内置帮助
pi /help

# 查看扩展帮助
pi /<扩展名> help

# 查看技能帮助
pi /<技能名> help
```

### 9.3 报告问题

报告问题时请包含：

1. **环境信息**：`uname -a`、`pi --version`
2. **错误信息**：完整的错误输出
3. **复现步骤**：如何触发问题
4. **日志文件**：相关日志内容