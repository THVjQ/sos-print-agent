#!/usr/bin/env node
"use strict";

/**
 * The SOS POS print agent.
 *
 * One job: take a finished HTML document and a printer name from the browser on this machine,
 * and make paper come out of that printer with nothing on screen.
 *
 * It knows nothing about stickers, dockets, receipts or reports, and nothing about which store
 * it is in. All of that lives in SOS POS, per store, where it can be changed by the shop without
 * anyone touching a till. Keeping the agent this dumb is what makes one binary work for 26
 * shops with different printers and different numbers of them.
 */

const { app, reason } = require("./app");
const { HOST, PORT, ALLOWED_ORIGINS, LOG_DIR, AUTO_UPDATE, VERSION } = require("./config");
const { findBrowser, closeRenderer } = require("./render");
const log = require("./log");

const server = app.listen(PORT, HOST, () => {
  log.info(`sos-print-agent ${VERSION} listening on http://${HOST}:${PORT}`, {
    allowedOrigins: ALLOWED_ORIGINS,
    renderer: findBrowser() || "NOT FOUND",
    logDir: LOG_DIR,
    autoUpdate: AUTO_UPDATE,
  });
  if (!findBrowser()) {
    log.error("no Edge or Chrome on this machine — /print will fail with no_renderer");
  }
});

server.on("error", (err) => {
  // Almost always a second copy of the agent already running: the service, plus somebody who
  // double-clicked the exe to see what it did.
  log.error("could not listen", { port: PORT, message: reason(err) });
  process.exit(1);
});

/** Stop cleanly, so no headless Edge is left running after the service stops. */
async function shutdown(signal) {
  log.info("shutting down", { signal });
  server.close();
  await closeRenderer();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { server };
