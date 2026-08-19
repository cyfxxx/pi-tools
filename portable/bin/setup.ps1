# 便携 pi 一键构建器（Windows）
# 用法：新建空文件夹 pi-portable → 把本脚本放进去 → 右键"使用 PowerShell 运行"
#       或：powershell -ExecutionPolicy Bypass -File setup.ps1
# 产物：node/（Node 便携版）+ pi-global/（pi 本地安装）+ memory/（数据区）+ .pi/（配置区，junction 指向 agent/memory，自动创建）+ start.bat/start.ps1
# 全部文件在 pi-portable 内，可整体拷到 U 盘/其他机器移动使用。
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot
# 自动取最新 LTS：22.x 的 zlib 无 createZstdDecompress（undici 声明支持 zstd 后
# deepseek 返回 zstd 响应 → 解压崩溃，2026-08-14 便携包实测），需 24 LTS 及以上
try {
  $nodeInfo = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $latestLts = $nodeInfo | Where-Object { $_.lts } | Select-Object -First 1
  $NodeVer = $latestLts.version.TrimStart('v')
  Write-Host "Node 版本: LTS v$NodeVer"
} catch {
  # nodejs.org 不可达 → npmmirror 镜像（国内 20MB/s）
  try {
    $nodeInfo = Invoke-RestMethod -Uri 'https://npmmirror.com/mirrors/node/index.json' -TimeoutSec 30
    $latestLts = $nodeInfo | Where-Object { $_.lts } | Select-Object -First 1
    $NodeVer = $latestLts.version.TrimStart('v')
    Write-Host "Node 版本（npmmirror 镜像）: LTS v$NodeVer"
  } catch {
    $NodeVer = '24.10.0'
    Write-Host "获取 LTS 列表失败，回退固定版本 v$NodeVer" -ForegroundColor Yellow
  }
}
$PiPkg = '@earendil-works/pi-coding-agent'

# ---- 下载函数：curl 测速 + 慢速/超时自动换源 ----
# curl.exe（Win10+ 自带，绕开 Invoke-WebRequest 慢与无速度控制）：
#   --speed-limit 51200 --speed-time 15 = 速度连续 15s 低于 50KB/s 判失败（慢速换源）
#   --max-time 900 = 总超时兜底；-w '%{speed_download}' = 输出平均速度（bytes/s）
#   成功返回 $true；失败删残文件返回 $false（调用方换下一个源）
function Invoke-DownloadWithSpeed {
  param($Url, $OutFile, $Label)
  # PS 5.1 陷阱：native 命令写 stderr + $ErrorActionPreference=Stop →
  # 抛 NativeCommandError 直接崩脚本（curl 401 实测）——函数内降级 + try/catch
  $ErrorActionPreference = 'Continue'
  $raw = $null; $code = -1
  try {
    $raw = & curl.exe -L --fail --silent --show-error --speed-limit 51200 --speed-time 15 --max-time 900 --output $OutFile -w '%{speed_download}' $Url 2>&1
    $code = $LASTEXITCODE
  } catch {
    Write-Host "  [XX] $Label 源异常（curl stderr 触发 PS 异常），换源" -ForegroundColor Yellow
  }
  if ($code -eq 0 -and $null -ne $raw) {
    # 内容验证：代理可能返回 200 但 0 字节/错误页（curl --fail 拦不住）——大小兜底
    $len = (Get-Item $OutFile -ErrorAction SilentlyContinue).Length
    if ($len -lt 1KB) {
      Write-Host "  [XX] $Label 文件异常（${len}B，疑似代理空响应），换源" -ForegroundColor Yellow
      Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
      return $false
    }
    # 格式验证：zip 前 4 字节 PK\x03\x04 / 7z 前 2 字节 7z / gzip 1F 8B
    # （代理可能返回 200 但内容为错误页/HTML——大小够但不一定是压缩包）
    $fs = [System.IO.File]::OpenRead($OutFile)
    $magic = New-Object byte[] 4
    [void]$fs.Read($magic, 0, 4)
    $fs.Close()
    $okMagic = ($magic[0] -eq 0x50 -and $magic[1] -eq 0x4B) -or
               ($magic[0] -eq 0x37 -and $magic[1] -eq 0x7A) -or
               ($magic[0] -eq 0x1F -and $magic[1] -eq 0x8B) -or
               ($magic[0] -eq 0x4D -and $magic[1] -eq 0x5A) # MZ（PE/自解压）
    if (-not $okMagic) {
      Write-Host "  [XX] $Label 文件格式异常（非 zip/7z/exe，疑似代理错误页），换源" -ForegroundColor Yellow
      Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
      return $false
    }
    $speed = [double](($raw | Select-Object -Last 1).Trim())
    $mb = [math]::Round($speed / 1MB, 2)
    Write-Host "  [OK] $Label 完成（$mb MB/s）" -ForegroundColor Green
    return $true
  }
  Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
  Write-Host "  [XX] $Label 下载失败/过慢（curl exit $code），尝试下一个源" -ForegroundColor Yellow
  return $false
}
function Get-FileMultiSource {
  param($Urls, $OutFile, $Label)
  foreach ($u in $Urls) {
    if (Invoke-DownloadWithSpeed -Url $u -OutFile $OutFile -Label $Label) { return $true }
  }
  Write-Host "$Label 全部源失败（检查网络后重跑本脚本）" -ForegroundColor Red
  return $false
}

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
    $urls = @(
      "https://nodejs.org/dist/v$NodeVer/node-v$NodeVer-win-x64.zip",
      "https://npmmirror.com/mirrors/node/v$NodeVer/node-v$NodeVer-win-x64.zip"
    )
    if (-not (Get-FileMultiSource -Urls $urls -OutFile $zip -Label "Node v$NodeVer")) { exit 1 }
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
# memory 数据目录（pi-memory 运行时数据；junction 目标必须存在，否则悬空 junction
# 导致写入时 mkdir ENOENT）
New-Item -ItemType Directory -Force -Path "$Root\memory" | Out-Null
if (-not (Test-Path "$Root\.pi\agent")) {
  Write-Host ""
  Write-Host '.pi 配置区已建（agent 子目录未初始化）' -ForegroundColor Yellow
  Write-Host '可选（二选一）：'
  Write-Host '  A. 从现有机器拷贝扩展配置:  robocopy C:\Users\你\.pi\agent .pi\agent /E'
  Write-Host '     （settings.json/models.json 含密钥，自行决定是否携带）'
  Write-Host '  B. 直接运行 start.bat——pi 首次启动自动生成骨架，之后再手动加扩展'
}
# 自动建 junction（.pi\agent -> agent、.pi\memory -> memory；已存在则跳过）
# 目标不存在时先创建，避免悬空 junction（Windows 悬空 junction 上 mkdir 会 ENOENT）
foreach ($pair in @(@('agent', 'agent'), @('memory', 'memory'))) {
  $link = "$Root\.pi\$($pair[0])"
  $target = "$Root\$($pair[1])"
  if (Test-Path $link) {
    $lt = (Get-Item $link -Force).LinkType
    if ($lt -ne 'Junction') { Write-Host "  注意：$link 是普通目录（非 junction），跳过" -ForegroundColor Yellow }
  } else {
    if (-not (Test-Path $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
    if (Test-Path $target) {
      cmd /c mklink /J "`"$link`"" "`"$target`"" | Out-Null
      if (Test-Path $link) { Write-Host "  建 junction: .pi\$($pair[0]) -> $target" }
      else { Write-Host "  建 junction 失败: $link" -ForegroundColor Yellow }
    }
  }
}

# ---- 4. 工具组件（ffmpeg/PortableGit 下载；ca-bundle/tmux shim 随仓库 portable/ 提供） ----
# gh-proxy 系镜像池（按实测速度排序；直连兜底）
# 2026-08-15 实测：ghproxy.net 362KB/s > gh.ddlc.top 180KB/s > gh-proxy.com 49KB/s
# （gh-proxy.net 大文件 401 错误页、ghfast.top/ghproxy.cc 连接失败——已剔除）
$Mirrors = @('https://ghproxy.net/', 'https://gh.ddlc.top/', 'https://gh-proxy.com/')
$Tools = "$Root\tools"
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
Write-Host '== 工具组件 ==' -ForegroundColor Cyan

# ca-bundle + tmux shim（随本目录/仓库 portable/ 提供，直接拷入）
foreach ($src in @("$Root\ca-bundle.crt", "$Root\portable\ca-bundle.crt", "$Root\portable\tools\tmux\tmux.cmd")) {
  if (Test-Path $src) {
    if ($src -like '*tmux.cmd') { $rel = 'tmux\tmux.cmd' } else { $rel = 'ca-bundle.crt' }
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
  if (-not ((Test-Path $ffzip) -and (Get-Item $ffzip).Length -gt 1MB)) {
  $urls = @()
  foreach ($m in $Mirrors) { $urls += "${m}https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" }
  $urls += 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
    if (-not (Get-FileMultiSource -Urls $urls -OutFile $ffzip -Label 'ffmpeg')) { exit 1 }
  } else { Write-Host '  ffmpeg.zip 已存在，跳过下载（解压后自动清理）' }
  Remove-Item "$Tools\ffmpeg-master-latest-win64-gpl" -Recurse -Force -ErrorAction SilentlyContinue
  & "$env:SystemRoot\System32\tar.exe" -xf $ffzip -C $Tools 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [XX] ffmpeg 解压失败（tar exit $LASTEXITCODE），删除残留重跑重下" -ForegroundColor Red
    Remove-Item $ffzip -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Remove-Item $ffzip -Force
  # 解压目录带版本名（ffmpeg-master-latest-win64-gpl/），bin/ 内容移入固定 tools/ffmpeg/
  # （先建目标目录——Move-Item 目标不存在时是"重命名"，会丢失 bin/ 层，
  #   与 start.bat/verify.ps1 期望的 tools\ffmpeg\bin\ 不一致）
  if (Test-Path "$Tools\ffmpeg-master-latest-win64-gpl\bin") {
    Remove-Item "$Tools\ffmpeg" -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path "$Tools\ffmpeg\bin" | Out-Null
    Move-Item "$Tools\ffmpeg-master-latest-win64-gpl\bin\*" "$Tools\ffmpeg\bin\" -Force
    Remove-Item "$Tools\ffmpeg-master-latest-win64-gpl" -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path "$Tools\ffmpeg\bin\ffmpeg.exe") {
    $ffv = & "$Tools\ffmpeg\bin\ffmpeg.exe" -version 2>$null | Select-Object -First 1
    Write-Host "  ffmpeg 就绪: $ffv"
  } else { Write-Host "  [XX] ffmpeg 未就绪（bin\ffmpeg.exe 缺失）" -ForegroundColor Red }
} else { Write-Host '  ffmpeg 已存在，跳过' }

# uv（searxng/whisper venv 的 Python 运行时；单文件 ~15MB，双源 fallback）
if (-not (Test-Path "$Tools\uv\uv.exe")) {
  Write-Host '下载 uv（约 15MB）...' -ForegroundColor Yellow
  $uvzip = "$Tools\uv.zip"
  if (-not ((Test-Path $uvzip) -and (Get-Item $uvzip).Length -gt 1MB)) {
  $urls = @()
  foreach ($m in $Mirrors) { $urls += "${m}https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" }
  $urls += 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
    if (-not (Get-FileMultiSource -Urls $urls -OutFile $uvzip -Label 'uv')) { exit 1 }
  } else { Write-Host '  uv.zip 已存在，跳过下载' }
  New-Item -ItemType Directory -Force -Path "$Tools\uv" | Out-Null
  Expand-Archive -Path $uvzip -DestinationPath "$Tools\uv" -Force
  Remove-Item $uvzip -Force
  if (Test-Path "$Tools\uv\uv.exe") {
    Write-Host "  uv 就绪: $(& "$Tools\uv\uv.exe" --version 2>$null)"
  } else { Write-Host "  [XX] uv 未就绪（uv.exe 缺失）" -ForegroundColor Red }
} else { Write-Host '  uv 已存在，跳过' }

# PortableGit（git 命令；Windows 自带 tar 支持解压 7z）
if (-not (Test-Path "$Tools\PortableGit\cmd\git.exe")) {
  Write-Host '下载 PortableGit（约 57MB）...' -ForegroundColor Yellow
  $pg = "$Tools\PortableGit.7z.exe"
  if (-not ((Test-Path $pg) -and (Get-Item $pg).Length -gt 1MB)) {
  $urls = @()
  foreach ($m in $Mirrors) { $urls += "${m}https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/PortableGit-2.55.0.4-64-bit.7z.exe" }
  $urls += 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/PortableGit-2.55.0.4-64-bit.7z.exe'
    if (-not (Get-FileMultiSource -Urls $urls -OutFile $pg -Label 'PortableGit')) { exit 1 }
  } else { Write-Host '  PortableGit.7z 已存在，跳过下载' }
  New-Item -ItemType Directory -Force -Path "$Tools\PortableGit" | Out-Null
  # .7z.exe 是 7z 自解压包：-o 指定目标 -y 静默
  # 注意：7z SFX 是 GUI 子系统——PS 5.1 的 & 调用不等待（立即返回），
  # 必须 Start-Process -Wait 等解压完成（实测：& 返回时 git.exe 未解压完→误判失败）
  New-Item -ItemType Directory -Force -Path "$Tools\PortableGit" | Out-Null
  $sfx = Start-Process -FilePath $pg -ArgumentList "-o`"$Tools\PortableGit`"", '-y' -Wait -PassThru
  if ($sfx.ExitCode -ne 0 -or -not (Test-Path "$Tools\PortableGit\cmd\git.exe")) {
    # SFX 失败兜底：Windows tar（libarchive）读 7z SFX（部分 LZMA 变体不支持）
    & "$env:SystemRoot\System32\tar.exe" -xf $pg -C "$Tools\PortableGit" 2>$null
  }
  if (-not (Test-Path "$Tools\PortableGit\cmd\git.exe")) {
    Write-Host "  [XX] PortableGit 解压失败，删除残留重跑重下" -ForegroundColor Red
    Remove-Item $pg -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Remove-Item $pg -Force
  if (Test-Path "$Tools\PortableGit\cmd\git.exe") {
    Write-Host "  PortableGit 就绪: $(& "$Tools\PortableGit\cmd\git.exe" --version 2>$null)"
  } else { Write-Host "  [XX] PortableGit 未就绪（cmd\git.exe 缺失）" -ForegroundColor Red }
} else { Write-Host '  PortableGit 已存在，跳过' }

# ---- 4b. 扩展依赖（统一根 agent/：全部扩展共享，Node 向上寻径解析） ----
$AgentRoot = "$Root\.pi\agent"
if (Test-Path "$AgentRoot\package.json") {
  Write-Host '-- 扩展依赖（agent/node_modules 统一根）' -ForegroundColor Cyan
  if (-not (Test-Path "$AgentRoot\node_modules")) {
    Write-Host '  安装依赖 ...'
    & "$Root\node\npm.cmd" install --prefix $AgentRoot --registry=https://registry.npmmirror.com 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host '  [OK] agent 依赖' } else { Write-Host '  [XX] agent 依赖安装失败（可稍后手动: npm install --prefix <agent>）' -ForegroundColor Yellow }
  } else { Write-Host '  agent 依赖已就绪，跳过' }
} else { Write-Host '-- agent/package.json 不存在，跳过依赖安装（.pi/agent 未拷贝时正常）' -ForegroundColor Yellow }

# ---- 4c. 核心补丁（pi dist 每次更新后失效，setup/update 后重跑） ----
$Dist = "$Root\pi-global\node_modules\@earendil-works\pi-coding-agent\dist"
if (Test-Path "$Dist\cli.js") {
  Write-Host '-- 核心补丁' -ForegroundColor Cyan
  foreach ($patch in @('patch-footer-live-context.mjs', 'patch-voice-enter.mjs', 'patch-plan-tools.mjs')) {
    $p = Join-Path $PSScriptRoot $patch
    if (Test-Path $p) {
      Write-Host "  应用 $patch"
      & "$Root\node\node.exe" $p $Dist 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Host "  ✓ $patch" } else { Write-Host "  ✗ $patch 失败（exit $LASTEXITCODE）" -ForegroundColor Yellow }
    }
  }
} else { Write-Host '-- 核心补丁：pi 未安装，跳过（setup 步骤 2 后再跑）' -ForegroundColor Yellow }

# ---- 5. 启动脚本检查（start.bat/start.ps1 在包根、verify.ps1 在 bin/） ----
foreach ($f in @('start.bat', 'start.ps1')) {
  if (-not (Test-Path "$Root\$f")) {
    Write-Host "警告：缺少 $f（请从原始包补齐）" -ForegroundColor Yellow
  }
}
if (-not (Test-Path "$Root\bin\verify.ps1")) {
  Write-Host "警告：缺少 bin\verify.ps1（请从原始包补齐）" -ForegroundColor Yellow
}
Write-Host ""
Write-Host '== 构建完成 ==' -ForegroundColor Green
Write-Host '1. 建 junction（.pi 配置区指向 agent/memory）:'
Write-Host '   cmd /c mklink /J ".pi\agent" "agent"'
Write-Host '   cmd /c mklink /J ".pi\memory" "memory"'
Write-Host '2. 验证环境: .\bin\verify.ps1（Node/pi/扩展/组件）'
Write-Host '3. 可选组件（按需）:'
Write-Host '   - 本地搜索: .\bin\searxng-setup.ps1（uv 已就绪，3-8 分钟）'
Write-Host '   - 语音转写: .\bin\whisper-setup.ps1（small 模型 ~466MB）'
Write-Host '   - 浏览器:   手动下载官方定制版解压 .cloakbrowser\（562MB，pi-browser README）'
Write-Host '4. 启动: .\start.bat --continue（自动拉起已装服务）'
