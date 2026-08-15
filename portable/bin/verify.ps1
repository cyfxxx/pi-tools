# 便携 pi 环境验证（Windows）
# 检查：node/pi/扩展/组件/junction 有效性/三补丁 marker/配置路径漂移/homedir 重定向
# 用法：powershell -ExecutionPolicy Bypass -File verify.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot
$ok = 0; $fail = 0
function Check($name, $cond) {
  if ($cond) { Write-Host "  [OK] $name" -ForegroundColor Green; $script:ok++ }
  else { Write-Host "  [XX] $name" -ForegroundColor Red; $script:fail++ }
}

Write-Host '== 便携 pi 环境验证 ==' -ForegroundColor Cyan
Write-Host "根目录: $Root"

# 1. Node
$nodeExe = "$Root\node\node.exe"
if (Test-Path $nodeExe) {
  $nv = & $nodeExe -v
  Check "Node $nv（便携版存在）" $true
} else { Check 'Node 便携版（node\node.exe）' $false }

# 2. pi
$piCmd = @("$Root\pi-global\pi.cmd", "$Root\pi-global\node_modules\.bin\pi.cmd", "$Root\pi-global\bin\pi.cmd") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($piCmd) {
  Check "pi 已安装（$piCmd）" $true
} else { Check 'pi 已安装' $false }

# 3. .pi 配置区（USERPROFILE 重定向目标）
Check '.pi 配置区存在' (Test-Path "$Root\.pi")
Check 'agent 目录存在（含扩展）' (Test-Path "$Root\.pi\agent")
if (Test-Path "$Root\.pi\agent\extensions") {
  $exts = Get-ChildItem "$Root\.pi\agent\extensions" -Directory | Select-Object -ExpandProperty Name
  Check "扩展目录（$($exts.Count) 个: $($exts -join ', ')）" ($exts.Count -gt 0)
} else { Check '扩展目录（.pi\agent\extensions）' $false }

# 4. 启动脚本
Check 'start.bat 存在' (Test-Path "$Root\start.bat")
Check 'start.ps1 存在' (Test-Path "$Root\start.ps1")

# 4b. 核心组件（setup.ps1 自动构建）
Check 'ffmpeg（tools\ffmpeg\bin\ffmpeg.exe）' (Test-Path "$Root\tools\ffmpeg\bin\ffmpeg.exe")
Check 'PortableGit（tools\PortableGit\usr\bin\bash.exe）' (Test-Path "$Root\tools\PortableGit\usr\bin\bash.exe")
Check 'uv（tools\uv\uv.exe）' (Test-Path "$Root\tools\uv\uv.exe")

# 4b2. 可选组件（需额外 setup 脚本/手动部署；缺失不判失败）
Write-Host '-- 可选组件（缺失属正常，按需构建）' -ForegroundColor DarkGray
$opt = 0; $optMiss = @()
function OptCheck($name, $cond) {
  if ($cond) { Write-Host "  [OK] $name" -ForegroundColor DarkGray; $script:opt++ }
  else { $script:optMiss += $name }
}
OptCheck '便携 Python（tools\python）' (Test-Path "$Root\tools\python")
OptCheck 'searxng venv（tools\searxng\.venv）' (Test-Path "$Root\tools\searxng\.venv\Scripts\python.exe")
OptCheck 'whisper venv（tools\whisper\.venv）' (Test-Path "$Root\tools\whisper\.venv\Scripts\python.exe")
OptCheck 'whisper opencc（繁→简转换）' (Test-Path "$Root\tools\whisper\.venv\Lib\site-packages\opencc")
OptCheck 'pi-browser 浏览器（.cloakbrowser 或 tools\chrome-win64）' ((Test-Path "$Root\.cloakbrowser") -or (Test-Path "$Root\tools\chrome-win64"))
if ($optMiss.Count -gt 0) { Write-Host "  缺失: $($optMiss -join ', ')（构建: searxng-setup.ps1 / whisper-setup.ps1 / 手动浏览器）" -ForegroundColor DarkGray }

# 4c. 服务端口（启动中可能未就绪——仅提示不判失败）
$svcNote = @()
if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 8890 -WarningAction SilentlyContinue -InformationLevel Quiet -ErrorAction SilentlyContinue)) { $svcNote += 'searxng(8890)' }
if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 18767 -WarningAction SilentlyContinue -InformationLevel Quiet -ErrorAction SilentlyContinue)) { $svcNote += 'whisper(18767)' }
if ($svcNote.Count -gt 0) { Write-Host "  [..] 服务未监听（启动 start.bat 自动拉起）: $($svcNote -join ', ')" -ForegroundColor Yellow }

# 4c. 核心补丁（pi dist 每次更新后失效，setup/update 后重跑）
$Dist = "$Root\pi-global\node_modules\@earendil-works\pi-coding-agent\dist"
if (Test-Path "$Dist\cli.js") {
  $patchChecks = @(
    @('footer-live-context', 'modes\interactive\components\footer.js', 'Patch (patch-footer-live-context.mjs)'),
    @('voice-enter', 'modes\interactive\interactive-mode.js', 'Patch (patch-voice-enter.mjs)'),
    @('plan-tools', 'core\agent-session.js', 'Patch (patch-plan-tools.mjs)')
  )
  foreach ($pc in $patchChecks) {
    $pf = "$Dist\$($pc[1])"
    if (Test-Path $pf) {
      $hit = Select-String -Path $pf -Pattern $pc[2] -SimpleMatch -Quiet
      Check "补丁 $($pc[0]) 已应用（marker）" ($hit -eq $true)
    } else { Check "补丁 $($pc[0]) 目标文件（$($pc[1])）" $false }
  }
} else { Check 'pi dist（补丁目标）' $false }

# 4d. 配置绝对路径漂移检查（重建/迁移后 settings.json/pi-voice.json 可能残留旧包路径）
# shellPath 指向不存在的路径时 pi 的 bash 工具直接 throw；指向包外路径则挪机后失效。
# 仅提示（黄），不计入失败——用户可能有意的外部路径（如自定义 ffmpeg）。
Write-Host '-- 配置路径漂移检查' -ForegroundColor DarkGray
$drift = @()
$cfgFile = "$Root\agent\settings.json"
if (Test-Path $cfgFile) {
  try {
    $s = Get-Content $cfgFile -Raw | ConvertFrom-Json
    if ($s.shellPath) {
      if (-not (Test-Path $s.shellPath)) { $drift += "settings.json shellPath 不存在: $($s.shellPath)（bash 工具会报错，建议改成本包 tools\PortableGit\bin\bash.exe）" }
      elseif (-not ($s.shellPath -replace '\\', '/').StartsWith(($Root -replace '\\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) { $drift += "settings.json shellPath 指向包外: $($s.shellPath)" }
    }
  } catch {}
}
$pvFile = "$Root\agent\pi-voice.json"
if (Test-Path $pvFile) {
  try {
    $pv = Get-Content $pvFile -Raw | ConvertFrom-Json
    if ($pv.micBin -and -not ($pv.micBin -replace '\\', '/').StartsWith(($Root -replace '\\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) { $drift += "pi-voice.json micBin 指向包外: $($pv.micBin)" }
  } catch {}
}
if ($drift.Count -gt 0) { Write-Host "  [..] $($drift -join '; ')" -ForegroundColor Yellow }
else { Write-Host '  [OK] 无包外路径引用' -ForegroundColor DarkGray }

# 5. USERPROFILE 重定向冒烟测试（验证 Node homedir 跟随便携区）
$env:USERPROFILE = "$Root"
$env:HOME = "$Root"
$h = & $nodeExe -e "console.log(require('os').homedir())"
Check "homedir 重定向生效（$h）" ($h -eq "$Root")

Write-Host ""
Write-Host "结果: $ok 核心通过 / $fail 失败 / $opt 可选组件就绪"
if ($fail -gt 0) { exit 1 }
Write-Host "核心全部就绪。运行 .\start.bat --continue 恢复会话" -ForegroundColor Green
