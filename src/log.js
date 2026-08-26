"use strict";

/**
 * A log a shop can be asked to send you.
 *
 * The whole point of this agent is that printing stops being visible — no dialog, no window, no
 * "which printer?". That is also what makes it hard to support: when nothing comes out, there is
 * nothing on screen to describe. This file is the answer to "what happened at 2:14pm".
 *
 * Deliberately plain text, one line per event, and small enough to paste into an email.
 */

const fs = require("fs");
const path = require("path");
const { LOG_DIR } = require("./config");

const LOG_FILE = path.join(LOG_DIR, "agent.log");
const MAX_BYTES = 2 * 1024 * 1024;

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * One generation of history, not many.
 *
 * A till prints hundreds of labels a day and nobody reads last month's. Keeping a single `.1`
 * means the file that answers "what happened this morning" is always one of two places.
 */
function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_BYTES) return;
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* no file yet, or a file we cannot move — either way, carry on and append */
  }
}

function write(level, message, extra) {
  const line = `${new Date().toISOString()} ${level} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`;
  // Always to the console as well: run the exe by hand from a command prompt and you see the
  // same stream, which is how you diagnose a till without hunting for ProgramData.
  process.stdout.write(line);
  if (!ensureDir()) return;
  rotate();
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* a full disk should not stop the printing */
  }
}

module.exports = {
  LOG_FILE,
  info: (message, extra) => write("INFO ", message, extra),
  warn: (message, extra) => write("WARN ", message, extra),
  error: (message, extra) => write("ERROR", message, extra),
};
