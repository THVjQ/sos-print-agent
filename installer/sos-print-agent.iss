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

[InstallDelete]
; The service that 1.0.0 installed. `PrepareToInstall` stops and deregisters it; these are the
; files it leaves behind, which would otherwise sit in Program Files looking installed for ever.
Type: files; Name: "{app}\sos-print-agent-service.exe"
Type: files; Name: "{app}\sos-print-agent-service.xml"
Type: files; Name: "{app}\sos-print-agent-service.wrapper.log"
Type: files; Name: "{app}\sos-print-agent-service.out.log"
Type: files; Name: "{app}\sos-print-agent-service.err.log"
; The browser profile 1.1.0 and earlier kept under ProgramData. Left there it is worse than
; useless: created by an elevated install or by LocalSystem, it belongs to Administrators or
; SYSTEM, and the standard user the agent now runs as cannot write a file into it — Chromium dies
; without saying why. The agent keeps its profile under the user's own LOCALAPPDATA from 1.1.1 on,
; so nothing needs this copy. Removed here, while Setup still has the rights to remove it.
Type: filesandordirs; Name: "{commonappdata}\SOSPrintAgent\browser-profile"

[Registry]
; HKLM rather than HKCU: one install covers every account that uses the till, which is what a
; shop with a shared counter actually has.
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "SOS Print Agent"; ValueData: """{app}\sos-print-agent.exe"""; Flags: uninsdeletevalue

[Run]
; Started now as well as at next logon, so the shop does not have to reboot to try it — but
; started *through Explorer*, which is the whole point of this line.
;
; Setup is elevated, and a child of Setup inherits that. An elevated agent looks perfectly healthy
; — it answers /health and lists printers — and then cannot print a single thing, because **Edge
; refuses to run as administrator**: it re-launches itself de-elevated and the process puppeteer
; is holding exits 0 immediately, with no output. The log fills with `Failed to launch the browser
; process!` and nothing after it. That is what a till reported after the 1.1.0 install, on every
; print, until the next sign-out.
;
; `runasoriginaluser` is the documented answer and cannot be used: it needs an interactive session
; token to hand the process to, and where there is none it blocks for ever rather than failing — a
; silent install that never returns. Explorer already runs at medium integrity, so handing it the
; path launches the agent de-elevated and returns straight away. With no interactive session
; nothing starts, which is correct for an MDM push: the HKLM Run entry covers the next logon.
Filename: "{win}\explorer.exe"; Parameters: """{app}\sos-print-agent.exe"""; Flags: nowait

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /F /IM sos-print-agent.exe"; Flags: runhidden; RunOnceId: "StopAgent"
; And the headless Edge it was driving. Killing the agent does not take it with it — the browser
; is a child process, and SIGINT/SIGTERM, which is what the agent shuts down cleanly on, is not
; what taskkill sends. Left alive it holds the profile lock and keeps a few hundred MB.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -NonInteractive -Command ""Get-CimInstance Win32_Process | Where-Object {{ $_.Name -eq 'msedge.exe' -and ($_.CommandLine -like '*SOSPrintAgent*' -or $_.CommandLine -like '*sos-print-agent*') } | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }"""; \
  Flags: runhidden; RunOnceId: "StopRenderer"

[UninstallDelete]
; The profile, but never the logs — a shop uninstalling is usually a shop about to be asked what
; the log says. {localappdata} is the uninstalling user's, so on a shared counter another
; account's profile survives; it is a few MB of scratch space in that user's own temp-ish area,
; and hunting through every profile on the machine to delete it is not worth what it would risk.
Type: filesandordirs; Name: "{localappdata}\SOSPrintAgent"

[Code]
procedure RunHidden(const FileName, Params: String);
var
  ResultCode: Integer;
begin
  { Every one of these is "remove it if it is there". A machine that never had the old version,
    or has nothing running, gives a non-zero exit code and that is the normal case — so the
    result is deliberately ignored rather than failing an install over it. }
  Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ Everything the previous install left running, cleared before a byte is copied.

  Upgrading in place is otherwise not enough. 1.0.0 registered a Windows *service*, and a service
  left behind keeps starting a `sos-print-agent.exe` that is no longer there to be started — or
  worse, starts the new one as LocalSystem, where Chromium will not launch and no per-user printer
  is visible. And in any version, killing the agent orphans the headless Edge it was driving,
  which goes on holding the browser profile's lock. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';

  { The 1.0.0 service. `sc stop` then `sc delete`, rather than the WinSW exe's own `uninstall`,
    because that exe may already have been removed by hand. }
  RunHidden(ExpandConstant('{sys}\sc.exe'), 'stop SOSPrintAgent');
  RunHidden(ExpandConstant('{sys}\sc.exe'), 'delete SOSPrintAgent');

  { The running agent — including one still running elevated from a previous install of 1.1.0,
    which is the state this whole release exists to get a till out of. }
  RunHidden(ExpandConstant('{sys}\taskkill.exe'), '/F /IM sos-print-agent.exe');

  { Its headless Edge. Matched on the command line rather than the image name: a shop's own Edge
    windows are msedge.exe too, and closing somebody's browser mid-sale would be a far worse bug
    than the one being fixed. Only a process whose --user-data-dir is ours is touched. }
  RunHidden(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq ''msedge.exe'' -and ($_.CommandLine -like ''*SOSPrintAgent*'' -or $_.CommandLine -like ''*sos-print-agent*'') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"');

  { Program Files holds the exe open for a moment after the process goes; copying over it too
    early fails with an error that reads like a permissions problem. }
  Sleep(2000);
end;

{ The install is finished but the agent takes a second or two to answer. Confirming it really
  responds — rather than just reporting "installed" — is the difference between a shop that knows
  it worked and one that finds out at the counter. }
function AgentHealth(): String;
var
  WinHttp: Variant;
  Attempt: Integer;
begin
  Result := '';
  for Attempt := 1 to 15 do
  begin
    try
      WinHttp := CreateOleObject('WinHttp.WinHttpRequest.5.1');
      WinHttp.Open('GET', 'http://127.0.0.1:9110/health', False);
      WinHttp.Send();
      if WinHttp.Status = 200 then
      begin
        { The body, not just "it answered". `elevated` is the one fault that answers 200 and
          still cannot print, and the shop should hear about it here rather than at the counter. }
        Result := WinHttp.ResponseText;
        if Result = '' then Result := '{}';
        Exit;
      end;
    except
      { not up yet }
    end;
    Sleep(1000);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Health: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    Health := AgentHealth();

    if Health = '' then
    begin
      { Explorer had nothing to hand it to.
        On a machine being imaged, pushed to by MDM, or built by CI there is no interactive shell,
        so the de-elevated launch above starts nothing at all. Leaving the till with no agent
        running would be a worse outcome than an elevated one — an elevated agent at least
        answers, lists printers, and says `elevated` so the fault has a name. So: start it
        directly, and let the check below do the talking. }
      Exec(ExpandConstant('{app}\sos-print-agent.exe'), '', ExpandConstant('{app}'),
           SW_HIDE, ewNoWait, ResultCode);
      Health := AgentHealth();
    end;

    if Health = '' then
      MsgBox('The print agent was installed but is not answering yet.' + #13#10#13#10 +
             'Sign out and back in, then open SOS POS, go to Settings then Printer Settings, ' +
             'and press Recheck. If it still says not detected, send us ' +
             ExpandConstant('{commonappdata}\SOSPrintAgent\agent.log') + '.',
             mbInformation, MB_OK)
    else if Pos('"elevated":true', Health) > 0 then
      { Explorer was not there to launch it de-elevated, so it inherited Setup's rights. It will
        answer, list printers, and fail every print until it is restarted as a normal user. }
      MsgBox('The print agent is running, but with administrator rights, and it cannot print ' +
             'that way.' + #13#10#13#10 +
             'Sign out of Windows and back in. It starts by itself, correctly, and printing ' +
             'will work from then on — nothing to reinstall.',
             mbInformation, MB_OK);
  end;
end;
