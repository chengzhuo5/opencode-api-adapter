# 一键重启路由：从注册表注入 ERGOU/OPENCODE key 后重启 15722 实例。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\restart-router.ps1
$ErrorActionPreference = 'Stop'
$routerDir = 'C:\Users\cheng\Documents\Codex\2026-08-03\new-chat-2\outputs\codex-router'
$logDir = Join-Path $routerDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$ergouKey = (Get-ItemProperty 'HKCU:\Environment').ERGOUAPI_API_KEY
$opencodeKey = (Get-ItemProperty 'HKCU:\Environment').OPENCODE_GO_API_KEY
if (-not $ergouKey) { Write-Warning 'ERGOUAPI_API_KEY is not set in HKCU\Environment - ergou requests will 401 and fall back to opencode.' }
if (-not $opencodeKey) { Write-Warning 'OPENCODE_GO_API_KEY is not set in HKCU\Environment.' }
$env:ERGOUAPI_API_KEY = $ergouKey
$env:OPENCODE_GO_API_KEY = $opencodeKey

$conn = Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Milliseconds 800
}

Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'src/main.js' -WorkingDirectory $routerDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'router.out.log') -RedirectStandardError (Join-Path $logDir 'router.err.log')
Start-Sleep -Seconds 2
$r = Invoke-WebRequest -Uri 'http://127.0.0.1:15722/healthz' -UseBasicParsing -TimeoutSec 5
Write-Output "router restarted, health $($r.StatusCode), logs: $logDir"
