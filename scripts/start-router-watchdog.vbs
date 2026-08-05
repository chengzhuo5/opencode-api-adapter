' 以完全隐藏方式启动 watchdog（wscript 无控制台窗口）。
' 任务计划程序请使用：wscript.exe "C:\Code\AI\opencode-api-adapter\scripts\start-router-watchdog.vbs"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Code\AI\opencode-api-adapter\scripts\start-router-watchdog.ps1""", 0, False
