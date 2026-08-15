// check-restart.js — 供 start.bat 循环判断是否自动重启（pi wrapper）
// 用法: node check-restart.js
//   exit 0 = 有重启请求（restart/set_model/switch_session/restart_hang）→ 拉起 pi
//   exit 1 = 正常退出 → 结束
const fs = require('fs')
const path = require('path')

// pi-autopilot（agent/extensions/pi-autopilot/state.ts）把状态写到
// getAgentDir()/.pi-admin-state.json；便携版 getAgentDir() =
// PI_CODING_AGENT_DIR（start.bat 设为 %ROOT%.pi\agent），兜底
// USERPROFILE\.pi\agent。旧实现读 USERPROFILE\agent 路径不匹配，
// 导致 wrapper 永远检测不到重启请求。依次尝试候选目录。
function resolveStateFile() {
  const candidates = []
  if (process.env.PI_CODING_AGENT_DIR) candidates.push(process.env.PI_CODING_AGENT_DIR)
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, '.pi', 'agent'))
    candidates.push(path.join(process.env.USERPROFILE, 'agent'))
  }
  const list = candidates.map((dir) => path.join(dir, '.pi-admin-state.json'))
  for (const f of list) {
    try {
      if (fs.existsSync(f)) return f
    } catch { /* 候选目录不可读 → 试下一个 */ }
  }
  return list[0] || '.pi-admin-state.json'
}

const stateFile = resolveStateFile()
let hasRestart = false
try {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  hasRestart = !!(s.action && s.action !== 'none')
} catch { /* 文件缺失/损坏 → 正常退出 */ }

if (hasRestart) {
  // 消费 action：置 none 后再拉起。若 pi 启动失败（如扩展加载错误）立即崩溃，
  // wrapper 重查时已是 none，不会无限重启死循环。restartLog 保留——pi 启动后
  // consumeRestartLog 仍能读到，生成"系统已重启"恢复通知。
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
    s.action = 'none'
    const tmp = stateFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8')
    fs.renameSync(tmp, stateFile)
  } catch { /* 清除失败也照常拉起 */ }
  process.exit(0)
}
process.exit(1)
