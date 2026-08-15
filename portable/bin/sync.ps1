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

# 0. 前置检查：必须是 git 仓库（无 .git 时 git 命令走 stderr，stdout 为空会假成功）
git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host '错误：包根不是 git 仓库（无 .git）。便携包需先建仓库：运行 update-portable.ps1 拉取或 git clone。' -ForegroundColor Red
  exit 1
}

# 1. Show status
Write-Host '-- Changes:' -ForegroundColor Yellow
git status --short
$n = (git status --short | Measure-Object).Count
if ($n -eq 0) { Write-Host 'No changes. Nothing to sync.' -ForegroundColor Green; exit 0 }

# 2. Memory file: portable-local entries follow remote (avoid conflicts/overwrites)
# 先 stash 本地 entries（保证 pull 时工作区干净），pull 后以远程版本为准并丢弃 stash
# （不要在 pull 前删文件——未暂存删除会使 rebase 拒绝，且失败被吞掉会静默继续）
$hasLocalEntries = Test-Path "$Repo\memory\entries.json"
if ($hasLocalEntries) { git stash push -q -- memory/entries.json 2>$null | Out-Null }

# 3. Pull latest first (avoid conflicts with other devices)
# 分支动态取当前分支（便携包约定 portable-win；master 已停更）
$branch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
if (-not $branch) { $branch = 'portable-win' }
Write-Host "-- Pull latest ($branch, gh-proxy mirror):" -ForegroundColor Yellow
git pull --rebase https://gh-proxy.com/https://github.com/cyfxxx/pi-tools.git $branch 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) {
  if ($hasLocalEntries) { git stash pop -q 2>$null | Out-Null }  # 还原本地 entries
  Write-Host 'PULL FAILED - 已还原本地 entries，请检查网络/冲突' -ForegroundColor Red
  exit 1
}
if ($hasLocalEntries) { git stash drop -q 2>$null | Out-Null }  # 丢弃便携本地 entries（跟随远程）
git checkout -q "$branch" -- memory/entries.json 2>$null  # 确保磁盘上是远程版本

# 4. Commit
git add -A
git reset -q memory/entries.json  # memory follows remote, never pushed from portable
git commit -m $msg 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { Write-Host 'COMMIT FAILED（无变更可提交？）' -ForegroundColor Yellow }

# 5. Push (SSH 443, 当前分支)
Write-Host "-- Push (SSH 443, $branch):" -ForegroundColor Yellow
git push origin $branch 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { Write-Host 'PUSH FAILED - check key added to GitHub + network' -ForegroundColor Red; exit 1 }

Write-Host 'Sync complete.' -ForegroundColor Green
