## 误报判别清单（本次实战沉淀）

遇到以下情况先定性，别直接报：

- **密钥扫描命中**：先 `git ls-files <file>` + `git check-ignore -v <file>`。git ignored 的运行配置（~/.pi 的 auth.json/settings.json/models.json）是正常存在，**不是泄露**；只有被 git 跟踪的才是 HIGH
- **review.sh --all 排除陷阱（2026-08-15 实测）**：排除规则 `! -path '*/.pi/*'` 在扫描根自身是 .pi 目录（如 `review.sh --all /root/.pi`）时误伤全部文件——"待审文件: 1 个"而预览 249 个即此症状。已修复（根为 .pi 时禁用该排除）；审计中若发现待审文件数远小于预览数，先怀疑排除规则而非仓库无文件
- **运行时数据噪音**：`--all` 会扫入入库的运行时数据（如 memory/entries.json），其中的文本内容命中 rm -rf/密钥等模式属噪音，跳过
- **glob 陷阱**：`for d in dir/*/node_modules` 只在**全部不匹配**时保留字面量；部分不匹配 = 静默漏检，不是报错
- **"没找到 X" ≠ "X 不存在"**：先 grep 确认是否在其他层实现（如删除落盘在 deleteEntry 内部 vs 工具函数外层）
- **ETIMEDOUT 类分支**：Node 子进程超时行为与版本相关，实测确认，不要信注释或直觉
- **运行时行为必须实测**（2026-08-15 扩展）：Node 子进程超时语义（err.code=null/signal='SIGTERM'）、glob 展开、spawn 错误事件（异步 error 而非同步抛错）等以实测为准，不凭注释/直觉/审查者的机制描述。注意：scout 已标 frontmatter `readonly: true`（subagent 扩展 spawn 时强制过滤 bash），复核 scout **无法执行 bash 实测**——需实测的验证由主会话（有 bash）或委派 worker 完成；scout 只做读码级核实并在报告中标注"未实测"项
- **审查建议的行号引用**：常与实际位置不符（偏差可达几十行）——行为成立但行号错不算误报，以 grep/sed 实际定位为准并在结论中纠正
- **审查者的机制描述**：不可轻信，追完整调用链核实（实战：“spawn 抛错即永久泄漏”实际是异步 error 事件且已有处理+测试）
- **设计当 bug**：代码注释自认的故意设计（写死工具集/磁盘兜底/非阻塞注入）按设计权衡报并注明，不按纯 bug
- **同类遗漏**：审查只报一处的，检查同模块第二处（environments 合并两处、ETIMEDOUT 两处、掩蔽路径两处）
- **修复建议可改进**：审查给的修复方案常非最优或带副作用（预算拦截用 updateTaskAfterRun 会消耗重试次数），核实后给出更优方案
- **PS 解析错误先查编码**：ParseFile 报乱码错误 = 无 BOM/GBK 解码（修复加 BOM）；报结构错误 = 看反引号/引号配对（多余反引号会转义掉闭合引号）
- **Windows 测试隔离**：os.homedir() 优先 USERPROFILE 而非 HOME——stubEnv('HOME') 不生效 → 测试读写真实用户配置（pi-voice.json 被测试数据污染事故）；测试 stub 必须 HOME+USERPROFILE 双设
