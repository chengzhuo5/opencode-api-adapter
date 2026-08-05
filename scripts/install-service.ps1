# 将路由安装为 Windows 服务（NSSM）。
#
# 用法：右键“以管理员身份运行”，或：
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Code\AI\opencode-api-adapter\scripts\install-service.ps1
#
# 说明：
# - 服务名 CodexRouter，自启，崩溃后 5 秒自动重启；
# - 以 LocalSystem 运行，API key 从 HKCU\Environment 读入服务环境（存在服务配置里，
#   仅管理员可读，与用户环境变量同级安全）；
# - 安装成功后自动禁用 opencode-router-watchdog 计划任务，避免和路由抢 15722。

$ErrorActionPreference = 'Stop'
$routerDir = 'C:\Code\AI\opencode-api-adapter'
$serviceName = 'CodexRouter'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$installLog = Join-Path $routerDir 'logs\service-install.log'

function Write-Install([string]$message) {
  Add-Content -LiteralPath $installLog -Value "$(Get-Date -Format 'HH:mm:ss') $message" -Encoding utf8
  Write-Output $message
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error '需要管理员权限：请右键“以管理员身份运行”本脚本。'
}

Write-Install '=== install start ==='

try {
  # 1. 准备 NSSM（下载到 %LOCALAPPDATA%\CodexRouter\nssm，不污染仓库）
  $nssmDir = Join-Path $env:LOCALAPPDATA 'CodexRouter\nssm'
  $nssm = Get-ChildItem -Path $nssmDir -Recurse -Filter 'nssm.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
  if (-not $nssm) {
    New-Item -ItemType Directory -Force -Path $nssmDir | Out-Null
    $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
    Write-Install 'downloading nssm 2.24 ...'
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $nssmDir -Force
    $nssm = Get-ChildItem -Path $nssmDir -Recurse -Filter 'nssm.exe' |
      Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
    if (-not $nssm) { throw 'nssm.exe 未在压缩包中找到' }
  }
  Write-Install "nssm: $nssm"

  # 2. 清理旧服务
  if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Write-Install "removing existing service $serviceName ..."
    & $nssm stop $serviceName | Out-Null
    & $nssm remove $serviceName confirm | Out-Null
  }

  # 3. 先禁用/停止 watchdog，避免它在停路由期间抢拉起新实例
  if (Get-ScheduledTask -TaskName 'opencode-router-watchdog' -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName 'opencode-router-watchdog' | Out-Null
    Write-Install 'opencode-router-watchdog 计划任务已禁用'
  }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.CommandLine -like '*start-router-watchdog.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Install '运行中的 watchdog 进程已停止'

  # 4. 停止当前占用 15722 的旧路由，并确认端口真正释放
  $conn = Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue
  if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }
  if (Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue) {
    throw '端口 15722 在停止旧路由后仍未释放，中止安装'
  }

  # 5. 从 HKCU\Environment 收集 API key，注入服务环境
  $userEnv = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
  $envArgs = @()
  foreach ($name in 'OPENCODE_GO_API_KEY', 'ERGOUAPI_API_KEY', 'DEEPSEEK_API_KEY') {
    $value = $userEnv.$name
    if ($value) { $envArgs += "$name=$value" } else { Write-Warning "$name 未在 HKCU\Environment 中找到" }
  }

  # 6. 安装并配置服务
  & $nssm install $serviceName $nodeExe 'src/main.js'
  & $nssm set $serviceName AppDirectory $routerDir
  if ($envArgs.Count -gt 0) { & $nssm set $serviceName AppEnvironmentExtra $envArgs }
  & $nssm set $serviceName AppStdout (Join-Path $routerDir 'logs\router.out.log')
  & $nssm set $serviceName AppStderr (Join-Path $routerDir 'logs\router.err.log')
  & $nssm set $serviceName AppRotateFiles 1
  & $nssm set $serviceName AppRotateOnline 1
  & $nssm set $serviceName AppRotateBytes 10485760
  & $nssm set $serviceName AppExit Default Restart
  & $nssm set $serviceName AppRestartDelay 5000
  & $nssm set $serviceName AppStopMethodConsole 15000
  & $nssm set $serviceName Start SERVICE_AUTO_START

  # 7. 启动并验证：必须是服务自己的 node 进程占用 15722
  & $nssm start $serviceName
  $deadline = (Get-Date).AddSeconds(30)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:15722/healthz' -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
  if (-not $ok) { throw '服务已安装但 healthz 未通过，请查看 logs\router.err.log' }
  $svc = Get-CimInstance Win32_Service -Filter "Name='CodexRouter'"
  $appPid = (Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $svc.ProcessId -and $_.Name -eq 'node.exe' } | Select-Object -First 1).ProcessId
  $ownerPid = (Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($appPid -and $ownerPid -and $appPid -ne $ownerPid) {
    throw "端口 15722 被非服务进程占用 (owner=$ownerPid, service app=$appPid)，请检查是否有残留路由"
  }
  Write-Install "service $serviceName installed and healthy. 管理页面: http://127.0.0.1:15722/admin"
  Write-Install '常用命令: sc.exe stop CodexRouter / sc.exe start CodexRouter / sc.exe delete CodexRouter'
} catch {
  Write-Install "ERROR: $($_.Exception.Message)"
  Write-Install "STACK: $($_.ScriptStackTrace)"
  throw
}
