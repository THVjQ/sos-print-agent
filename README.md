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

Download `sos-print-agent.zip` from [Releases](../../releases/latest), unzip it on the till, then
from an **Administrator** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

That copies the agent into Program Files, registers it as a service that starts with the machine,
starts it, and checks it answers. To remove it:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Then open SOS POS → Settings → Printer Settings. The chip at the top should read **Print agent
connected**, and each of the five tabs can pick a printer.

## What it renders with

The Edge that is already on every Windows machine, driven headless over CDP. Nothing to download,
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
| `GET /health` | `{ ok, version, renderer, host }`. `renderer: false` means no Edge or Chrome. |
| `GET /printers` | `{ agentVersion, printers: [{ name, isDefault }] }` — this PC's installed printers. |
| `POST /print` | `{ printerName, html, jobName?, copies? }` → `{ ok, jobId }`. |

`POST /print` errors come back as `{ ok: false, error, detail }` with `error` one of
`printer_required`, `nothing_to_print`, `printer_not_found`, `enumerate_failed`, `no_renderer`,
`bad_pdf`, `spool_failed`, `unsupported_platform`.

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

Set them in `sos-print-agent-service.xml` next to the exe, then re-run the installer.

## When a till "just doesn't print"

In order:

1. `http://127.0.0.1:9110/health` in a browser on that PC. Nothing there means the service is not
   running — `Get-Service SOSPrintAgent`.
2. `%PROGRAMDATA%\SOSPrintAgent\agent.log`. Every job is one line, with the printer name and how
   long it took. Failures name the reason.
3. `renderer: false` in `/health` means no Edge or Chrome. Nothing else will work until that is
   fixed.
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
