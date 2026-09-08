{
  "summary": {
    "title": "pi-webui 增强与调度器端口冲突修复",
    "decisions": [
      "WebUI 功能增强（消息动作栏、Markdown、系统消息、滚动按钮）直接在 ChatView 等核心组件实现，不另建扩展",
      "pi-autopilot 子进程传入 PI_WEBSUI_SERVER_MODE=false 环境变量，subagent 中 pi-webui 扩展跳过启动 HTTP 服务器以避免 EADDRINUSE",
      "message-store 的 clearChat 返回值取自 readStore 读取的 msgs.length，原测试断言 expect(cnt===2) 因读取时机不一致已修复"
    ],
    "facts": [
      "daily-health 任务 useSubagent: false，注入主会话而非子进程，因此能在主实例占用 3100 端口时仍正常运行",
      "所有其他每日任务（knowledge-subscribe/daily-review/tool-stats-daily/golden-fast）均为 useSubagent: true，需 spawn 子进程；子进程加载扩展时 pi-webui 尝试绑定 3100 导致 EADDRINUSE 崩溃",
      "4/5 每日任务因端口冲突连续失败，累计失败次数：knowledge-subscribe 6 次、tool-stats-daily 7 次、daily-review 8 次",
      "修复后 knowledge-subscribe 成功抓取 60 条知识写入 logs/knowledge/2026-09-05.md",
      "store tests 测试文件位于 pi-webui/src/components/__tests__/，测试用例涉及 appendMessage/deleteMessage/clearChat 的多步骤交互"
    ],
    "prefs": [
      "用户强调"页面没有变化"时，需确认 Vite 构建产物已被 WebSocket 热更新或服务已重启",
      "用户说"推送更新"时，commit 后立即执行 git push"
    ],
    "lessons": [
      "同一端口绑定是导致 pi-autopilot 调度器子任务全面崩溃的根本原因：subagent spawn 时加载 pi-webui 扩展会尝试启动 HTTP server，主实例已持有端口，EADDRINUSE 导致子进程立即崩溃",
      "EADDRINUSE 不是可以 try-catch 的 JS 错误（是系统级 events:497 Unhandled error），必须在启动前检测端口是否可用",
      "daily-health 可以在主实例占用端口时正常运行，因为它不 spawn 子进程；其他每日任务的 subagent 执行模式是根本矛盾"
    ],
    "fullText": "对话涉及三块内容：（1）pi-webui 功能增强：在 ChatView、MessageBubble、InputBar 等组件实现了消息动作栏（复制/引用/删除）、Markdown 内容渲染、系统消息格式化、滚动到底部按钮等功能，构建后重启服务生效，commit fe422ab 推送。（2）消息存储测试修复：clearChat 返回值从 readStore 同步读取，测试断言因读取时机不一致已修复，store tests 全过。（3）调度器与 WebUI 端口冲突修复：pi-autopilot 的 fireViaSubagent 正确传递 PI_WEBSUI_SERVER_MODE=false 给子进程，阻止 subagent 启动 HTTP 服务器；修复后 knowledge-subscribe 成功抓取 60 条知识，daily-health 已记录告警。"
  },
  "memories": [
    {
      "category": "solutions",
      "title": "pi-autopilot subagent 端口冲突修复",
      "content": "根因：fireViaSubagent spawn 子进程时加载 pi-webui 扩展，尝试绑定 3100 端口，与主实例冲突导致 EADDRINUSE 崩溃。修复：向子进程环境变量注入 PI_WEBSUI_SERVER_MODE=false，pi-webui 扩展在子进程中检测到该变量时跳过 HTTP server 启动，仅以客户端模式运行。subagent 需要 pi-memory、pi-autopilot 等扩展但不需要独立 WebSocket 服务器。代码位置：pi-autopilot 扩展中 fireViaSubagent 方法向子进程 env 传递 PI_WEBSUI_SERVER_MODE=false。",
      "tags": ["pi-autopilot", "pi-webui", "端口冲突", "EADDRINUSE", "subagent", "PI_WEBSUI_SERVER_MODE"],
      "confidence": 0.95
    },
    {
      "category": "procedure",
      "title": "每日任务排查诊断步骤",
      "content": "排查每日任务失败原因时：先查 lastResult 中的错误信息，观察是否为 EADDRINUSE 0.0.0.0:3100；然后确认任务配置的 useSubagent 字段；若为 true 则是 subagent 启动冲突，若为 false 则是主会话本身问题。修复后手动触发已失败任务：pi /schedule run <taskname> 或检查调度器是否已重启。",
      "tags": ["pi-autopilot", "调度器", "daily-health", "knowledge-subscribe", "排查"],
      "confidence": 0.85
    },
    {
      "category": "reference",
      "title": "每日任务失败累计次数",
      "content": "2026-09-05 观察到的累计失败次数：knowledge-subscribe 6 次（最后一次 00:20）、tool-stats-daily 7 次（00:06）、daily-review 8 次（01:05）。golden-fast 未显示但原因为同一根因。全部由 EADDRINUSE 导致，修复后 knowledge-subscribe 成功抓取 60 条知识。",
      "tags": ["pi-autopilot", "每日任务", "失败统计"],
      "confidence": 0.9
    },
    {
      "category": "fact",
      "title": "daily-health 与其他每日任务的关键区别",
      "content": "daily-health 配置为 useSubagent: false，通过 fireViaMessage 方式注入主会话（注入到已有的主 pi 进程），不 spawn 子进程，因此不受 3100 端口冲突影响。其他每日任务（knowledge-subscribe、daily-review、tool-stats-daily、golden-fast）均为 useSubagent: true，必须 spawn 子 pi 进程执行，子进程加载扩展时 pi-webui 启动冲突导致全面失败。",
      "tags": ["pi-autopilot", "daily-health", "subagent", "端口"],
      "confidence": 0.95
    },
    {
      "category": "procedure",
      "title": "消息存储测试修复",
      "content": "clearChat 实现：先 readStore(chatId) 读取消息数组，然后 writeStore(chatId, []) 清空，最后返回 msgs.length。原测试在 appendMessage(m3,m4) 后立即调用 clearChat，但文件 I/O 操作可能存在读取时机问题。修复后 store tests 所有用例通过：clearChat 返回正确数量，clear 后 getMessages 返回空数组，priv 独立存储不受影响。测试文件位于 pi-webui/src/components/__tests__/。",
      "tags": ["pi-webui", "message-store", "clearChat", "测试", "debug"],
      "confidence": 0.85
    },
    {
      "category": "fact",
      "title": "pi-webui 功能增强已合并的 6 项功能",
      "content": "（1）消息动作栏：悬停显示复制/引用/删除按钮；（2）消息顶部悬停栏：显示时间+操作按钮；（3）消息内容 Markdown 渲染：粗体/斜体/删除线/链接/代码块；（4）系统消息格式化：加入/离开提示、错误/警告/信息提示等；（5）滚动到底部按钮：向上滚动时浮动显示，点击回底部；（6）引用功能：点击消息引用按钮后在输入框顶部显示预览，ESC 或点×取消。已提交 fe422ab，服务重启生效。",
      "tags": ["pi-webui", "feature", "message-actions", "markdown", "system-message", "scroll-to-bottom"],
      "confidence": 0.9
    }
  ]
}