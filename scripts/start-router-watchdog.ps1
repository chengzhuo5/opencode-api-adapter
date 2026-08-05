# start-router-watchdog.ps1 — 路由(15722) + lean-ctx proxy(4444) 保活看门狗
# 用法（任务计划程序/启动文件夹）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Code\AI\opencode-api-adapter\scripts\start-router-watchdog.ps1"
$ErrorActionPreference = 'Continue'
$routerDir = 'C:\Code\AI\opencode-api-adapter'
$logDir = Join-Path $routerDir 'logs'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$leanCtxExe = 'C:\ProgramData\npm\npm\node_modules\lean-ctx-bin\bin\lean-ctx.exe'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-UserEnv([string]$name) {
  try { return (Get-ItemProperty 'HKCU:\Environment' -ErrorAction Stop).$name } catch { return $null }
}

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Write-Log([string]$message) {
  Add-Content -LiteralPath (Join-Path $logDir 'watchdog.log') -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
}

function Start-Router {
  $env:ERGOUAPI_API_KEY = Get-UserEnv 'ERGOUAPI_API_KEY'
  $env:OPENCODE_GO_API_KEY = Get-UserEnv 'OPENCODE_GO_API_KEY'
  $env:DEEPSEEK_API_KEY = Get-UserEnv 'DEEPSEEK_API_KEY'
  if (-not $env:OPENCODE_GO_API_KEY) { Write-Log 'WARN OPENCODE_GO_API_KEY not set in HKCU\Environment' }
  Start-Process -FilePath $nodeExe -ArgumentList 'src/main.js' -WorkingDirectory $routerDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'router.out.log') -RedirectStandardError (Join-Path $logDir 'router.err.log')
  Write-Log 'router start requested'
}

function Start-LeanCtx {
  Start-Process -FilePath $leanCtxExe -ArgumentList 'proxy','start','--port=4444' -WindowStyle Hidden
  Write-Log 'lean-ctx daemon start requested'
}

# 初始拉起（若已运行则跳过）
if (-not (Test-Port 15722)) { Start-Router }
if (-not (Test-Port 4444)) { Start-LeanCtx }
Write-Log 'watchdog started'

# 保活循环：每 10 秒检查一次，缺失则拉起
while ($true) {
  Start-Sleep -Seconds 10
  if (-not (Test-Port 15722)) { Start-Router }
  if (-not (Test-Port 4444)) { Start-LeanCtx }
}
