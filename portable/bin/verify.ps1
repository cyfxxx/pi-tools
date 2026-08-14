# 便携 pi 环境验证（Windows）
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

# 5. USERPROFILE 重定向冒烟测试（验证 Node homedir 跟随便携区）
$env:USERPROFILE = "$Root"
$env:HOME = "$Root"
$h = & $nodeExe -e "console.log(require('os').homedir())"
Check "homedir 重定向生效（$h）" ($h -eq "$Root")

Write-Host ""
Write-Host "结果: $ok 通过 / $fail 失败"
if ($fail -gt 0) { exit 1 }
Write-Host "全部就绪。运行 .\start.bat --continue 恢复会话" -ForegroundColor Green
