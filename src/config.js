"use strict";

/**
 * Everything the agent needs to know about where it is running.
 *
 * All of it overridable by environment variable, none of it store-specific: the same binary is
 * installed on every till in every one of the 26 shops, and it learns nothing about the shop it
 * is in. Which printer prints what is the *app's* business, held per store in the database and
 * sent down with each job. This thing only takes a document and a printer name.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Loopback only, never 0.0.0.0.
 *
 * The browser's mixed-content rule is what makes this design work: an HTTPS page may not open
 * an HTTP connection to a LAN address, but `http://127.0.0.1` is exempt. Binding wider would
 * not buy anything — no other machine's browser is allowed to reach it — and would put an
 * unauthenticated print endpoint on the shop network.
 */
const HOST = "127.0.0.1";
const PORT = Number(process.env.SOS_PRINT_PORT || 9110);

/**
 * Who may talk to it.
 *
 * A page from any other origin can still *send* a request, but without these headers the browser
 * refuses to hand it the response — and, more to the point, refuses the preflight. Localhost dev
 * origins are here so the app can be worked on against a real printer.
 */
const ALLOWED_ORIGINS = (process.env.SOS_PRINT_ALLOWED_ORIGINS ||
  [
    "https://app.sospos.com.au",
    "https://staging.sospos.com.au",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].join(","))
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Where the logs go.
 *
 * ProgramData rather than the install directory: Program Files is not writable by design, and one
 * log that every account on a shared counter appends to is the point — support asks a shop for
 * one file, not one per user. This is the first place to look when a shop says "it just doesn't
 * print".
 */
const LOG_DIR =
  process.env.SOS_PRINT_LOG_DIR ||
  (process.platform === "win32"
    ? path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "SOSPrintAgent")
    : path.join(os.homedir(), ".sos-print-agent"));

/**
 * Where Chromium keeps its profile. Per user, and deliberately **not** under ProgramData.
 *
 * It was under ProgramData because the agent was once a LocalSystem service, which has no user
 * profile to put it in. That reason went away with the service and the path outlived it, which
 * cost a till a day of not printing: a folder created there by the installer's own elevated run
 * belongs to Administrators, and ProgramData's inherited permissions let a standard user create
 * *folders* inside it but not *files*. Chromium cannot write its profile, dies before it can say
 * why, and puppeteer reports `Failed to launch the browser process!` with nothing after it.
 *
 * LOCALAPPDATA is writable by whoever the agent runs as, always. A browser profile is per-user
 * state anyway — two accounts on a shared counter should not share one, and whichever got there
 * first would hold its lock.
 */
const BROWSER_PROFILE_DIR =
  process.env.SOS_PRINT_PROFILE_DIR ||
  (process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "SOSPrintAgent",
        "browser-profile",
      )
    : path.join(os.homedir(), ".sos-print-agent", "browser-profile"));

/**
 * Are we running elevated?
 *
 * It matters because **Edge will not run as Administrator**. Launched from an elevated process it
 * re-launches itself de-elevated, and the process puppeteer is holding exits 0 immediately having
 * written nothing — which is exactly the blank `Failed to launch the browser process!` a shop
 * reports as "it just doesn't print". The agent is meant to start from the HKLM `Run` entry as a
 * normal user; it only ends up elevated when the installer starts it inside its own elevated
 * session, which is the one moment a shop actually tries to print.
 *
 * Detected by listing a directory only administrators may read, rather than by shelling out to
 * `net session` or `fltmc`: this runs at startup and must not cost a process launch. It feeds a
 * warning and a `/health` field and nothing else — a wrong answer misleads a support call at
 * worst, and never decides whether to print.
 */
function detectElevated() {
  if (process.platform !== "win32") return false;
  try {
    fs.readdirSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "config"));
    return true;
  } catch {
    return false;
  }
}

const ELEVATED = detectElevated();

/** Biggest document we will accept. Stickers are ~4 KB; a report with an embedded logo is ~200 KB. */
const MAX_BODY = process.env.SOS_PRINT_MAX_BODY || "12mb";

/**
 * Self-update is deliberately off.
 *
 * A binary that replaces itself on tills across 26 shops is the one part of this that can break
 * every counter at once, so it stays behind a flag until the pilot store has run on a fixed
 * version for a while. See README — "Updating".
 */
const AUTO_UPDATE = process.env.SOS_PRINT_AUTOUPDATE === "on";

module.exports = {
  HOST,
  PORT,
  ALLOWED_ORIGINS,
  LOG_DIR,
  BROWSER_PROFILE_DIR,
  ELEVATED,
  MAX_BODY,
  AUTO_UPDATE,
  VERSION: require("../package.json").version,
};
