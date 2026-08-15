@echo off
rem Portable pi diagnostics
setlocal
set "ROOT=%~dp0..\"
echo ==== Portable pi diagnostics ====
echo ROOT: %ROOT%
echo.
echo -- 1. Portable node --
if exist "%ROOT%node\node.exe" (
  "%ROOT%node\node.exe" -v
  "%ROOT%node\node.exe" -e "console.log('zstd:', typeof require('zlib').createZstdDecompress)"
) else (
  echo MISSING: %ROOT%node\node.exe  (run setup.ps1 first)
)
echo.
echo -- 2. System node (PATH) --
where node 2>nul
node -v 2>nul || echo no system node in PATH
echo.
echo -- 3. fd/rg in .pi bin --
if exist "%ROOT%.pi\agent\bin\fd.exe" (echo fd.exe OK) else (echo fd.exe MISSING)
if exist "%ROOT%.pi\agent\bin\rg.exe" (echo rg.exe OK) else (echo rg.exe MISSING)
echo.
echo -- 4. pi entry --
if exist "%ROOT%pi-global\pi.cmd" (echo pi.cmd OK) else (echo pi.cmd MISSING)
echo.
echo -- 5. .pi config --
if exist "%ROOT%.pi\agent\settings.json" (echo settings.json OK) else (echo settings.json MISSING)
if exist "%ROOT%.pi\agent\sessions" (echo sessions OK) else (echo sessions MISSING)
echo.
echo Done.
