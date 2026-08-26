"use strict";

/**
 * What this PC can print to.
 *
 * Asked live every time rather than cached: the answer changes when somebody plugs a label
 * printer in, and the settings page in SOS POS is precisely where a shop goes right after doing
 * that. A stale list there is how a store concludes the new printer "doesn't work".
 */

const log = require("./log");

/**
 * Windows only, and it says so.
 *
 * The toolkit shells out to SumatraPDF, which is a Windows binary, and every till in the fleet
 * is Windows. Developing the app on Linux is a real thing people do here though, and a bare
 * "cannot read property of undefined" from inside a dependency is a bad way to learn that
 * printing was never going to work on this machine.
 */
function assertPrintable() {
  if (process.platform !== "win32") {
    throw Object.assign(
      new Error(`printing is Windows-only; this machine is ${process.platform}`),
      { code: "unsupported_platform" },
    );
  }
}

let toolkit = null;
function pdfToPrinter() {
  // Required lazily so the agent still starts, answers /health and reports a useful error on a
  // machine where the toolkit cannot load — rather than dying at boot with a stack trace in a
  // log nobody has found yet.
  if (!toolkit) toolkit = require("pdf-to-printer");
  return toolkit;
}

/**
 * The installed printers, with the Windows default marked.
 *
 * The default matters: on a one-printer till it lets the "which printer is this?" prompt in the
 * app come pre-answered, which turns a question into a confirmation.
 */
async function listPrinters() {
  assertPrintable();
  const { getPrinters, getDefaultPrinter } = pdfToPrinter();

  const [printers, fallback] = await Promise.all([
    getPrinters(),
    getDefaultPrinter().catch(() => null),
  ]);

  const defaultName = fallback?.name || fallback?.deviceId || null;

  return (printers || [])
    .map((p) => ({ name: p.name || p.deviceId }))
    .filter((p) => p.name)
    .map((p) => ({ name: p.name, isDefault: p.name === defaultName }));
}

/** Spool a PDF file to a named printer, silently. */
async function spool(pdfPath, printerName, copies) {
  assertPrintable();
  const { print } = pdfToPrinter();
  await print(pdfPath, {
    printer: printerName,
    copies: Math.max(1, Math.min(20, Number(copies) || 1)),
    // The document already carries its own page size and margins from the CSS the store
    // configured; letting the spooler scale it again is how a 54mm label comes out at 90%.
    scale: "noscale",
  });
  log.info("spooled", { printerName, copies: copies || 1 });
}

module.exports = { listPrinters, spool };
