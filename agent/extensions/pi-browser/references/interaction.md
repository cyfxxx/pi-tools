# pi-browser Web 交互操作手册

面向使用 pi-browser 17 个工具时的交互机制要领。遇到不确定时用 `browser_help` 查询对应主题。来源：browser-harness interaction-skills 提炼。

---

## 坐标与截图（最易踩的坑）

- `browser_screenshot` 输出的 PNG 是**设备像素**，而 `browser_click(x, y)` 用的是 **CSS 像素**。
- 在 2× 高分屏上，CSS 视口 2296×1143 会得到 4592×2286 的 PNG。直接从截图读数喂给坐标点击会**全部错位**。
- 转换：目标坐标 = 截图读数 ÷ `devicePixelRatio`。用 `browser_evaluate("window.devicePixelRatio")` 取比值。
- 稳妥做法：把截图读数换算成 CSS 坐标后再点；或按相对位置估算。
- 无头模式下 devicePixelRatio 通常为 1，需点验；有窗口的高分屏才需换算。
- 页面正在滚动/动画时坐标会漂移，先 `browser_wait_for` 等稳定再截图取点。

## Shadow DOM

- scene 用深穿透（`browser_find` 已递归所有 `shadowRoot`）：常规 CSS 选择器匹配不到 shadow-root 内元素时用它定位，返回的中心坐标可直接 `browser_click` 坐标模式使用。
- 终极手段：`browser_evaluate` 手写递归遍历 `shadowRoot.querySelectorAll`。
- 有时坐标点击比深层穿透更省事——如果已知可见位置，直接坐标点即可，不必解析 shadow 结构。

## 下拉框

- 分三类：原生 `<select>`（用 `browser_select_option`，可按 value 或 by_label 文本）、自定义浮层、可搜索 combobox。
- **先打开再测量**：选项几何常常晚出（懒渲染/动画），先点开下拉、等稳定、必要时 `browser_wait_for`，再测量选项位置，勿在打开前就固定坐标。
- 可搜索 combobox：用 `browser_type` 输入关键词过滤，再点结果。
- 拿不到 value 时：`browser_evaluate("Array.from(document.querySelectorAll('option')).map(o=>({v:o.value,t:o.text}))")` 先列出来。

## 弹窗 / 对话框

- alert/confirm/prompt 默认被自动 dismiss（不阻塞、吞掉）。需要确认时先 `browser_dialog(mode="accept")`，需要填入时 `mode="input"` + text。
- 想读弹窗内容：`browser_dialog()`（不带 mode）返回最近一次弹窗文本。
- 登录墙/敏感确认：不要自动 accept 涉及金钱、删除、同意隐私的处理，先停下来向用户确认。

## 下载 / 上传

- 下载事件自页面打开即自动监听并保存到 `~/.pi-browser-downloads/`。点击下载后调 `browser_download()` 拿路径即可，无需预先配置。
- 上传：`browser_upload(selector, path)` 直接给文件输入框设本地文件（不用模拟点击文件选择器——那是不可行的）。
- 拖拽上传类组件若无 `<input type=file>`：用 `browser_evaluate` 分发 DataTransfer 到 drop 事件，或找其隐藏 input。

## 网络请求捕获

- 日志自页面打开即持续记录。想抓某次操作触发的接口：先 `browser_network(clear=true)` 清空 → 操作页面 → 再 `browser_network(url_pattern=..., method=...)` 查。
- `url_pattern` 支持正则，如 `"api/"`、`"\\/items\\/\\d+"`；`resource_type` 里 `fetch`/`xhr` 是接口请求，`document` 是页面跳转。
- 抓 JSON 接口返回体：得到 URL 后可用 `browser_evaluate("fetch('url').then(r=>r.json())")`（同源）获取结构化数据。

## 滚动

- 区分四种滚动目标：整页、嵌套容器、虚拟列表、下拉菜单——先弄清**谁在消费 wheel/滚轮事件**。
- 页面滚动：`browser_scroll`（内部 `window.scrollBy`）。嵌套容器需先定位容器再滚其内容。
- 虚拟列表（无限滚动）：滚动到底可能需多次，且要等新内容渲染，循环 `browser_scroll` + `browser_wait_for` 断言新行出现。
- 下拉菜单滚动：先打开再滚菜单本体。

## iframe / 跨域

- 坐标点击（compositor 级）能穿透 iframe/Shadow DOM/跨域框架，这是比跨 target DOM 操作更省事的默认路径。
- 需要读 iframe 内部 DOM 时，跨域 iframe 无法用主文档 `querySelector` 触碰——改用坐标定位 + 截图确认，或 `browser_evaluate` 在 `contentDocument` 明确同源时操作。
- 文本提取（`browser_extract`/`browser_evaluate` 的 `document.body.innerText`）通常**不含** iframe 内文本，跨 iframe 内容需单独定位。

## 等待与稳定性

- 点击/提取前先 `browser_wait_for(selector)` 等元素就绪，或 `browser_wait_for()`（无 selector）等网络空闲——减少"点早/未加载完"失败。
- 动态 UI：打开下拉/弹窗/模态后先等稳定（必要时二次 `browser_wait_for`）再取元素矩形坐标。
- 重定向/懒加载：导航后用 `browser_wait_for` 断言关键元素，而不是假设页面已就绪。

## Cookies / 登录态

- `browser_cookies()` 读当前域 cookie，检查是否已登录；`browser_cookies(action="set", url, name, value)` 预置会话。
- CloakBrowser 独立 profile（可配 `data_dir` 持久化），不自动带系统登录态——需登录的站点要么靠页面内登录，要么自己设置 cookie 或复用持久 profile。

## 截图

- 默认只截当前视口；`full_page=true` 只在需要看折叠以下内容时用（又大又慢）。
- 截图路径返回给 agent 后用于观察布局，再换算坐标点击。长截图会改变视口坐标基准，取点须用普通视口截图。
