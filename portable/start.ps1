# Portable pi launcher (deterministic)
$env:USERPROFILE = $PSScriptRoot
$env:HOME = $PSScriptRoot
$env:NPM_CONFIG_CACHE = Join-Path $PSScriptRoot '.npm'
$env:PI_CODING_AGENT_DIR = Join-Path $PSScriptRoot '.pi\agent'
$env:PATH = (Join-Path $PSScriptRoot 'node') + ';' + $env:PATH
Set-Location (Join-Path $PSScriptRoot 'workspace')
$node = Join-Path $PSScriptRoot 'node\node.exe'
$cli = Join-Path $PSScriptRoot 'pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js'
if (-not (Test-Path $node)) { Write-Host 'node not found - run setup.ps1 first' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $cli)) { Write-Host 'pi not found - run setup.ps1 first' -ForegroundColor Red; exit 1 }
& $node $cli @args
