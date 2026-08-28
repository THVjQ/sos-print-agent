"use strict";

/**
 * Collecting work from SOS POS, for the devices that cannot print themselves.
 *
 * The agent's original job is to sit on loopback and take documents from the browser on its own
 * machine. That works because an HTTPS page is allowed to talk to `127.0.0.1` and nothing else on
 * the network — which is also why it needed installing on every till, and why a shop had to set up
 * Windows printer sharing so each machine could reach the others' printers. A Mac or an iPad could
 * not print at all: no agent exists for them, and their browser will not call this one.
 *
 * So this is the other direction. The agent tells the server which printers are on this machine,
 * and asks for jobs addressed to it. A device with no printer leaves the document with the server;
 * this collects it and prints it. Nothing is installed on the asking device and no printer sharing
 * is involved — this only ever prints to printers plugged in here.
 *
 * IT IS ENTIRELY OPTIONAL. With no relay configured none of this runs, the loopback path is
 * untouched, and the agent behaves exactly as it did before.
 */

const { htmlToPdf } = require("./render");
const { listPrinters, spool } = require("./printers");
const log = require("./log");
const {
  RELAY, RELAY_CONFIG_FILE, POLL_MS, HEARTBEAT_MS, MACHINE_NAME, VERSION,
} = require("./config");

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * The relay settings this agent is running with, right now.
 *
 * A copy rather than the frozen value from config, because the settings page sets this up over
 * loopback while the agent is running — see `applyRelayConfig`. Reading the module constant would
 * mean a shop had to restart the agent, or sign out and back in, to finish a setup that has
 * already succeeded. That is exactly the manual step this is meant to remove.
 */
let current = { ...RELAY };

function configured() {
  return Boolean(current && current.serverUrl && current.storeId && current.token);
}

/** What the settings page shows about this machine. Never the token — it is write-only from here. */
function relayStatus() {
  return {
    configured: configured(),
    running,
    serverUrl: current.serverUrl || null,
    storeId: current.storeId || null,
    machineName: MACHINE_NAME,
    stationId,
  };
}

/**
 * Point this agent at a server, and start collecting straight away.
 *
 * Called by the SOS POS settings page over loopback. The alternative was a person saving a JSON
 * file into ProgramData by hand and restarting the agent, which is three chances to get it wrong
 * and no feedback on any of them — a shop did exactly that and ended up with an empty Printing PCs
 * list and no way to tell which step had failed.
 *
 * Written to disk as well as applied in memory, or the setup would not survive the next restart.
 */
function applyRelayConfig(next) {
  const serverUrl = String(next?.serverUrl || "").trim().replace(/\/+$/, "");
  const storeId = String(next?.storeId || "").trim();
  const token = String(next?.token || "").trim();

  if (!serverUrl || !storeId || !token) {
    throw Object.assign(new Error("serverUrl, storeId and token are all required"), { code: "bad_config" });
  }
  // A typo here would otherwise surface as a heartbeat failing every twenty seconds for ever.
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw Object.assign(new Error(`"${serverUrl}" is not a web address`), { code: "bad_config" });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error("the server address has to be http or https"), { code: "bad_config" });
  }

  stopRelay();
  // The station id belongs to the old server. Keeping it would make the first claim ask another
  // shop's server about a station it has never heard of.
  stationId = null;
  current = { serverUrl, storeId, token };

  try {
    fs.mkdirSync(path.dirname(RELAY_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(RELAY_CONFIG_FILE, JSON.stringify({ serverUrl, storeId, token }, null, 2));
  } catch (err) {
    // Applied but not saved: it will print until the agent restarts, and the log says why it
    // stopped afterwards. Better than refusing a setup that otherwise works.
    log.error("could not save the relay configuration — it will be lost on restart", {
      file: RELAY_CONFIG_FILE,
      message: String(err && err.message),
    });
  }

  log.info("relay configured from the settings page", { server: serverUrl, storeId, machineName: MACHINE_NAME });
  startRelay();
  return relayStatus();
}

/** Every request carries the store token and the store it is for. */
function headers() {
  return {
    "Content-Type": "application/json",
    "X-Print-Token": current.token,
    "X-Print-Store": current.storeId,
  };
}

function url(pathname, params = {}) {
  const u = new URL(pathname, current.serverUrl);
  u.searchParams.set("store_id", current.storeId);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  return u.toString();
}

/**
 * A timeout on everything.
 *
 * A poll that hangs would stop this station taking any work at all, silently, until the agent is
 * restarted — and the counter would be told nobody picked the job up. Better to give up and ask
 * again in two seconds.
 */
async function call(target, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** This machine's id on the server, learned from the first heartbeat. */
let stationId = null;

/**
 * Say what is plugged in here.
 *
 * Registration and heartbeat are the same call on purpose: an agent nobody has heard of creates
 * its station, one that is known updates its printers and its clock. There is nothing to set up
 * in the right order — paste the config, and the machine appears in the shop's printer list.
 */
async function heartbeat() {
  const printers = await listPrinters().catch((err) => {
    log.warn("could not list printers for the heartbeat", { message: String(err && err.message) });
    return [];
  });

  const res = await call(url("/api/print-stations"), {
    method: "POST",
    body: { machine_name: MACHINE_NAME, agent_version: VERSION, printers },
  });

  if (!res.ok) {
    // 401 is the one worth naming: it is a token that has been rotated, and no amount of retrying
    // fixes it. Everything else is worth retrying quietly.
    if (res.status === 401) {
      log.error("SOS POS did not recognise this agent — the store's print token has changed", {
        server: current.serverUrl,
        storeId: current.storeId,
        fix: "copy the token again from Printer Settings into relay.json",
      });
    }
    throw new Error(`heartbeat failed (HTTP ${res.status})`);
  }

  const payload = await res.json();
  if (payload.station_id && payload.station_id !== stationId) {
    stationId = payload.station_id;
    log.info("registered with SOS POS", {
      stationId,
      machineName: payload.machine_name,
      printers: printers.length,
    });
  }
  return stationId;
}

/**
 * Take one job and print it.
 *
 * Everything after the claim reports back, whatever happens. A job claimed and never reported on
 * is the worst outcome available: the document is gone from the queue, nothing came out of a
 * printer, and the counter is told it is still waiting. The server re-offers an abandoned claim
 * after ninety seconds for exactly this reason, but the agent should not be the reason it has to.
 */
async function runOneJob() {
  const res = await call(url("/api/print-jobs/claim", { station_id: stationId }), { method: "POST" });
  if (res.status === 204) return false;
  if (!res.ok) throw new Error(`claim failed (HTTP ${res.status})`);

  const job = await res.json();
  const started = Date.now();

  try {
    const pdf = await htmlToPdf(job.html);
    const file = path.join(os.tmpdir(), `sos-relay-${job.id}.pdf`);
    fs.writeFileSync(file, pdf);
    try {
      await spool(file, job.printer_name, job.copies);
    } finally {
      fs.unlink(file, () => {});
    }

    log.info("printed a job from another device", {
      jobId: job.id,
      printerName: job.printer_name,
      jobName: job.job_name || "",
      ms: Date.now() - started,
    });
    await report(job.id, { ok: true });
  } catch (err) {
    log.error("could not print a job from another device", {
      jobId: job.id,
      printerName: job.printer_name,
      message: String(err && err.message),
    });
    await report(job.id, { ok: false, error: String(err && err.message).slice(0, 400) });
  }

  return true;
}

async function report(jobId, result) {
  try {
    await call(url(`/api/print-jobs/${encodeURIComponent(jobId)}`), { method: "POST", body: result });
  } catch (err) {
    // The server re-offers a claim nobody reported on, so a lost result costs a delay rather than
    // a lost document. Worth a line, not worth a retry loop here.
    log.warn("could not report the result of a job", { jobId, message: String(err && err.message) });
  }
}

/**
 * The loop.
 *
 * Deliberately serial: claim one, print it, then ask again. Two at once would race for the same
 * printer and interleave a receipt with a label, and there is one physical printer either way — so
 * there is nothing to gain and a jam to lose.
 *
 * `drain` keeps taking jobs while there are any, so a queue that built up while the machine was
 * off does not come out at one every two seconds.
 */
let running = false;
let timers = [];

async function tick() {
  if (!stationId) return;
  try {
    let drained = 0;
    while (await runOneJob()) {
      if (++drained >= 20) break; // Come up for air; the next tick continues.
    }
  } catch (err) {
    log.warn("could not collect print jobs", { message: String(err && err.message) });
  }
}

async function beat() {
  try {
    await heartbeat();
  } catch (err) {
    log.warn("heartbeat failed", { message: String(err && err.message) });
  }
}

/** Start collecting. Does nothing at all unless a relay is configured. */
function startRelay() {
  if (running) return false;
  if (!configured()) {
    log.info("no relay configured — this agent only prints for the browser on this machine", {
      hint: "to let other devices print here, fill in relay.json",
    });
    return false;
  }

  running = true;
  log.info("relay enabled", {
    server: current.serverUrl,
    storeId: current.storeId,
    machineName: MACHINE_NAME,
    pollMs: POLL_MS,
  });

  // Register before the first poll: without a station id there is nothing to claim against.
  beat();
  timers.push(setInterval(beat, HEARTBEAT_MS));
  timers.push(setInterval(tick, POLL_MS));
  return true;
}

function stopRelay() {
  timers.forEach(clearInterval);
  timers = [];
  running = false;
}

module.exports = { startRelay, stopRelay, configured, relayStatus, applyRelayConfig, heartbeat, runOneJob, url };
