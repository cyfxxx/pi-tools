# Portable whisper installer (Windows PowerShell)
# 一键安装 Windows 版 whisper 服务到 tools/whisper：venv + faster-whisper + opencc + small 模型
# 幂等：已存在跳过。用法: powershell -ExecutionPolicy Bypass -File whisper-setup.ps1
# 端口 18767（避开 WSL 转发占用的 18766）；模型 small（~466MB，hf-mirror 下载；与 check-services.js 一致）
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot
$Tools = "$Root\tools"
$Dir = "$Tools\whisper"
$UV = "$Tools\uv\uv.exe"
$PY = "$Tools\python"

Write-Host '== Portable whisper installer ==' -ForegroundColor Cyan

if (-not (Test-Path $UV)) {
  Write-Host '缺少 uv——先运行 setup.ps1' -ForegroundColor Red
  exit 1
}
$env:UV_PYTHON_INSTALL_DIR = $PY

# ---- 1. venv + faster-whisper ----
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
if (-not (Test-Path "$Dir\.venv\Scripts\python.exe")) {
  Write-Host '创建 venv + 安装 faster-whisper（可能 3-8 分钟）...' -ForegroundColor Yellow
  Push-Location $Dir
  & $UV venv .venv --python 3.12
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'venv 创建失败（uv exit 非 0）' -ForegroundColor Red; exit 1 }
  & $UV pip install --python ".venv\Scripts\python.exe" faster-whisper opencc
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host '依赖安装失败（uv pip exit 非 0）' -ForegroundColor Red; exit 1 }
  Pop-Location
} else { Write-Host '  venv 已存在' }

# ---- 2. 启停脚本 ----
@"
@echo off
rem Portable whisper server (Windows) - faster-whisper
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "HF_HOME=%~dp0models"
set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HUB_DISABLE_XET=1"
set "PI_WHISPER_MODELS=%~dp0models"
set "PI_WHISPER_MODEL=small"
set "PI_WHISPER_PORT=18767"
if not exist "%~dp0models" mkdir "%~dp0models"
start "" /min "%~dp0.venv\Scripts\python.exe" "%~dp0..\..\scripts\whisper-server.py"
echo whisper server starting on http://127.0.0.1:18767 (model small, first run downloads)
"@ | Set-Content -Path "$Dir\start.bat" -Encoding ASCII
@"
@echo off
rem Stop portable whisper server (Windows)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":18767" ^| findstr "LISTENING"') do taskkill /f /pid %%p 2>nul
echo whisper stopped
"@ | Set-Content -Path "$Dir\stop.bat" -Encoding ASCII
Write-Host '  启停脚本已生成'

Write-Host ''
Write-Host '完成！启动: .\tools\whisper\start.bat（http://127.0.0.1:18767，首次下载模型 ~466MB）' -ForegroundColor Green
Write-Host 'pi-voice 配置: settings.json pi-voice.whisperEndpoint=http://127.0.0.1:18767' -ForegroundColor Yellow
