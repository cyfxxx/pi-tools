# Portable pi updater (Windows PowerShell)
# Cleanup useless files + pull latest code + sync + verify
# Usage: powershell -ExecutionPolicy Bypass -File E:\pi-portable\update-portable.ps1
$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot
$Tmp = "$Root\.tmp-update"
$Agent = "$Root\.pi\agent"

Write-Host '== Portable pi update ==' -ForegroundColor Cyan

# ---- 1. Remove useless files ----
Write-Host '-- Cleanup' -ForegroundColor Yellow
Remove-Item "$Agent\bin\fd", "$Agent\bin\rg" -Force -ErrorAction SilentlyContinue
Write-Host '  removed bin/fd + bin/rg (Linux binaries)'
Remove-Item "$Agent\sessions\--root--" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '  removed sessions/--root-- (empty snapshot)'
Remove-Item "$Agent\scheduler.lock" -Force -ErrorAction SilentlyContinue
Write-Host '  removed scheduler.lock'

# ---- 2. Clone latest (gh-proxy mirror) ----
Write-Host '-- Pull latest (gh-proxy mirror)' -ForegroundColor Yellow
if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
git clone --depth 1 https://gh-proxy.com/https://github.com/cyfxxx/pi-tools.git $Tmp 2>&1 | Out-Null
if (-not (Test-Path "$Tmp\agent")) { Write-Host 'CLONE FAILED - check network' -ForegroundColor Red; exit 1 }
Write-Host '  clone ok'

# ---- 3. Sync code dirs (keep local config settings/auth) ----
Write-Host '-- Sync code (keep local config)' -ForegroundColor Yellow
foreach ($d in @('extensions', 'lib', 'skills', 'agents', 'prompts')) {
  robocopy "$Tmp\agent\$d" "$Agent\$d" /E /IS /IT /NFL /NDL /NJH /NJS | Out-Null
  Write-Host "  synced agent/$d"
}
Copy-Item "$Tmp\agent\AGENTS.md" $Agent -Force
Copy-Item "$Tmp\agent\APPEND_SYSTEM.md" $Agent -Force
Write-Host '  synced AGENTS.md / APPEND_SYSTEM.md'

# ---- 4. pi-voice: KEEP (Windows native voice works since 2026-08-14)
# ffmpeg dshow recording + WSL whisper (127.0.0.1) + SAPI TTS all work.
# No longer removed - the old removal was for the pre-support era.
Write-Host '-- Keep pi-voice (Windows native voice supported)' -ForegroundColor Yellow
Write-Host '  pi-voice kept: ffmpeg dshow + SAPI + WSL whisper'

# ---- 5. Cleanup temp ----
Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue

# ---- 6. Verify ----
Write-Host ''
Write-Host '== Verify ==' -ForegroundColor Cyan
& "$Root\bin\diag.bat"

Write-Host ''
Write-Host 'Done. Run .\start.bat --continue (deps auto-installed by pi)' -ForegroundColor Green
