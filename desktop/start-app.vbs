' 无黑框启动桌面壳（开发模式）：双击本文件或 wscript start-app.vbs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node app.js", 0, False
