# Portable pi launcher (deterministic) - PowerShell 版，与 start.bat 行为对齐
$ErrorActionPreference = 'Stop'
$env:USERPROFILE = $PSScriptRoot
$env:HOME = $PSScriptRoot
$env:NPM_CONFIG_CACHE = Join-Path $PSScriptRoot '.npm'
$env:PI_CODING_AGENT_DIR = Join-Path $PSScriptRoot '.pi\agent'
$env:PI_VOICE_MIC_BIN = Join-Path $PSScriptRoot 'tools\ffmpeg\bin\ffmpeg.exe'
$env:PI_VOICE_TTS_BIN = 'powershell'
$env:GIT_SSL_CAINFO = Join-Path $PSScriptRoot 'tools\ca-bundle.crt'
$env:CLOAKBROWSER_BINARY_PATH = Join-Path $PSScriptRoot '.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe'
$env:PI_DIST = Join-Path $PSScriptRoot 'pi-global\node_modules\@earendil-works\pi-coding-agent\dist'

# PortableGit bin/cmd 入 PATH（git/ssh/bash 不依赖系统安装）
$pgBins = @('tools\PortableGit\bin', 'tools\PortableGit\cmd', 'tools\PortableGit\usr\bin', 'tools\PortableGit\mingw64\bin') |
  ForEach-Object { Join-Path $PSScriptRoot $_ } | Where-Object { Test-Path $_ }
$env:PATH = (@($PSScriptRoot + '\node', $PSScriptRoot + '\tools\tmux') + $pgBins + $env:PATH) -join ';'

$node = Join-Path $PSScriptRoot 'node\node.exe'
$cli = Join-Path $PSScriptRoot 'pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js'
if (-not (Test-Path $node)) { Write-Host 'node not found - run setup.ps1 first' -ForegroundColor Red; exit 1 }

# ---- junction auto-repair: .pi\agent / .pi\memory -> 真身 (解压/压缩可能压平成真实目录，脚本自愈) ----
if (Test-Path (Join-Path $PSScriptRoot 'bin\repair-junctions.js')) {
  & $node (Join-Path $PSScriptRoot 'bin\repair-junctions.js')
}
if (-not (Test-Path $cli)) { Write-Host 'pi not found - run setup.ps1 first' -ForegroundColor Red; exit 1 }

# ---- service autostart: searxng(8890)/whisper(18767) port check ----
& $node (Join-Path $PSScriptRoot 'bin\check-services.js')

# ---- wrapper: pi exit -> check restart request (admin_restart) ----
do {
  & $node $cli @args
  & $node (Join-Path $PSScriptRoot 'bin\check-restart.js')
  $restart = ($LASTEXITCODE -eq 0)
  if ($restart) { Write-Host '[wrapper] restart request detected - relaunching...' -ForegroundColor Yellow }
} while ($restart)
exit $LASTEXITCODE
