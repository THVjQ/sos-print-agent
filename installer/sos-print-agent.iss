; The installer a shop actually double-clicks.
;
; The zip-and-PowerShell route works and is what a developer wants; it is not what you hand to
; 26 shops. This produces one SOS-Print-Agent-Setup.exe: double-click, one UAC prompt, done —
; the service is registered and started before the window closes, and Add/Remove Programs can
; take it away again.
;
; Built by .github/workflows/release.yml on a Windows runner. `install.ps1` is still shipped in
; the same release for anyone deploying this by script or by MDM.

#define AppName        "SOS Print Agent"
#define AppPublisher   "SOS Phone Repairs"
#define AppVersion      GetEnv("AGENT_VERSION")
#define ServiceId      "SOSPrintAgent"

[Setup]
AppId={{8B5F2C41-9E3A-4D77-8C1B-3F6A2D9E4C15}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\SOS Print Agent
DisableDirPage=yes
DisableProgramGroupPage=yes
; Installing a service, and writing to Program Files, both need it. Asking once up front is
; better than failing halfway through.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=SOS-Print-Agent-Setup
SolidCompression=yes
WizardStyle=modern
; Nothing to choose, so there is nothing to get wrong. The only screens are the licence-free
; welcome and the finish.
DisableWelcomePage=no
UninstallDisplayName={#AppName}

[Messages]
WelcomeLabel2=This installs the print agent on this PC so SOS POS can print stickers, dockets, receipts and reports straight to the right printer, without the browser's print dialog.%n%nThere is nothing to configure here. Which printer prints what is set once per store in SOS POS.

[Files]
Source: "..\dist\sos-print-agent.exe";          DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\sos-print-agent-service.exe";  DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\sos-print-agent-service.xml";  DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md";                         DestDir: "{app}"; Flags: ignoreversion

[Run]
; WinSW registers and starts the service. `runhidden` because a console window flashing up is
; how a shop decides something went wrong.
Filename: "{app}\sos-print-agent-service.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Registering the print agent service..."
Filename: "{app}\sos-print-agent-service.exe"; Parameters: "start";   Flags: runhidden waituntilterminated; StatusMsg: "Starting the print agent..."

[UninstallRun]
; Stop before removing, or the exe is still locked when the uninstaller tries to delete it.
Filename: "{app}\sos-print-agent-service.exe"; Parameters: "stop";      Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\sos-print-agent-service.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[Code]
{ The install is finished but the service takes a second or two to answer. Confirming it really
  responds — rather than just reporting "installed" — is the difference between a shop that knows
  it worked and one that finds out at the counter. }
function ServiceAnswers(): Boolean;
var
  WinHttp: Variant;
  Attempt: Integer;
begin
  Result := False;
  for Attempt := 1 to 10 do
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
    if not ServiceAnswers() then
      MsgBox('The print agent was installed but is not answering yet.' #13#10#13#10
             'Open SOS POS, go to Settings then Printer Settings, and press Recheck. If it still '
             'says not detected, send us %PROGRAMDATA%\SOSPrintAgent\agent.log.',
             mbInformation, MB_OK);
  end;
end;
