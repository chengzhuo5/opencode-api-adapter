# 卸载 CodexRouter Windows 服务并恢复 watchdog 计划任务。
# 需要管理员权限。

$ErrorActionPreference = 'Stop'
$serviceName = 'CodexRouter'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error '需要管理员权限：请右键“以管理员身份运行”本脚本。'
}

$nssm = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'CodexRouter\nssm') -Recurse -Filter 'nssm.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName

if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
  if ($nssm) {
    & $nssm stop $serviceName | Out-Null
    & $nssm remove $serviceName confirm | Out-Null
  } else {
    Stop-Service $serviceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $serviceName | Out-Null
  }
  Write-Output "service $serviceName removed"
} else {
  Write-Output 'service not installed'
}

if (Get-ScheduledTask -TaskName 'opencode-router-watchdog' -ErrorAction SilentlyContinue) {
  Enable-ScheduledTask -TaskName 'opencode-router-watchdog' | Out-Null
  Write-Output 'opencode-router-watchdog 计划任务已恢复'
}
