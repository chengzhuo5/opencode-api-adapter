param(
  [string]$Exe = 'C:\Code\AI\opencode-api-adapter\desktop\dist\CodexRouter.exe',
  [string]$DataDir = (Join-Path $env:TEMP 'codex-router-app-test'),
  [int]$WaitSec = 15
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$out = Join-Path $DataDir 'out.log'
$err = Join-Path $DataDir 'err.log'
Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue

$env:LOCALAPPDATA = $DataDir
$env:CODEX_ROUTER_DEBUG = '1'
$p = Start-Process -FilePath $Exe -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
Write-Output "launched pid $($p.Id)"

Start-Sleep -Seconds $WaitSec
Write-Output "alive: $(-not $p.HasExited)"
Write-Output '--- stdout ---'
if (Test-Path $out) { Get-Content $out }
Write-Output '--- stderr ---'
if (Test-Path $err) { Get-Content $err }

try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:15722/healthz' -UseBasicParsing -TimeoutSec 3
  Write-Output "healthz: $($r.StatusCode)"
} catch {
  Write-Output "healthz: FAIL ($($_.Exception.Message))"
}
