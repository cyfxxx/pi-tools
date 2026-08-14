# 便携 pi 一键构建器（Windows）
# 用法：新建空文件夹 pi-portable → 把本脚本放进去 → 右键"使用 PowerShell 运行"
#       或：powershell -ExecutionPolicy Bypass -File setup.ps1
# 产物：node/（Node 便携版）+ pi-global/（pi 本地安装）+ .pi/（配置区）+ start.bat/start.ps1
# 全部文件在 pi-portable 内，可整体拷到 U 盘/其他机器移动使用。
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
# 自动取最新 LTS：22.x 的 zlib 无 createZstdDecompress（undici 声明支持 zstd 后
# deepseek 返回 zstd 响应 → 解压崩溃，2026-08-14 便携包实测），需 24 LTS 及以上
try {
  $nodeInfo = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $latestLts = $nodeInfo | Where-Object { $_.lts } | Select-Object -First 1
  $NodeVer = $latestLts.version.TrimStart('v')
  Write-Host "Node 版本: LTS v$NodeVer"
} catch {
  $NodeVer = '24.10.0'
  Write-Host "获取 LTS 列表失败，回退固定版本 v$NodeVer" -ForegroundColor Yellow
}
$PiPkg = '@earendil-works/pi-coding-agent'

Write-Host '== 便携 pi 构建器 ==' -ForegroundColor Cyan
Write-Host "根目录: $Root"

# ---- 1. Node 便携版 ----
$nodeExists = $false
if (Test-Path "$Root\node\node.exe") {
  $installedVer = & "$Root\node\node.exe" -v
  if ($installedVer -eq "v$NodeVer") { $nodeExists = $true }
  else { Write-Host "Node 版本不匹配（$installedVer vs v$NodeVer），重新安装" -ForegroundColor Yellow }
}
if (-not $nodeExists) {
  $zip = "$Root\node-$NodeVer-win-x64.zip"
  if (-not (Test-Path $zip)) {
    Write-Host "下载 Node v$NodeVer (约 30MB) ..."
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVer/node-v$NodeVer-win-x64.zip" -OutFile $zip
  }
  Write-Host "解压 Node ..."
  if (Test-Path "$Root\node") { Remove-Item "$Root\node" -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath "$Root\_tmp" -Force
  Move-Item "$Root\_tmp\node-v$NodeVer-win-x64" "$Root\node"
  Remove-Item "$Root\_tmp" -Recurse -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Write-Host "Node 就绪: $(& "$Root\node\node.exe" -v)"
} else {
  Write-Host "Node 已存在，跳过"
}

# ---- 2. pi 本地安装（npm --prefix，不写系统） ----
$piBin = "$Root\pi-global\pi.cmd"
if (-not (Test-Path $piBin)) {
  Write-Host "安装 pi ($PiPkg) 到本地 prefix ..."
  & "$Root\node\npm.cmd" install -g --prefix "$Root\pi-global" $PiPkg --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) { Write-Host "pi 安装失败（exit $LASTEXITCODE；npm 已走 npmmirror 镜像，检查网络）" -ForegroundColor Red; exit 1 }
  Write-Host "pi 安装完成"
} else {
  Write-Host "pi 已安装，跳过（升级：删除 pi-global 后重跑本脚本）"
}

# ---- 3. .pi 配置区 ----
New-Item -ItemType Directory -Force -Path "$Root\.pi" | Out-Null
if (-not (Test-Path "$Root\.pi\agent")) {
  Write-Host ""
  Write-Host '.pi 配置区已建（agent 子目录未初始化）' -ForegroundColor Yellow
  Write-Host '可选（二选一）：'
  Write-Host '  A. 从现有机器拷贝扩展配置:  robocopy C:\Users\你\.pi\agent .pi\agent /E'
  Write-Host '     （settings.json/models.json 含密钥，自行决定是否携带）'
  Write-Host '  B. 直接运行 start.bat——pi 首次启动自动生成骨架，之后再手动加扩展'
}

# ---- 4. 启动脚本检查（独立文件 start.bat/start.ps1 随包提供） ----
foreach ($f in @('start.bat', 'start.ps1', 'verify.ps1')) {
  if (-not (Test-Path "$Root\$f")) {
    Write-Host "警告：缺少 $f（请从原始包补齐）" -ForegroundColor Yellow
  }
}
Write-Host ""
Write-Host '完成！运行 .\start.bat 启动便携 pi' -ForegroundColor Green
Write-Host '验证环境: .\verify.ps1（检查 Node/pi/扩展）'
