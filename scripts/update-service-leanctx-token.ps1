# 把 lean-ctx session_token 注入 CodexRouter 服务环境，修复 LocalSystem 压缩 401。
# 需要管理员权限（sudo powershell ...）。

$ErrorActionPreference = 'Stop'
$serviceName = 'CodexRouter'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error '需要管理员权限：请使用 sudo 运行。'
}

$nssm = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'CodexRouter\nssm') -Recurse -Filter 'nssm.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
if (-not $nssm) { throw 'nssm.exe 未找到，请先运行 install-service.ps1' }

$userEnv = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
$envArgs = @(
  "OPENCODE_GO_API_KEY=$($userEnv.OPENCODE_GO_API_KEY)",
  "ERGOUAPI_API_KEY=$($userEnv.ERGOUAPI_API_KEY)",
  "DEEPSEEK_API_KEY=$($userEnv.DEEPSEEK_API_KEY)"
)

$tokenFile = Join-Path $env:USERPROFILE '.local\share\lean-ctx\session_token'
if (-not (Test-Path $tokenFile)) { $tokenFile = 'C:\Users\29302\.local\share\lean-ctx\session_token' }
if (Test-Path $tokenFile) {
  $leanToken = (Get-Content $tokenFile -Raw).Trim()
  if ($leanToken) { $envArgs += "LEAN_CTX_PROXY_TOKEN=$leanToken" }
} else {
  Write-Warning 'lean-ctx session_token 未找到，跳过 LEAN_CTX_PROXY_TOKEN'
}

& $nssm set $serviceName AppEnvironmentExtra $envArgs
Restart-Service $serviceName
Write-Output 'CodexRouter 环境已更新并重启（含 LEAN_CTX_PROXY_TOKEN）'