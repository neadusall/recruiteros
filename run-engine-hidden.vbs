' Launch the RecruitersOS engine with NO console window (runs in the background).
' Called by the "RecruitersOS-Engine" logon task; delegates to run-engine.cmd,
' which keeps the Next dev server alive and auto-restarts it on any exit.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""C:\Users\rrnea\recruiteros\run-engine.cmd""", 0, False
