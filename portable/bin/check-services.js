// check-services.js — 便携包服务自启（start.bat 启动前调用）
// 检测 searxng(8890) / whisper(18767) 端口，未监听则直接 spawn base python 拉起（detached）
// 用法: node check-services.js
// 幂等：端口已监听跳过；直接 spawn 绕开 cmd 嵌套（实测 cmd /c start 嵌套失败）
// 服务进程：base python（tools/python/cpython-*/python.exe）+ PYTHONPATH 注入 venv site-packages——
// 不经 venv Scripts\python.exe（uv trampoline），否则内部 spawn 的 base python 不受 windowsHide
// 控制，会弹两个常驻终端窗口（searxng/whisper）。日志: .pi/logs/{searxng,whisper}.log
const net = require('net')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = process.env.USERPROFILE || process.cwd()
const LOG_DIR = path.join(ROOT, '.pi', 'logs')
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}

function portOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const timer = setTimeout(() => { sock.destroy(); resolve(false) }, timeoutMs)
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true) })
    sock.once('error', () => { clearTimeout(timer); resolve(false) })
    sock.connect(port, '127.0.0.1')
  })
}

function resolveBasePython() {
  // 直接使用 base python（tools/python/cpython-*/python.exe），不经 venv 的
  // uv trampoline——trampoline 内部 spawn 的 base python 不受 windowsHide 控制，
  // 会弹两个常驻终端窗口（searxng/whisper）。venv 只作为 site-packages 包仓库，
  // 通过 PYTHONPATH 注入。目录名自适应（cpython-3.12-windows-x86_64-none）。
  const pyRoot = path.join(ROOT, 'tools', 'python')
  try {
    const dir = fs.readdirSync(pyRoot).find((d) => d.startsWith('cpython'))
    if (dir) {
      const exe = path.join(pyRoot, dir, 'python.exe')
      if (fs.existsSync(exe)) return exe
    }
  } catch { /* tools/python 缺失 → 走旧路径 */ }
  return null
}

function spawnPython(relDir, args, env, logName) {
  const dir = path.join(ROOT, relDir)
  const basePy = resolveBasePython()
  const py = basePy || path.join(dir, '.venv', 'Scripts', 'python.exe')
  if (!fs.existsSync(py)) {
    console.log(`[svc] ${relDir} 的 python 不存在，跳过`)
    return
  }
  const log = path.join(LOG_DIR, `${logName}.log`)
  const out = fs.openSync(log, 'a')
  // base python + PYTHONPATH 注入 venv site-packages（不执行 venv trampoline）
  const pyEnv = { ...process.env, ...env }
  if (basePy) {
    const sp = path.join(dir, '.venv', 'Lib', 'site-packages')
    pyEnv.PYTHONPATH = fs.existsSync(sp) ? sp : ''
  }
  const child = spawn(py, args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: pyEnv,
  })
  // spawn 异步 error（EACCES/文件被删竞态）→ 记录日志不崩溃（无监听器会抛未捕获异常）
  child.on('error', (e) => {
    console.log(`[svc] ${logName} 启动失败: ${e.message}`)
    try { fs.closeSync(out) } catch {}
  })
  child.unref()
  console.log(`[svc] ${logName} 已拉起（${relDir}）`)
}

async function main() {
  // 1. searxng (8890)
  if (!(await portOpen(8890, 1000))) {
    console.log('[svc] searxng 8890 未监听，拉起...')
    spawnPython('tools\\searxng', ['-m', 'searx.webapp'], {
      SEARXNG_SETTINGS_PATH: path.join(ROOT, 'tools', 'searxng', 'settings.yml'),
    }, 'searxng')
  } else {
    console.log('[svc] searxng 8890 已就绪')
  }
  // 2. whisper (18767)
  if (!(await portOpen(18767, 1000))) {
    console.log('[svc] whisper 18767 未监听，拉起...')
    spawnPython('tools\\whisper', [path.join(ROOT, 'scripts', 'whisper-server.py')], {
      HF_HOME: path.join(ROOT, 'tools', 'whisper', 'models'),
      HF_ENDPOINT: 'https://hf-mirror.com',
      HF_HUB_DISABLE_XET: '1',
      PI_WHISPER_MODELS: path.join(ROOT, 'tools', 'whisper', 'models'),
      PI_WHISPER_MODEL: 'small',
      PI_WHISPER_PORT: '18767',
      PI_WHISPER_LANGUAGE: 'zh',
      // 与 whisper-setup.ps1 生成的 start.bat 一致：中文环境 stdout 重定向需要 UTF-8
      PYTHONUTF8: '1',
    }, 'whisper')
  } else {
    console.log('[svc] whisper 18767 已就绪')
  }
  process.exit(0)
}

main()
