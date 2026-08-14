# Portable pi git sync (Windows PowerShell)
# One-click: commit + push local changes to GitHub (SSH over 443, bypasses TLS block)
# Usage: powershell -ExecutionPolicy Bypass -File sync.ps1 ["commit message"]
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot
$Repo = $Root  # junction 迁移后仓库在包根

# SSH key + homedir redirect (ssh reads ~/.ssh = package .ssh)
$env:USERPROFILE = $Root
$env:HOME = $Root
$env:GIT_SSH_COMMAND = "ssh -i `"$Root\.ssh\id_ed25519`" -o StrictHostKeyChecking=no -o UserKnownHostsFile=`"$Root\.ssh\known_hosts`" -p 443"

$msg = if ($args.Count -gt 0) { $args[0] } else { "sync: portable pi updates (auto)" }

Write-Host '== Portable pi git sync ==' -ForegroundColor Cyan
Set-Location $Repo

# 1. Show status
Write-Host '-- Changes:' -ForegroundColor Yellow
git status --short
$n = (git status --short | Measure-Object).Count
if ($n -eq 0) { Write-Host 'No changes. Nothing to sync.' -ForegroundColor Green; exit 0 }

# 2. Memory file: portable-local entries follow remote (avoid conflicts/overwrites)
if (Test-Path "$Repo\memory\entries.json") { Remove-Item "$Repo\memory\entries.json" -Force -ErrorAction SilentlyContinue }

# 3. Pull latest first (avoid conflicts with other devices)
Write-Host '-- Pull latest (gh-proxy mirror):' -ForegroundColor Yellow
git pull --rebase https://gh-proxy.com/https://github.com/cyfxxx/pi-tools.git master 2>&1 | Out-String | Write-Host

# 4. Commit
git add -A
git reset -q memory/entries.json  # memory follows remote, never pushed from portable
git commit -m $msg | Out-String | Write-Host

# 5. Push (SSH 443)
Write-Host '-- Push (SSH 443):' -ForegroundColor Yellow
git push origin master 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { Write-Host 'PUSH FAILED - check key added to GitHub + network' -ForegroundColor Red; exit 1 }

Write-Host 'Sync complete.' -ForegroundColor Green
