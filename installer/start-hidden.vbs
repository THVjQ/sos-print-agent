' Start the agent with no window at all.
'
' The agent is a console program, so launching it directly opens a console window that sits on
' the taskbar for the rest of the day — and closing it, which is the obvious thing to do with a
' stray black window on a shop counter, kills printing until the next sign-out. A till reported
' exactly that: "it needs to be open".
'
' WScript.Shell.Run with intWindowStyle 0 starts it hidden and detached. Nothing else here does
' that without either a visible flash or a second process hanging around: `start /min` still shows
' a window, and PowerShell's -WindowStyle Hidden flashes a console of its own on the way past.
'
' Deliberately NOT a GUI-subsystem build of the exe. Running it by hand from a command prompt and
' watching the log stream is how a till gets diagnosed, and that stops working the moment the
' binary has no console. This keeps both: hidden when Windows starts it, visible when a person
' does.
Dim shell, exe
Set shell = CreateObject("WScript.Shell")
exe = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")) & "sos-print-agent.exe"
' 0 = hidden, False = do not wait — wscript exits immediately and the agent keeps running.
shell.Run """" & exe & """", 0, False
