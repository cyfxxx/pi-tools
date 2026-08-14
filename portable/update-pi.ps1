# Portable pi updater - pi core (npm package)
# 便携版 pi 本体升级：npm 原地升级 pi-global + 重跑补丁 + 验证
# Usage: powershell -ExecutionPolicy Bypass -File update-pi.ps1
# 注意：不要用 pi 内置更新命令（走系统 npm 路径解析，便携环境不可靠）
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Pkg = '@earendil-works/pi-coding-agent'
$PkgDir = "$Root\pi-global\node_modules\$Pkg"

Write-Host '== 便携 pi 本体升级 ==' -ForegroundColor Cyan

# ---- 1. 当前版本 ----
if (-not (Test-Path "$PkgDir\package.json")) {
  Write-Host 'pi 未安装（先运行 setup.ps1）' -ForegroundColor Red
  exit 1
}
$Old = (Get-Content "$PkgDir\package.json" -Raw | ConvertFrom-Json).version
Write-Host "当前版本: $Old"

# ---- 2. npm 原地升级（便携 npm + npmmirror 镜像） ----
Write-Host '-- npm 升级 pi-global ...' -ForegroundColor Yellow
& "$Root\node\npm.cmd" install -g --prefix "$Root\pi-global" "$Pkg@latest" --registry=https://registry.npmmirror.com
if ($LASTEXITCODE -ne 0) {
  Write-Host '升级失败（npm exit 非 0）' -ForegroundColor Red
  Write-Host "回退: & `"$Root\node\npm.cmd`" install -g --prefix `"$Root\pi-global`" `"$Pkg@$Old`" --registry=https://registry.npmmirror.com"
  exit 1
}
$New = (Get-Content "$PkgDir\package.json" -Raw | ConvertFrom-Json).version
Write-Host "版本: $Old -> $New"

# ---- 3. 重跑补丁（升级 dist 后补丁失效；只跑存在的） ----
foreach ($patch in @('patch-footer-live-context.mjs', 'patch-voice-enter.mjs', 'patch-plan-tools.mjs')) {
  $p = Join-Path $Root $patch
  if (Test-Path $p) {
    Write-Host "-- 重跑补丁 $patch"
    & "$Root\node\node.exe" $p
  }
}

# ---- 4. 验证 ----
& "$Root\verify.ps1"

Write-Host ''
Write-Host '完成！运行 .\start.bat --continue 启动' -ForegroundColor Green
