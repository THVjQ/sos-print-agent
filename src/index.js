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
const {
  HOST,
  PORT,
  ALLOWED_ORIGINS,
  LOG_DIR,
  BROWSER_PROFILE_DIR,
  ELEVATED,
  AUTO_UPDATE,
  VERSION,
} = require("./config");
const { findBrowser, browserCandidates, closeRenderer } = require("./render");
const log = require("./log");

const server = app.listen(PORT, HOST, () => {
  log.info(`sos-print-agent ${VERSION} listening on http://${HOST}:${PORT}`, {
    allowedOrigins: ALLOWED_ORIGINS,
    renderer: findBrowser() || "NOT FOUND",
    // All of them, because the launch now falls through to the next one and a support log that
    // names only the first cannot explain which browser actually printed.
    renderersInstalled: browserCandidates(),
    logDir: LOG_DIR,
    profileDir: BROWSER_PROFILE_DIR,
    elevated: ELEVATED,
    autoUpdate: AUTO_UPDATE,
  });
  if (!findBrowser()) {
    log.error("no Edge or Chrome on this machine — /print will fail with no_renderer");
  }
  /*
   * Said at startup, not only when a print fails.
   *
   * An elevated agent answers /health, lists printers and looks entirely healthy on the settings
   * page — and then cannot render anything, because Edge will not run as administrator. The one
   * way it happens is the installer starting the agent inside its own elevated session, which is
   * exactly when a shop first tries to print. Signing out and back in starts it properly.
   */
  if (ELEVATED) {
    log.warn(
      "running as administrator — Edge will not launch from an elevated process, so printing " +
        "will fail until this is restarted as a normal user. Sign out and back in.",
    );
  }
});

server.on("error", (err) => {
  /*
   * The port already being taken is not a fault.
   *
   * The agent starts for whoever logs in, and with fast user switching two sessions can both try.
   * Loopback is per machine rather than per session, so the second one has nothing to do — the
   * browser in either session reaches the copy that got there first. Exiting quietly keeps that
   * out of the event log and off the screen.
   */
  if (err && err.code === "EADDRINUSE") {
    log.info("another copy is already listening — nothing to do", { port: PORT });
    process.exit(0);
  }
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
