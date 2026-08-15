# Portable searxng installer (Windows PowerShell)
# 一键安装 Windows 版 searxng 到 tools/searxng：下载源码 + venv + 依赖 + 打补丁 + 生成配置
# 幂等：已存在跳过。用法: powershell -ExecutionPolicy Bypass -File searxng-setup.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot
$Tools = "$Root\tools"
$Dir = "$Tools\searxng"
$UV = "$Tools\uv\uv.exe"
$PY = "$Tools\python"

Write-Host '== Portable searxng installer ==' -ForegroundColor Cyan

# ---- 1. uv（便携） ----
if (-not (Test-Path $UV)) {
  Write-Host '缺少 uv——先运行 setup.ps1（自动下载）或手动拷贝 uv.exe 到 tools\uv\' -ForegroundColor Red
  exit 1
}
$env:UV_PYTHON_INSTALL_DIR = $PY

# ---- 2. searxng 源码 ----
if (-not (Test-Path "$Dir\searx\webapp.py")) {
  Write-Host '下载 searxng 源码...' -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $zip = "$Dir\searxng-master.zip"
  curl.exe -kL -m 120 -o $zip "https://github.com/searxng/searxng/archive/refs/heads/master.zip"
  if ($LASTEXITCODE -ne 0) { Write-Host '下载失败（curl exit 非 0）——检查网络' -ForegroundColor Red; exit 1 }
  tar -xf $zip -C $Dir
  if ($LASTEXITCODE -ne 0) { Write-Host '解压失败（tar exit 非 0）——zip 可能损坏' -ForegroundColor Red; exit 1 }
  Move-Item "$Dir\searxng-master\*" $Dir -Force
  Remove-Item "$Dir\searxng-master" -Recurse -Force
  Remove-Item $zip -Force
  Write-Host '  源码就绪'
} else { Write-Host '  源码已存在' }

# ---- 3. venv + 依赖 ----
if (-not (Test-Path "$Dir\.venv\Scripts\python.exe")) {
  Write-Host '创建 venv + 安装依赖（可能 3-8 分钟）...' -ForegroundColor Yellow
  Push-Location $Dir
  & $UV venv .venv --python 3.12
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'venv 创建失败（uv exit 非 0）' -ForegroundColor Red; exit 1 }
  & $UV pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host '依赖安装失败（uv pip exit 非 0）' -ForegroundColor Red; exit 1 }
  Pop-Location
  Write-Host '  依赖就绪'
} else { Write-Host '  venv 已存在' }

# ---- 4. Windows 补丁（SelectorEventLoop——Proactor 与 httpx 不兼容） ----
$clientPy = "$Dir\searx\network\client.py"
$patch = "WindowsSelectorEventLoopPolicy"
if (-not (Select-String -Path $clientPy -Pattern $patch -Quiet)) {
  $c = Get-Content $clientPy -Raw -Encoding UTF8
  $c = $c -replace "import asyncio", "import asyncio`nimport sys"
  $c = $c -replace "`ninit\(\)", "`n# Windows: ProactorEventLoop + httpx/anyio 不兼容（引擎请求挂起超时）——强制 Selector`nif sys.platform == 'win32':`n    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())`n`ninit()"
  Set-Content -Path $clientPy -Value $c -Encoding UTF8
  Write-Host '  补丁已应用（SelectorEventLoop）'
} else { Write-Host '  补丁已存在' }

# ---- 5. 配置（settings.yml，含 secret_key） ----
if (-not (Test-Path "$Dir\settings.yml")) {
  $key = -join ((48..57) + (97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  @"
use_default_settings:
  engines:
    keep_only:
      - bing
      - 360search

engines:
  - name: bing
    disabled: false
    base_url: https://cn.bing.com
  - name: 360search
    disabled: false

server:
  bind_address: "127.0.0.1"
  port: 8890
  secret_key: "$key"
  limiter: false

search:
  safe_search: 0
  default_lang: zh-CN
  formats:
    - html
    - json

outgoing:
  useragent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
  timeout: 20.0
  enable_http2: false
"@ | Set-Content -Path "$Dir\settings.yml" -Encoding UTF8
  Write-Host '  配置已生成（端口 8890）'
} else { Write-Host '  配置已存在' }

Write-Host ''
Write-Host '完成！启动: .\tools\searxng\start.bat（http://127.0.0.1:8890）' -ForegroundColor Green
