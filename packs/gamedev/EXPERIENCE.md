# gamedev 经验沉淀（EXPERIENCE.md）

按 packs/README.md「经验沉淀机制」追加；条目 ≥3 条或用户要求时合并进 SKILL.md/对应子技能正文后清档。环境必须标注，防跨设备误会。

## 2026-06 Godot 收编与实机链路（环境：termux-ubuntu proot aarch64）

- **下载通道**：GitHub release/TuxFamily/ghproxy 镜像均不可用；Godot 官网 CDN 可达——真实后端 `godot-releases.nbg1.your-objectstorage.com/<版本>-stable/<文件名>`（downloads.godotengine.org 302 跳转过去），速度 ~330KB/s 需断点/后台下载；apk 317MB、linux arm64 zip 77MB
- **本机运行**：官方 linux.arm64 二进制在 proot-Ubuntu aarch64 直接跑通（`--version`、`--headless --script` 冒烟）；以 root 运行有 superuser 警告，设 `GODOT_SILENCE_ROOT_WARNING=1` 抑制
- **宿主设备直访**：proot 可读写宿主安卓共享存储，项目目录 `/storage/emulated/0/Godot/projects/` 设备端 Godot 编辑器直接打开；`Android/data` 不可读（伪 root）
- **adb 不可用（华为）**：无线调试入口被 ROM 隐藏；5555 端口开放但授权弹窗永不出现，connect 恒 offline——不要再走 adb 路线
- **最小项目格式**：`[sub_resource type="Label"]` 是错误写法（Label 是节点非资源，Parse Error）；Label 直接作 node 属性即可；headless 冒烟命令 `godot --headless --path <dir> --quit-after 2`
- **收编教训（整合原则触发点）**：本次 `cp -r` 整目录收编上游 godot/ 无 diff 保护——后续重拉上游必须按 packs/README.md「更新与整合原则」对照本地差异手工合并（本地环境备注/定向修改是超集，禁止覆盖）