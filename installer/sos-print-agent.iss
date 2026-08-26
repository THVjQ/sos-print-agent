; The installer a shop double-clicks.
;
; Double-click, one UAC prompt, done: the agent is copied into Program Files, registered to start
; for whoever logs in, and started straight away.
;
; **It is not a Windows service, and that is deliberate.** It was one, and it failed on real
; hardware for two separate reasons, both of which the service model causes:
;
;   1. Chromium will not launch under LocalSystem in session 0. The failure is
;      "Failed to launch the browser process!" with no reason attached, so nothing prints and
;      the log says nothing useful.
;   2. Printers added by a person are *per-user* connections. A LocalSystem service cannot see
;      them, so the printer the shop just installed would be missing from the dropdown while
;      being plainly visible in every other app on the same PC.
;
; Running in the logged-in user's session fixes both. The agent is only needed while somebody is
; using SOS POS in a browser on that machine, which is to say while somebody is logged in.

#define AppName        "SOS Print Agent"
#define AppPublisher   "SOS Phone Repairs"
#define AppVersion      GetEnv("AGENT_VERSION")

[Setup]
AppId={{8B5F2C41-9E3A-4D77-8C1B-3F6A2D9E4C15}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\SOS Print Agent
DisableDirPage=yes
DisableProgramGroupPage=yes
; Writing to Program Files and to HKLM both need it. Asking once up front beats failing halfway.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=SOS-Print-Agent-Setup
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}

[Messages]
WelcomeLabel2=This installs the print agent on this PC so SOS POS can print stickers, dockets, receipts and reports straight to the right printer, without the browser's print dialog.%n%nThere is nothing to configure here. Which printer prints what is set once per store in SOS POS.

[Files]
Source: "..\dist\sos-print-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
; The PDF viewer that does the actual spooling. It has to be a real file on disk — packaged
; inside the agent's own binary it cannot be executed at all, which is how this failed the first
; time round.
Source: "..\dist\SumatraPDF.exe";      DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\SumatraPDF-LICENSE";  DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\README.md";                DestDir: "{app}"; Flags: ignoreversion

[Registry]
; HKLM rather than HKCU: one install covers every account that uses the till, which is what a
; shop with a shared counter actually has.
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "SOS Print Agent"; ValueData: """{app}\sos-print-agent.exe"""; Flags: uninsdeletevalue

[Run]
; `runasoriginaluser` so it lands in the session of the person installing it, not in the elevated
; one. Started now as well as at next logon, so the shop does not have to reboot to try it.
Filename: "{app}\sos-print-agent.exe"; Flags: nowait runasoriginaluser

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /F /IM sos-print-agent.exe"; Flags: runhidden; RunOnceId: "StopAgent"

[Code]
{ The install is finished but the agent takes a second or two to answer. Confirming it really
  responds — rather than just reporting "installed" — is the difference between a shop that knows
  it worked and one that finds out at the counter. }
function AgentAnswers(): Boolean;
var
  WinHttp: Variant;
  Attempt: Integer;
begin
  Result := False;
  for Attempt := 1 to 15 do
  begin
    try
      WinHttp := CreateOleObject('WinHttp.WinHttpRequest.5.1');
      WinHttp.Open('GET', 'http://127.0.0.1:9110/health', False);
      WinHttp.Send();
      if WinHttp.Status = 200 then
      begin
        Result := True;
        Exit;
      end;
    except
      { not up yet }
    end;
    Sleep(1000);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not AgentAnswers() then
      MsgBox('The print agent was installed but is not answering yet.' + #13#10#13#10 +
             'Sign out and back in, then open SOS POS, go to Settings then Printer Settings, ' +
             'and press Recheck. If it still says not detected, send us ' +
             ExpandConstant('{commonappdata}\SOSPrintAgent\agent.log') + '.',
             mbInformation, MB_OK);
  end;
end;
