# gamedev 经验沉淀（EXPERIENCE.md）

按 packs/README.md「经验沉淀机制」追加；条目 ≥3 条或用户要求时合并进 SKILL.md/对应子技能正文后清档。环境必须标注，防跨设备误会。

## 2026-06 Godot 收编与实机链路（环境：termux-ubuntu proot aarch64）

- **下载通道**：GitHub release/TuxFamily/ghproxy 镜像均不可用；Godot 官网 CDN 可达——真实后端 `godot-releases.nbg1.your-objectstorage.com/<版本>-stable/<文件名>`（downloads.godotengine.org 302 跳转过去），速度 ~330KB/s 需断点/后台下载；apk 317MB、linux arm64 zip 77MB
- **本机运行**：官方 linux.arm64 二进制在 proot-Ubuntu aarch64 直接跑通（`--version`、`--headless --script` 冒烟）；以 root 运行有 superuser 警告，设 `GODOT_SILENCE_ROOT_WARNING=1` 抑制
- **宿主设备直访**：proot 可读写宿主安卓共享存储，项目目录 `/storage/emulated/0/Godot/projects/` 设备端 Godot 编辑器直接打开；`Android/data` 不可读（伪 root）
- **adb 不可用（华为）**：无线调试入口被 ROM 隐藏；5555 端口开放但授权弹窗永不出现，connect 恒 offline——不要再走 adb 路线
- **最小项目格式**：`[sub_resource type="Label"]` 是错误写法（Label 是节点非资源，Parse Error）；Label 直接作 node 属性即可；headless 冒烟命令 `godot --headless --path <dir> --quit-after 2`
- **收编教训（整合原则触发点）**：本次 `cp -r` 整目录收编上游 godot/ 无 diff 保护——后续重拉上游必须按 packs/README.md「更新与整合原则」对照本地差异手工合并（本地环境备注/定向修改是超集，禁止覆盖）
## 2026-08-29 网页灰盒原型（tribe-era，部落纪元）
- 环境: termux-ubuntu proot aarch64（chromium-browser headless 可用）
- 场景/经验: 放置经营类数值验证不必真人试玩——sim.ts 与 DOM 解耦后，tools/simulate.ts 用策略 AI + 固定种子跑全流程即可断言通关时长/死锁/失败路径；第一轮模拟就抓出两个设计死锁（研究员优先级最低导致知识停摆、添丁成本 90 > 食物 cap 80）。数值修正后再上 UI，返工为零
- 场景/经验: 拟真因果链要落进机制而非文案：泥壳窑改为由「一次失败的露天烧陶」flag 解锁后，玩家必然先经历 75% 失败 → 见识提示 → 建窑，比“窑 pottery1 后可建”的数值门槛叙事强得多
- 场景/经验: vite preview 用 `(cmd &)` 分离后台会被子 shell 退出杀掉，nohup 才稳；chromium-browser --headless --screenshot 配 --virtual-time-budget 可快进 setInterval 截到“跑起来”的状态；browser 工具组（enable_tool）做真实点击流验证 UI（研究→见识卡弹层→开工→队列→存档恢复）一遍过
- 场景/经验: localStorage.clear()+reload 会被 beforeunload 的强制保存覆盖（旧档复活）；清档要走页面内“重新开始”确认流程，或 clear 后同步取消 unload 钩子

## 2026-08-28 网页 vs Godot 选型框架（代理环境视角）
- 场景/经验: 用户问"根据游戏技能做 2D 游戏选网页还是 Godot"时的通用框架：(1) 网页（Canvas/Phaser/PixiJS）——纯文本代码迭代、零 GUI 依赖、产物即 URL 分发、headless 可验证，契合代理工作流；引擎能力（物理/动画/音频）需自选库拼装。(2) Godot——编辑器+节点树适合有 GUI 的环境，proot 无头环境只能 --headless 脚本验证，导出模板需另下。本环境（proot 无 GUI）网页优先，Godot 适合用户本机有编辑器的场景
- 注: 原存长期记忆，2026-08-29 按内容域边界规则迁入本文件

## 2026-08-30 UI/地图设计调研整合（tribe-era）
- 环境: termux-ubuntu proot aarch64
- 场景/经验: 像素风网页游戏"像素感"主要来自字体与图标而非 canvas——DOM 面板用 system-ui 即破功。中文像素字首选 Fusion Pixel Font（开源 8/10/12px 中日韩），次选 Zpix（免费商用、结构清晰）；选型标准=偏旁明确可读，不可读宁可保留系统字体。数字一律 font-variant-numeric: tabular-nums 防每秒刷新抖动
- 场景/经验: 地图可读性三条硬原则：(1) 识别非回忆——区域名必须常驻视觉（小字+背衬描边），严禁"点开才知道名字"；(2) 符号系统全图一致并加图例（色斑含义无人猜得出）；(3) 信息层级=装饰服从信息：海洋波纹/经纬网格/山脉细节都是噪音，先画信息（区域边界/名字/状态色）再点缀装饰，噪音透明度砍半
- 场景/经验: 状态颜色编码双方对比要够：当前文明红圈 #e86a4a vs 区域金框 #d9a24a 同为暖色远看混同——改白圈+内红点双色，锁定对比度；未解锁区域整体降明度 15% 做 disabled 视觉
- 场景/经验: 放置经营 UI 核心=玩家回来"一眼看到现在可做的事"：可研究线头脉冲高亮、低资源警示、完成事件闪动；按钮三档层次（primary/normal/danger），高频动作（研究/建造）必须视觉最重
- 管理: 详细差距清单与分级改进方案见 /root/tribe-era/docs/UI-DESIGN.md（A 级纯前端快见效：像素字体/资源图标/区块标题/导引高亮；B 级地图重绘与存档 UI；C 级像素视觉系统/地图三级结构）

## 2026-08-30 真实世界地图像素化管线（tribe-era 美术阶段）
- 环境: termux-ubuntu proot aarch64（模型无读图能力，全程量化自检）
- 场景/经验: 真实世界地图像素化是游戏大世界底图最优路线——现成像素世界图基本不存在（全是虚构/MC 像素画生成器/AI 生成器）；Natural Earth 110m（public domain，无许可负担）经 world-atlas@2（jsdelivr 可达）分发，topojson 解码+等距圆柱投影+scanline 光栅化（460k 像素 150ms）+经纬格插值即可。陆地像素占比 29.1% 对照真实 29.2% 验证海岸线精度
- 场景/经验: 距离场语义 bug 教训——"距海岸距离"做陆地干旱度时方向极易颠倒（d[land]=0 会让内陆全湿润，森林占比虚高到 38%）：陆地湿度须用"陆地内部距海岸距离"（海 0 扩散），海洋深度才用"距陆地距离"（陆 0 扩散），两个方向各算一个场
- 场景/经验: fBm 噪声基线偏高（满幅 0.97）需重映射（-0.34/0.62 压回低地 0.1-0.3）+ 真实地理点位表驱动（19 山系/8 大沙漠/5 雨林/2 绿洲的高斯叠加或湿度修正）替代纯纬度带，否则沙漠雨林全部失真；等距圆柱投影高纬视觉放大（西伯利亚苔原/南极大片）是 Civ 系同款取舍
- 场景/经验: 海岸线渲染：per 格整格提亮小岛会整岛亮一大块（232 亮度突兀）——改临海格 12% 暗化细线，小岛自然只剩暗边；无图 QA 手段：色板直方图/陆地占比对照/地理点位逐格自检/小岛亮度统计（49 岛亮度 125±1 无高亮残留）
- 场景/经验: 地形显示参考 Natural Earth "Cross-blended Hypsometric Tints"（NASA Blue Marble 系）：陆地气候底色→丘陵黄→山地棕→雪线白连续混合、海洋 bathymetry 四层（浅滩/浅海/深海/深渊），比 biome 平涂更像真实地形图
- 决策: 用户选 A 海图风 v3（hypsometric 分层）；人物/物品候选（程序化 16×18 pixel sprite 3 画风×6 种族）被否，待换模型后重做；管线可复跑（tools/art/），细节见 /root/tribe-era/docs/ART-PIPELINE.md

## 2026-08-30 v4 雪区重做（换读图模型后第一轮视觉迭代）
- 环境: termux-ubuntu proot aarch64（模型恢复读图能力，视觉改为直接看图迭代 + 像素采样验证）
- 场景/经验: 用户看图指出三处"白块"问题（格陵兰矩形贴纸/青藏云状白斑/南极纯白条）根因各异——格陵兰=纯白 snow 色无分层+数据简化矩形；青藏"云状"=高山雪线 biome 边缘跟随 fBm 噪声而颜色纯白；南极=雪面平坦无 bathymetry 式层次；北极顶部/格陵兰南端的灰绿 tundra 另一套色系加剧割裂
- 场景/经验: 冰雪特化渲染方案：snow biome 分两支（|lat|>60 极地冰盖=近海冰架亮白→内陆蓝灰的分层渐变 [dLand/20] + 噪声杂色；|lat|<60 高山雪线=冰白掺 rock 灰白），palette 增 ice/iceDeep 双色；低纬（<28°）hypsometric 雪线止步 mount 棕。渲染后雪区从"纯白平板"变为"有层次的冰盖/雪带"
- 场景/经验: **hypsometric 混合不区分 biome 的深层 bug**——低纬孤立白雪点（横断山 101E/26N 圆形白斑）改 biome 判定无效：渲染 hei>0.66 时 `mix(col, pal.snow)` 会把任何 biome（含 rock）染白，真正修法是把低纬的雪线上限色换成 mount 棕（渲染层而非判定层）
- 场景/经验: 数据边界教训——world-atlas land-110m 南极洲南界只到 -88° 且 -84° 以下有洞（渲染成中空蓝斑），需光栅化后隐式补全 lat<-84.5° 为陆地（+2.8% 陆地，占比 32.0%）；**补全公式里纬度符号写错（90-84.5 应为 90+84.5）曾把全图误标陆地**，好在像素占比统计（陆地 95%+）立刻暴露
- 场景/经验: 经纬网格 0.18 混合在深海上过显（白线明显）、亮陆地上隐形（反差分裂）——降到 0.10 统一；网格是"海洋图装饰"，视觉上应弱到可忽略
- 决策: 待优化项更新（B 版海洋色偏脏为首要遗留；rock 0.6% 偏少；罗宾逊投影可选）；质检基准更新为陆地 32.0%；管线参数表已同步到 /root/tribe-era/docs/ART-PIPELINE.md

## 2026-08 Tetris/Phaser 3 实战（迁自长期记忆 2026-08-31）
- 环境: wsl2
- Phaser 3.90 ESM 无 default export，须 `import * as Phaser from 'phaser'`（Phaser 4 教程代码不可直接用，先确认 npm 实际版本）；`this.input.keyboard.list` 在 Phaser 3 不存在，用 this.input.keyboard.on('keydown')
- Canvas 必须 `parent: 'game-container'`，否则 append 到 body 致 flex 居中失效（scale.fit 放大到 800px 后 top=800px 画面不可见且无 JS 报错）——排查"页面无画面但无 JS 错误"先查此点
- DAS/ARR 计时统一用 `this.time.now`（game clock），keydown 里 Date.now() 与 update 的 time.now 不同源会导致 DAS 永不触发；Phaser 全局 keyboard.on('keydown') 会收 OS 层重复事件（e.repeat，按住约 500ms 后每 30ms 触发），须只保留首次按下。参数：DAS 180ms 初始延迟 + ARR 40ms
- 渲染不要每帧 `this.add.graphics()`（每帧泄漏 5 对象卡死）：持久实例 + 每帧 clear() + dirty 标记按需重绘；HUD 文本用 setText 增量更新
- 纯逻辑游戏（无碰撞/重力）不要启用 arcade physics 白占包体；浏览器验证可用 window.dispatchEvent(new KeyboardEvent('keydown', {code})) 模拟按键，keyup 需手动补发
- 项目：/root/tetris-game，Phaser 3.90 + Vite，dev 端口 3456；标准 DAS/ARR、7-bag、踢墙旋转、Hold、幽灵方块、Web Audio 合成音效（零外部资源）、localStorage 最高分、HTML 触摸按钮；src/{main,constants,physics,PlayScene}.js，物理层有 Node 单测
- 说明: 网页游戏极简指令自主迭代流程（tribe-era 实证细节）已完整落入 references/webgame-autopilot.md（2026-08-31 迁入），本处不再重复
