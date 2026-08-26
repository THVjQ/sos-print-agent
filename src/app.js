"use strict";

/**
 * The HTTP surface of the print agent.
 *
 * Split from the entry point so the routes can be exercised without binding port 9110 — a test
 * that has to take the real port cannot run on a machine where the service is installed, which
 * is every machine anyone would want to test on.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const { ALLOWED_ORIGINS, MAX_BODY, VERSION } = require("./config");
const log = require("./log");
const { htmlToPdf, findBrowser } = require("./render");
const { listPrinters, spool } = require("./printers");

/**
 * Something readable out of anything thrown.
 *
 * A dependency that throws an object with no `message` would otherwise be reported to the shop,
 * and written to the log, as the string "undefined" — which is how a support call starts with no
 * information in it at all.
 */
function reason(err) {
  if (!err) return "unknown error";
  return String(err.message || err.code || err) || "unknown error";
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_BODY }));

/**
 * CORS, and the part everyone forgets: Private Network Access.
 *
 * Chromium treats a request from a public HTTPS page to loopback as a private-network request
 * and sends a preflight carrying `Access-Control-Request-Private-Network: true`. If the reply
 * does not carry `Access-Control-Allow-Private-Network: true`, the real request is never sent —
 * and what the app sees is an ordinary network failure, indistinguishable from "no agent
 * installed". That failure mode is silent, looks like nothing is wrong, and costs an afternoon.
 * The header is cheap; it goes on every response.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ----------------------------------------------------------------------------- routes ----- */

/** Alive, and which version — this is what the status chip in Printer Settings reads. */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    // Absent means the one thing that cannot be fixed from the app: no Edge or Chrome to render
    // with. Reported here so the chip can say so rather than waiting for a print to fail.
    renderer: Boolean(findBrowser()),
    host: os.hostname(),
  });
});

app.get("/printers", async (req, res) => {
  try {
    const printers = await listPrinters();
    res.json({ agentVersion: VERSION, printers });
  } catch (err) {
    log.error("could not list printers", { message: reason(err) });
    res.status(500).json({ ok: false, error: "enumerate_failed", detail: reason(err) });
  }
});

/**
 * Print one document.
 *
 * Jobs run one at a time. A shop printing a run of refurb labels would otherwise have several
 * Chromium tabs and several spooler calls in flight on a machine that is also running the till,
 * and the ordering of what comes out of the printer would stop matching the order it was asked
 * for.
 */
let queue = Promise.resolve();

app.post("/print", (req, res) => {
  const { printerName, html, pdfBase64, jobName, copies } = req.body || {};

  if (!printerName || typeof printerName !== "string") {
    return res.status(400).json({ ok: false, error: "printer_required" });
  }
  if (!html && !pdfBase64) {
    return res.status(400).json({ ok: false, error: "nothing_to_print" });
  }

  queue = queue.then(async () => {
    const jobId = crypto.randomUUID();
    const started = Date.now();
    try {
      // Checked before rendering: a name that is not installed here is the app's own fallback
      // prompt waiting to happen, and there is no sense spending a render on it.
      let known;
      try {
        known = await listPrinters();
      } catch (err) {
        log.error("could not list printers", { jobId, message: reason(err) });
        return res.status(500).json({ ok: false, error: "enumerate_failed", detail: reason(err) });
      }
      if (!known.some((p) => p.name === printerName)) {
        log.warn("printer not found", { jobId, printerName, installed: known.map((p) => p.name) });
        return res.status(400).json({ ok: false, error: "printer_not_found" });
      }

      /*
       * `pdfBase64` is accepted as well as `html` and nothing in SOS POS sends it today.
       *
       * It is the seam for rendering server-side later — one controlled Chromium for all 26
       * shops instead of whatever Edge each till happens to have. Leaving the door open costs
       * four lines here; adding it later would mean an installer run on every counter.
       */
      const pdf = pdfBase64 ? Buffer.from(pdfBase64, "base64") : await htmlToPdf(String(html));
      if (!pdf || pdf.length === 0) throw Object.assign(new Error("bad_pdf"), { code: "bad_pdf" });

      const file = path.join(os.tmpdir(), `sos-print-${jobId}.pdf`);
      fs.writeFileSync(file, pdf);
      try {
        await spool(file, printerName, copies);
      } finally {
        fs.unlink(file, () => {});
      }

      log.info("printed", { jobId, printerName, jobName: jobName || "", ms: Date.now() - started });
      res.json({ ok: true, jobId });
    } catch (err) {
      const known = new Set(["no_renderer", "bad_pdf", "unsupported_platform"]);
      const code = err && known.has(err.code) ? err.code : "spool_failed";
      log.error("print failed", { jobId, printerName, code, message: reason(err) });
      res.status(500).json({ ok: false, error: code, detail: reason(err) });
    }
  }).catch((err) => {
    // The queue itself must never break; one poisoned job would otherwise stop every print
    // after it until the service is restarted.
    log.error("queue recovered", { message: reason(err) });
  });
});

module.exports = { app, reason };
