# sos-print-agent

The bit of SOS POS that lives on the till and makes paper come out of the right printer.

```
browser (app.sospos.com.au)  ──HTML──▶  agent (127.0.0.1:9110)  ──PDF──▶  printer
```

One binary, installed once per PC, identical in all 26 shops. It knows nothing about stickers,
dockets, receipts, refurb stickers or reports, and nothing about which store it is in — it takes
a finished HTML document and a printer name and does as it is told. Everything else is
configured in SOS POS under **Settings → Printer Settings**, per store, where the shop can change
it without anyone touching a counter.

## Why it has to be on the till

SOS POS is served over HTTPS, and a browser will not let an HTTPS page open a plain-HTTP
connection to a machine on the LAN. The single exception is loopback: `http://127.0.0.1` counts
as a trustworthy origin. That exception is the entire reason this runs on every till instead of
on one shared box in the back room.

The *printers* have no such restriction — networked, wifi and USB printers all work. Only this
receiver has to be local.

### Private Network Access

Chromium treats a call from a public HTTPS page to loopback as a private-network request and
sends a CORS preflight carrying `Access-Control-Request-Private-Network: true`. The agent answers
every response, preflight included, with:

```
Access-Control-Allow-Private-Network: true
```

Without it the real request is never sent, and what the app sees is an ordinary network failure —
indistinguishable from "no agent installed". It is the most expensive header in this repo to
forget, and there is a test for it.

## Install

In SOS POS: **Settings → Printer Settings → Download installer**. Run the downloaded
`SOS Print Agent Setup.exe`, accept the one UAC prompt, done — it starts straight away and the
chip on the settings page turns green on its own.

Nothing is configured during the install. Which printer prints what is set once per store in SOS
POS, and every till in that store follows it.

Uninstall from Add/Remove Programs like any other application.

### Deploying without clicking

`sos-print-agent.zip` on the same release carries the raw binaries and `install.ps1`, for MDM,
GPO, or a technician doing a row of counters:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Both routes install the same thing; use whichever suits the shop.

### It runs in the logged-in session, not as a service

It was a Windows service, and that failed on real hardware for two separate reasons — both
caused by the service model, and both invisible until the packaged binary ran on a real machine:

1. **Chromium will not launch under LocalSystem in session 0.** The failure is
   `Failed to launch the browser process!` with no reason attached, so nothing prints and the log
   says nothing useful.
2. **Printers a person adds are per-user connections.** A LocalSystem service cannot see them, so
   the printer a shop just installed would be missing from the dropdown while being plainly
   visible in every other app on the same PC.

Running in the user's session fixes both, and the agent is only wanted while somebody is using
SOS POS in a browser on that machine — which is to say, while somebody is logged in. An HKLM
`Run` entry starts it for whoever signs in, so one install covers every account on a shared
counter. A second copy started by a second session exits quietly; loopback is per machine, so
whichever got there first serves both.

### The installer is unsigned

Windows SmartScreen will say *"Windows protected your PC"* and hide the Run button behind **More
info**. That is the moment a non-technical person stops, so it is worth buying a code-signing
certificate before this reaches 26 shops rather than teaching every store to click past a
security warning.

## What it renders with

The Edge that is already on every Windows machine, driven headless over CDP, and **SumatraPDF**
(shipped beside the agent, GPLv3, licence included) to put the finished PDF on the spooler.

SumatraPDF has to be a real file on disk. Bundled inside the agent's own binary — which is what
`pdf-to-printer` effectively does once `pkg` swallows it — it cannot be executed at all, and
fails with `spawn C:\snapshot\...\SumatraPDF.exe ENOENT` only once you run the built exe rather
than `npm start`. Nothing to download,
no Chromium in the installer, and it updates with the OS. Chrome is used instead if Edge is
absent; `SOS_PRINT_BROWSER` overrides the search.

The documents already declare their own paper in CSS — `@page { size: 54mm 25.4mm }` for a label,
`A4` for a claim — so the renderer is asked for `preferCSSPageSize`, and what comes out is the
size the store configured. Rendering the app's own HTML rather than re-deriving a PDF elsewhere
is what guarantees the label that prints is the label the preview showed: there is only ever one
layout engine involved.

The browser is launched once and kept warm. First print of the day costs about a second; every
one after it is around 100ms.

## API

All on `http://127.0.0.1:9110`.

| | |
|---|---|
| `GET /health` | `{ ok, version, renderer, spooler, host }`. `renderer: false` means no Edge or Chrome; `spooler: false` means SumatraPDF is missing. |
| `GET /printers` | `{ agentVersion, printers: [{ name, isDefault }] }` — this PC's installed printers. |
| `POST /print` | `{ printerName, html, jobName?, copies? }` → `{ ok, jobId }`. |

`POST /print` errors come back as `{ ok: false, error, detail }` with `error` one of
`printer_required`, `nothing_to_print`, `printer_not_found`, `enumerate_failed`, `no_renderer`,
`bad_pdf`, `spool_failed`, `no_spooler`, `unsupported_platform`.

`pdfBase64` is accepted in place of `html`, and nothing sends it today. It is the seam for
rendering server-side later — one controlled Chromium for the whole fleet instead of whatever
Edge each till happens to have. Leaving the door open costs four lines; adding it afterwards
would mean an installer run on every counter.

Jobs run one at a time. A shop printing a run of refurb labels would otherwise have several
Chromium tabs and several spooler calls in flight on a machine that is also running the till, and
what came out would stop matching the order it was asked for.

## Configuration

None is needed. These exist for staging and for support:

| Variable | Default |
|---|---|
| `SOS_PRINT_PORT` | `9110` |
| `SOS_PRINT_ALLOWED_ORIGINS` | `https://app.sospos.com.au`, `https://staging.sospos.com.au`, `http://localhost:3000`, `http://127.0.0.1:3000` |
| `SOS_PRINT_BROWSER` | first Edge, then Chrome, in the usual install locations |
| `SOS_PRINT_LOG_DIR` | `%PROGRAMDATA%\SOSPrintAgent` |
| `SOS_PRINT_MAX_BODY` | `12mb` |

`SOS_PRINT_SUMATRA` overrides where the PDF viewer is looked for.

## When a till "just doesn't print"

In order:

1. `http://127.0.0.1:9110/health` in a browser on that PC. Nothing there means it is not running
   — check Task Manager for `sos-print-agent.exe`, and sign out and back in, since it starts at
   logon.
2. `%PROGRAMDATA%\SOSPrintAgent\agent.log`. Every job is one line, with the printer name and how
   long it took. Failures name the reason.
3. `renderer: false` in `/health` means no Edge or Chrome; `spooler: false` means SumatraPDF is
   not beside the agent. Neither can be fixed from the app — reinstall.
4. `printer_not_found` in the log means the store's chosen printer is not installed on that PC
   under that name. That is not a fault — SOS POS asks the person which printer to use instead
   and remembers the answer for that till.

## Updating

Self-update is deliberately **off**. A binary that replaces itself across 26 shops is the one
part of this that can break every counter at once, so a new version is an installer run until a
pilot store has been on a fixed version long enough to trust it. `SOS_PRINT_AUTOUPDATE=on` is
reserved for that decision and does nothing yet.

## Development

```bash
npm install
npm start        # http://127.0.0.1:9110
npm test
```

Runs on Linux and macOS for working on the app against a real browser — rendering works, and
`/printers` and `/print` answer `unsupported_platform`, because the spooler is Windows-only.

**Everything except [src/printers.js](src/printers.js) is already cross-platform.** Rendering,
the HTTP surface, the queue and the logging make no assumption about the OS, and
[src/render.js](src/render.js) already knows where Edge and Chrome live on macOS. A macOS or
Linux build is that one file against CUPS — `lpstat` to enumerate, `lp -d` to spool — plus a
launchd plist in place of the Windows service. It is not written because every till in the fleet
is Windows; it is small if that changes.
