@echo off
rem Portable pi launcher (deterministic)
setlocal
set "ROOT=%~dp0"
set "USERPROFILE=%ROOT%"
set "HOME=%ROOT%"
set "NPM_CONFIG_CACHE=%ROOT%.npm"
set "PATH=%ROOT%node;%ROOT%tools\tmux;%PATH%"
set "PI_CODING_AGENT_DIR=%ROOT%.pi\agent"
set "PI_VOICE_MIC_BIN=%ROOT%tools\ffmpeg\bin\ffmpeg.exe"
set "PI_VOICE_TTS_BIN=powershell"
set "GIT_SSL_CAINFO=%ROOT%tools\ca-bundle.crt"
if not exist "%ROOT%node\node.exe" (
  echo node not found - run setup.ps1 first
  exit /b 1
)
if not exist "%ROOT%pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" (
  echo pi not found - run setup.ps1 first
  exit /b 1
)
"%ROOT%node\node.exe" "%ROOT%pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*
