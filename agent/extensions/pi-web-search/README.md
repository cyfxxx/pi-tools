# pi-web-search — 网络搜索扩展

> 为 [Pi](https://pi.dev) 编写的网络搜索扩展，集成 **SearXNG** 私密搜索与轻量 HTTP 抓取，让 Pi 的 LLM 获得完整的三级搜索通路。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 网络搜索、HTTP 抓取 |
| 相关文档 | [pi-browser](../pi-browser/README.md), [SearXNG 部署](#本地-searxng-部署) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、安装与部署](#六安装与部署)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 需要网络搜索能力来获取实时信息，但：
- 公共搜索 API 有配额限制
- 隐私搜索需求
- 需要多引擎备份

### 1.2 设计理念

- **三级搜索通路**：SearXNG → Bing 直搜 → fetch_url fallback
- **隐私保护**：SearXNG 聚合搜索，不泄露用户查询
- **Token 效率**：内置预算管理，自动优化返回内容

---

## 二、架构

### 2.1 系统架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│  Pi (AI 编码代理 CLI)                                                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  pi-web-search (Pi Extension, TypeScript)                      │  │
│  │                                                                 │  │
│  │  fetch_url()     ──── 纯 HTTP GET（15s 超时）                   │  │
│  │  web_fetch()     ──── Bing HTML 解析（无 SearXNG 依赖）         │  │
│  │  web_search()    ──── HTTP JSON API ─────── SearXNG            │  │
│  │               └─ 多引擎结果 URL 去重（W1，2026-08）            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 入口层 | `index.ts` | 扩展注册和初始化 |
| 配置层 | `config.ts` | 配置聚合和验证 |
| 搜索层 | `search/` | SearXNG 搜索实现 |
| 抓取层 | `fetch.ts` | HTTP 抓取工具 |
| 测试层 | `tests/` | 单元测试和集成测试 |

---

## 三、功能

### 3.1 工具清单

| 工具 | 参数 | 说明 |
|------|------|------|
| `fetch_url` | `url`, `max_length?` | 轻量 HTTP GET，获取 URL 内容 |
| `web_fetch` | `query`, `max_results?` | Bing HTML 解析，不依赖 SearXNG |
| `web_search` | `query`, `engines?`, `categories?`, `pageno?`, `time_range?`, `lang?`, `max_results?`, `brief?` | SearXNG 搜索，支持多引擎 |

### 3.2 搜索通路

1. **web_search (SearXNG)** — 首选，隐私保护，结果丰富
2. **web_fetch (Bing 直搜)** — 备选，SearXNG 不可用时使用
3. **fetch_url + Bing URL 组合** — 最后的 fallback

### 3.3 结果处理

多引擎搜索结果按 **URL 去重**：同一链接在多个引擎重复命中时只输出一次，engine 标签合并（如 `[google,bing]`）——避免同一结果重复占用 token 与注意力。

### 3.4 Token 效率

| 工具 | Token 优化 | 预估节省 |
|------|-----------|---------|
| `web_search` | `max_results` 默认 5，`brief` 模式省略摘要 | ~70% |
| `fetch_url` | `max_length` 默认 8000，无浏览器开销 | ~50% vs browser |
| `web_fetch` | 纯标题+URL，无摘要 | ~80% vs web_search |

---

## 四、配置项

### 4.1 配置文件

编辑 `~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级）：

```json
{
  "pi-web-search": {
    "searxng_url": "https://your-searxng.tld",
    "search_timeout": 15000
  }
}
```

### 4.2 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_WEB_TOOLKIT_SEARXNG_URL` | SearXNG 实例地址 | `https://searx.be` |
| `PI_WEB_TOOLKIT_SEARCH_TIMEOUT` | 搜索超时（毫秒） | `15000` |

### 4.3 配置优先级

**settings.json > 环境变量 > 内置默认值**

默认 SearXNG 实例为 `https://searx.be`（公共实例，无需注册即可使用）。

---

## 五、使用方法

### 5.1 基本用法

```bash
# 使用 SearXNG 搜索
web_search(query="Rust web framework 2026", engines=["google","bing"])

# 使用 Bing 直搜
web_fetch(query="Rust web framework 2026")

# 获取 URL 内容
fetch_url(url="https://example.com/article", max_length=2000)
```

### 5.2 使用场景示例

**场景 1：搜索 + 浏览内容**

```
用户: 找一下 Rust 的 web framework 有哪些

→ LLM 调用: web_search(query="Rust web framework comparison 2026")
→ LLM 调用: fetch_url(url="https://www.arewewebyet.org/")
```

**场景 2：搜索引擎故障切换**

```
用户: Google 搜索结果不太行

→ LLM 调用: web_search(query="latest AI papers",
                        engines=["google","bing","brave","duckduckgo","qwant"])
            // 如 Google 不可用，自动返回其他引擎结果
```

### 5.3 国内网络推荐引擎

| 引擎 | 地区 | 可信度 | 说明 |
|------|------|--------|------|
| `baidu` | 🇨🇳 | ⭐⭐⭐ | 百度搜索，中文结果最丰富 |
| `sogou` | 🇨🇳 | ⭐⭐⭐ | 搜狗搜索，中文结果良好 |
| `360search` | 🇨🇳 | ⭐⭐⭐ | 360 搜索 |
| `bilibili` | 🇨🇳 | ⭐⭐⭐ | B站内容搜索 |
| `bing` | 🌐 | ⭐⭐⭐ | 微软必应，已通过 bing.py 修复 |

---

## 六、安装与部署

### 6.1 前置条件

- Node.js >= 18
- Pi 已安装并可用

### 6.2 一键部署

```bash
bash ~/.pi/agent/extensions/pi-web-search/start-searxng.sh
```

脚本会自动完成：系统依赖 → 克隆仓库 → 创建 venv → 安装 SearXNG → 生成配置 → 启动并验证。

### 6.3 手动部署

```bash
# 1. 安装系统依赖
sudo apt install -y python3-dev python3-venv python3-pip git build-essential \
  libxslt-dev zlib1g-dev libffi-dev libssl-dev

# 2. 克隆 SearXNG 仓库
mkdir -p ~/.pi/searxng
git clone --depth 1 https://github.com/searxng/searxng.git ~/.pi/searxng/repo

# 3. 创建虚拟环境并安装
python3 -m venv ~/.pi/searxng/venv
source ~/.pi/searxng/venv/bin/activate
pip install -U pip setuptools wheel pyyaml msgspec typing-extensions
pip install --use-pep517 --no-build-isolation -e ~/.pi/searxng/repo
pip install granian
deactivate

# 4. 生成配置并设置密钥
python3 -c "import secrets; print(secrets.token_hex(32))"  # 复制输出的密钥
cat > ~/.pi/searxng/settings.yml << 'EOF'
use_default_settings: true
server:
  port: 8889
  bind_address: "127.0.0.1"
  secret_key: "上面生成的密钥"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
EOF

# 5. 启动服务
SEARXNG_SETTINGS_PATH=~/.pi/searxng/settings.yml \
  ~/.pi/searxng/venv/bin/granian searx.webapp:app \
  --interface wsgi --host 127.0.0.1 --port 8889 --workers 2

# 6. 验证服务
curl 'http://127.0.0.1:8889/search?format=json&q=hello'
```

### 6.4 Termux/PRoot 环境注意事项

必须使用 **Python 3.12**（而非 3.13）。Python 3.13 下 `msgspec` 和 `lxml` 的 `.so` 文件会因 Android 命名空间隔离而加载失败。

### 6.5 管理命令

```bash
# 启动（使用封装脚本）
bash ~/.pi/agent/extensions/pi-web-search/start-searxng.sh

# 停止
bash ~/.pi/searxng/stop.sh

# 查看日志
tail -f ~/.pi/searxng/searxng.log

# 更新 SearXNG
cd ~/.pi/searxng/repo && git pull
source ~/.pi/searxng/venv/bin/activate
pip install --use-pep517 --no-build-isolation -e .
deactivate
# 重启服务
bash ~/.pi/searxng/stop.sh && bash ~/.pi/searxng/start.sh
```

---

## 七、已知问题

- **SearXNG 返回 404**：SearXNG 实例地址错误，检查 `searxng_url` 配置
- **SearXNG 连接超时**：网络问题或 SearXNG 不可达，尝试更换为其他公共实例
- **所有搜索引擎均无响应**：SearXNG 引擎配置问题，检查 `settings.yml` 中引擎配置
- **Pi 报错"扩展未找到"**：扩展不在搜索路径，确认扩展在 `~/.pi/agent/extensions/` 中
- **npm install 失败**：网络问题或版本冲突，检查 Node.js 版本（>= 18）

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-web-search
npm install
npx vitest run
```

### 8.2 验证检查清单

- [ ] `npm install` 成功完成
- [ ] `web_search` 工具能返回搜索结果
- [ ] `fetch_url` 能获取纯文本 URL
- [ ] `web_fetch` 能返回搜索结果（不依赖 SearXNG）

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现搜索和抓取功能 |

---

## 十、安全注意事项

- **扩展以用户完整权限运行**：Pi 扩展系统设计如此，无内置沙箱。仅从信任的来源安装扩展。
- **SearXNG 实例信任**：使用公共 SearXNG 实例时，搜索查询会经过第三方服务器。敏感或隐私查询建议自部署 SearXNG。

---

## 十一、上游项目

| 项目 | 仓库 | 许可证 | 在本扩展中的角色 |
|------|------|--------|----------------|
| **SearXNG** | https://github.com/searxng/searxng | AGPL-3.0 | 隐私友好的元搜索引擎 |
| **Pi** | https://pi.dev | MIT | 宿主平台，TypeScript 扩展系统 |

### 不修改源码的保证

| 项目 | 集成方式 | 更新方法 |
|------|---------|---------|
| SearXNG | 纯 HTTP fetch 调用 `?format=json` API，零代码依赖 | 更新 SearXNG 服务端即可 |