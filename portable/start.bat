@echo off
rem Portable pi launcher (deterministic)
setlocal
set "ROOT=%~dp0"
set "USERPROFILE=%ROOT%"
set "HOME=%ROOT%"
set "NPM_CONFIG_CACHE=%ROOT%.npm"
set "PATH=%ROOT%node;%ROOT%tools\tmux;%ROOT%tools\PortableGit\bin;%ROOT%tools\PortableGit\cmd;%ROOT%tools\PortableGit\usr\bin;%ROOT%tools\PortableGit\mingw64\bin;%PATH%"
set "PI_CODING_AGENT_DIR=%ROOT%.pi\agent"
set "PI_VOICE_MIC_BIN=%ROOT%tools\ffmpeg\bin\ffmpeg.exe"
set "PI_VOICE_TTS_BIN=powershell"
set "GIT_SSL_CAINFO=%ROOT%tools\ca-bundle.crt"
set "CLOAKBROWSER_BINARY_PATH=%ROOT%.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe"
set "PI_DIST=%ROOT%pi-global\node_modules\@earendil-works\pi-coding-agent\dist"

if not exist "%ROOT%node\node.exe" (
  echo node not found - run setup.ps1 first
  exit /b 1
)
rem ---- junction auto-repair: .pi\agent / .pi\memory -> 真身 (解压/压缩可能压平成真实目录，脚本自愈) ----
if exist "%ROOT%bin\repair-junctions.js" (
  "%ROOT%node\node.exe" "%ROOT%bin\repair-junctions.js"
)
if not exist "%ROOT%pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" (
  echo pi not found - run setup.ps1 first
  exit /b 1
)
rem ---- service autostart: searxng(8890)/whisper(18767) port check ----
"%ROOT%node\node.exe" "%ROOT%bin\check-services.js"

rem ---- wrapper: pi exit -> check restart request (admin_restart) ----
:loop
"%ROOT%node\node.exe" "%ROOT%pi-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*
"%ROOT%node\node.exe" "%ROOT%bin\check-restart.js"
if %ERRORLEVEL%==0 (
  echo [wrapper] restart request detected - relaunching...
  goto loop
)
exit /b %ERRORLEVEL%
