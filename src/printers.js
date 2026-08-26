"use strict";

/**
 * The two things this agent does to a printer: find it, and send a PDF to it.
 *
 * Both are Windows-only, and both deliberately avoid the `pdf-to-printer` package this used to
 * lean on. That package bundles SumatraPDF *inside the npm tree*, which `pkg` then swallows into
 * the packaged exe's virtual snapshot — and a file inside the snapshot cannot be executed. It
 * fails with `spawn C:\\snapshot\\...\\SumatraPDF.exe ENOENT`, which only shows up once you run
 * the built binary rather than `npm start`. So the viewer is shipped as a real file next to the
 * agent, and enumeration is done with PowerShell, which every Windows machine already has.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const log = require("./log");

/** Windows only, and it says so. */
function assertPrintable() {
  if (process.platform !== "win32") {
    throw Object.assign(
      new Error(`printing is Windows-only; this machine is ${process.platform}`),
      { code: "unsupported_platform" },
    );
  }
}

function run(file, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || "");
        return reject(err);
      }
      resolve(String(stdout || ""));
    });
  });
}

/**
 * The PDF viewer that does the actual printing.
 *
 * Looked for beside the agent binary first — that is where the installer puts it — then in the
 * source tree for `npm start`, then wherever an environment variable says. `process.execPath` is
 * the packaged exe when packaged and `node` when not, hence both roots.
 */
function findSumatra() {
  const candidates = [
    process.env.SOS_PRINT_SUMATRA,
    path.join(path.dirname(process.execPath), "SumatraPDF.exe"),
    path.join(__dirname, "..", "vendor", "SumatraPDF.exe"),
    path.join(process.cwd(), "SumatraPDF.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * The printers installed on this PC, with the Windows default marked.
 *
 * `Win32_Printer` rather than `Get-Printer`: the CIM class is present on every Windows edition
 * and needs no optional module, and it carries the default flag in the same query.
 *
 * Asked live every time rather than cached — the answer changes when somebody plugs a label
 * printer in, and the settings page in SOS POS is exactly where a shop goes right after doing
 * that. A stale list there is how a store concludes the new printer "doesn't work".
 */
async function listPrinters() {
  assertPrintable();

  const script =
    "Get-CimInstance Win32_Printer | ForEach-Object { [pscustomobject]@{ name = $_.Name; isDefault = [bool]$_.Default } } | ConvertTo-Json -Compress";
  const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // ConvertTo-Json emits a bare object rather than an array when there is exactly one printer.
  const parsed = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows
    .map((p) => ({ name: String(p?.name ?? ""), isDefault: Boolean(p?.isDefault) }))
    .filter((p) => p.name);
}

/** Spool a PDF to a named printer, silently. */
async function spool(pdfPath, printerName, copies) {
  assertPrintable();

  const sumatra = findSumatra();
  if (!sumatra) {
    throw Object.assign(
      new Error("SumatraPDF.exe is not next to the agent — reinstall the print agent"),
      { code: "no_spooler" },
    );
  }

  const count = Math.max(1, Math.min(20, Number(copies) || 1));
  // `noscale` matters: the document already carries the page size the store configured, and
  // letting the viewer fit-to-page as well is how a 54mm label comes out at 90%.
  const settings = count > 1 ? `${count}x,noscale` : "noscale";

  await run(sumatra, [
    "-print-to", printerName,
    "-print-settings", settings,
    "-silent",
    "-exit-when-done",
    pdfPath,
  ], { timeout: 60000 });

  log.info("spooled", { printerName, copies: count });
}

module.exports = { listPrinters, spool, findSumatra };
