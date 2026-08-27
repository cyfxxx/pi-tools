---
name: knowledge-fetch
description: 搭建零 LLM 官方源直连的知识订阅（渠道调研、抓取脚本、去重过滤容错、定时任务接入）。用户说"新闻功能没触发""加信息渠道""做知识订阅"时触发。
---

# 零 LLM 知识订阅搭建

以官方 API + RSS 直连替代搜索引擎，为定时任务提供稳定、真实、有用的信息抓取。已验证实例：`/root/.pi/scripts/knowledge-fetch.py` v2（5 大 section，接入 daily-health-check 任务）。

## 适用与不适用

- 适用：给 pi 定时任务（健康检查/知识订阅）加新闻与信息抓取；排查"自动查新闻功能从未触发"
- 不适用：需要语义理解/摘要的抓取（该走 LLM 加工环节，本流程只做零 LLM 增量收集）

## 步骤

### 1. 诊断现状（若为排查"功能未触发"）

1. 找到既有抓取任务/脚本，看调度配置（scheduled-tasks.json）是否启用、lastRun 是否成功
2. 看去重文件（如 .seen.txt）是否全部命中、当日输出 md 是否为空
3. 单源失败常被吞异常（fetch 返回 ''），用 curl 手动验证源可达性，别只看脚本日志

### 2. 渠道调研

1. 按领域列候选渠道：安全/漏洞（官方漏洞库 API）、AI（官方博客/arXiv）、科技数码、生活热点、重要新闻
2. 优先"官方 API > RSS > 轻量 HTML 抓取"，每领域 2-4 个稳定源
3. 验证：curl 拉一次，确认返回结构与更新频率；弃用需登录/反爬/经常挂的源

### 3. 实现抓取脚本

1. 每个源一个独立 fetcher 函数，返回 `[(title, url, pubdate, summary)]`，单源异常只影响自身（try/except 吞掉返回 []）
2. 统一低价值标题过滤：正则过滤教程/百科/广告/行情/开奖/门户首页等（LOW_VALUE 模式）
3. 按标题 sha1 前 16 位 hash 去重，已见哈希落 .seen.txt，新增增量追加写 `<日期>.md`（零 LLM、可重复运行）
4. 每源条数上限（如默认 6），超时与体积上限（20s / 2MB），User-Agent 伪装

### 4. 接入调度

1. 接入现有定时任务（如 daily-health-check 的第 4 步）：`python3 scripts/knowledge-fetch.py` 先跑一次验证
2. 若当日有新增：LLM 环节读 md、挑 3-5 条真正有价值的（时效强/漏洞/病毒/重大新闻，排除过时教程与多源冗余），memory_search 查重后逐条 memory_store
3. 抓取失败不影响健康判定（知识部分与健康判定解耦）

### 5. 迭代

- 渠道在 SOURCES 列表集中管理，加/换源只改一处
- 观察数日：某源长期零新增（源挂了/内容同质）→ 换源；某源噪声高 → 补充 LOW_VALUE 过滤词

---

## 本机环境备注（环境：termux-ubuntu —— proot-Distro aarch64，Android 宿主 proot 容器，uname 含 PRoot；其他设备以自身环境为准）

- 已验证实例：`/root/.pi/scripts/knowledge-fetch.py` v2（5 大 section，接入 daily-health-check 任务），本机可直接复用
- 定时接入走 pi-autopilot 的 scheduled-tasks.json；渠道集中在脚本内 SOURCES 列表管理

## 使用后经验沉淀（必做）

任务收尾时按 packs/README.md「经验沉淀机制」追加包根 `EXPERIENCE.md`（无则建；工具坑/新发现/流程缺陷，证据导向，标注环境）。未合并条目 ≥3 条或用户要求时合并进本文件正文并清条目。
