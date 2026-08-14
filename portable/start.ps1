# Portable pi launcher (deterministic)
$env:USERPROFILE = $PSScriptRoot
$env:HOME = $PSScriptRoot
$env:NPM_CONFIG_CACHE = Join-Path $PSScriptRoot '.npm'
$env:PI_CODING_AGENT_DIR = Join-Path $PSScriptRoot '.pi\agent'
$env:PI_VOICE_MIC_BIN = Join-Path $PSScriptRoot 'tools\ffmpeg\bin\ffmpeg.exe'
$env:PI_VOICE_TTS_BIN = 'powershell'
$env:GIT_SSL_CAINFO = Join-Path $PSScriptRoot 'tools\ca-bundle.crt'
$node = Join-Path $PSScriptRoot 'node\node.exe'
$cli = Join-Path $PSScriptRoot 'pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js'
if (-not (Test-Path $node)) { Write-Host 'node not found - run setup.ps1 first' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $cli)) { Write-Host 'pi not found - run setup.ps1 first' -ForegroundColor Red; exit 1 }
& $node $cli @args
