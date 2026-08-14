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

# ---- 4. 工具组件（ffmpeg/PortableGit 下载；ca-bundle/tmux shim 随仓库 portable/ 提供） ----
$Mirror = 'https://gh-proxy.net/'
$Tools = "$Root\tools"
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
Write-Host '== 工具组件 ==' -ForegroundColor Cyan

# ca-bundle + tmux shim（随本目录/仓库 portable/ 提供，直接拷入）
foreach ($src in @("$PSScriptRoot\ca-bundle.crt", "$PSScriptRoot\tools\tmux\tmux.cmd")) {
  if (Test-Path $src) {
    $rel = $src.Substring($PSScriptRoot.Length).TrimStart('\')
    $dst = Join-Path $Tools $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $src $dst -Force
    Write-Host "  ✓ $rel"
  }
}

# ffmpeg（Windows 构建；GitHub 被墙时走 gh-proxy 镜像，双源 fallback）
if (-not (Test-Path "$Tools\ffmpeg\bin\ffmpeg.exe")) {
  Write-Host '下载 ffmpeg（约 85MB）...' -ForegroundColor Yellow
  $ffzip = "$Tools\ffmpeg.zip"
  $urls = @(
    "${Mirror}https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  )
  $ok = $false
  foreach ($u in $urls) {
    try { Invoke-WebRequest -Uri $u -OutFile $ffzip -TimeoutSec 300; $ok = $true; break }
    catch { Write-Host '  该源下载失败，尝试下一个...' -ForegroundColor Yellow }
  }
  if (-not $ok) { Write-Host 'ffmpeg 下载失败（检查网络后重跑本脚本）' -ForegroundColor Red; exit 1 }
  tar -xf $ffzip -C $Tools
  Remove-Item $ffzip -Force
  # 解压目录带版本名（ffmpeg-master-latest-win64-gpl/），bin/ 移为固定 tools/ffmpeg
  if (Test-Path "$Tools\ffmpeg-master-latest-win64-gpl\bin") {
    Remove-Item "$Tools\ffmpeg" -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item "$Tools\ffmpeg-master-latest-win64-gpl\bin" "$Tools\ffmpeg"
    Remove-Item "$Tools\ffmpeg-master-latest-win64-gpl" -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  ffmpeg 就绪: $(& "$Tools\ffmpeg\bin\ffmpeg.exe" -version 2>$null | Select-Object -First 1)"
} else { Write-Host '  ffmpeg 已存在，跳过' }

# PortableGit（git 命令；Windows 自带 tar 支持解压 7z）
if (-not (Test-Path "$Tools\PortableGit\cmd\git.exe")) {
  Write-Host '下载 PortableGit（约 57MB）...' -ForegroundColor Yellow
  $pg = "$Tools\PortableGit.7z"
  $urls = @(
    "${Mirror}https://github.com/git-for-windows/git/releases/download/v2.55.0.4/PortableGit-2.55.0.4-64-bit.7z",
    'https://github.com/git-for-windows/git/releases/download/v2.55.0.4/PortableGit-2.55.0.4-64-bit.7z'
  )
  $ok = $false
  foreach ($u in $urls) {
    try { Invoke-WebRequest -Uri $u -OutFile $pg -TimeoutSec 300; $ok = $true; break }
    catch { Write-Host '  该源下载失败，尝试下一个...' -ForegroundColor Yellow }
  }
  if (-not $ok) { Write-Host 'PortableGit 下载失败（检查网络后重跑本脚本）' -ForegroundColor Red; exit 1 }
  New-Item -ItemType Directory -Force -Path "$Tools\PortableGit" | Out-Null
  tar -xf $pg -C "$Tools\PortableGit"
  Remove-Item $pg -Force
  Write-Host "  PortableGit 就绪: $(& "$Tools\PortableGit\cmd\git.exe" --version 2>$null)"
} else { Write-Host '  PortableGit 已存在，跳过' }

# ---- 5. 启动脚本检查（独立文件 start.bat/start.ps1 随包提供） ----
foreach ($f in @('start.bat', 'start.ps1', 'verify.ps1')) {
  if (-not (Test-Path "$Root\$f")) {
    Write-Host "警告：缺少 $f（请从原始包补齐）" -ForegroundColor Yellow
  }
}
Write-Host ""
Write-Host '完成！运行 .\start.bat 启动便携 pi' -ForegroundColor Green
Write-Host '验证环境: .\verify.ps1（检查 Node/pi/扩展）'
