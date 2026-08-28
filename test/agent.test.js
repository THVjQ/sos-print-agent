"use strict";

/**
 * What the agent promises the browser.
 *
 * Two things are worth locking down here. The first is the Private Network Access header, whose
 * absence fails silently in a way that looks exactly like "no agent installed" — a regression
 * there would be found by a shop, not by us. The second is that the print stub really does get
 * into the document, because without it the page closes itself mid-render and the only symptom
 * is `Printing failed`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { app } = require("../src/app");
const { neutralisePrintScripts, readPageRule, autoHeightWidthMm, toMm } = require("../src/render");

/** Start on a port the OS picks, so the tests run on a machine with the service installed. */
function withServer(run) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await run(base);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test("health says it is alive, and which version", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof body.renderer, "boolean");
    // The settings page reads this to tell a shop "sign out and back in": an agent started by the
    // elevated installer answers everything else here and still cannot print, because Edge will
    // not run as administrator. A field that went missing would read as "not elevated".
    assert.equal(typeof body.elevated, "boolean");
  }));

test("every response carries the Private Network Access header", () =>
  withServer(async (base) => {
    // Without this Chromium never sends the real request, and the app cannot tell that apart
    // from the agent not being installed at all.
    for (const path of ["/health", "/printers"]) {
      const res = await fetch(`${base}${path}`, { headers: { Origin: "https://app.sospos.com.au" } });
      assert.equal(res.headers.get("access-control-allow-private-network"), "true", path);
    }
  }));

test("the preflight is answered, and only for origins we know", () =>
  withServer(async (base) => {
    const allowed = await fetch(`${base}/print`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.sospos.com.au",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.sospos.com.au");
    assert.equal(allowed.headers.get("access-control-allow-private-network"), "true");

    const stranger = await fetch(`${base}/print`, {
      method: "OPTIONS",
      headers: { Origin: "https://not-sos.example", "Access-Control-Request-Method": "POST" },
    });
    // No allow-origin means the browser discards the response, which is the point.
    assert.equal(stranger.headers.get("access-control-allow-origin"), null);
  }));

test("a print with no printer, or nothing to print, is refused before anything is rendered", () =>
  withServer(async (base) => {
    const post = (body) =>
      fetch(`${base}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await (await post({ html: "<p>x</p>" })).json()).error, "printer_required");
    assert.equal((await (await post({ printerName: "Brother QL-820NWB" })).json()).error, "nothing_to_print");
  }));

test("the document's own print and close calls are blanked before its scripts run", () => {
  const html = "<!DOCTYPE html><html><head><title>t</title></head><body>x"
    + "<script>window.onload=function(){window.print();};</script></body></html>";
  const out = neutralisePrintScripts(html);

  // Before the page's own script, or it would have closed the tab already.
  assert.ok(out.indexOf("window.print=function(){}") < out.indexOf("window.onload"));
  assert.ok(out.includes("window.close=function(){}"));
  // And the document itself is otherwise untouched — this is the document the store designed.
  assert.ok(out.includes("<title>t</title>"));
});

test("a document with no head, or no html tag at all, still gets the stub first", () => {
  const noHead = neutralisePrintScripts("<html><body>x</body></html>");
  assert.ok(noHead.indexOf("window.print=function(){}") < noHead.indexOf("<body>"));

  const bare = neutralisePrintScripts("<div>x</div>");
  assert.ok(bare.startsWith("<script>window.print"));
});

test("a roll's @page size is recognised, and a fixed one is left alone", () => {
  const auto = (css) => autoHeightWidthMm(readPageRule(`<style>@page { ${css} }</style>`));

  // `size: 80mm auto` is invalid CSS — `auto` may only appear on its own — so Chromium discards
  // the whole declaration and falls back to Letter. Every receipt and docket template writes it,
  // and through the browser's print dialog it never showed because the printer driver's own
  // paper size took over. Recognising it here is what keeps an 80mm receipt off a 216mm page.
  assert.equal(auto("size: 80mm auto; margin: 5mm;"), 80);
  assert.equal(auto("size: 58mm auto;"), 58);
  assert.ok(Math.abs(auto("size:3in auto") - 76.2) < 0.001);

  // Fixed sizes must NOT take the measuring path — they are handed to preferCSSPageSize whole.
  assert.equal(auto("size: 54mm 25.4mm; margin: 0;"), null);
  assert.equal(auto("size: A4; margin: 0;"), null);
  assert.equal(auto("size: auto;"), null);
  assert.equal(autoHeightWidthMm(readPageRule("<style>body{margin:0}</style>")), null);
});

test("lengths convert to millimetres whatever unit they arrive in", () => {
  assert.equal(toMm("80mm"), 80);
  assert.equal(toMm("8cm"), 80);
  assert.equal(toMm("1in"), 25.4);
  assert.equal(Math.round(toMm("72pt") * 100) / 100, 25.4);
  assert.equal(Math.round(toMm("96px") * 100) / 100, 25.4);
  assert.equal(toMm("not a length"), null);
});

/**
 * The reason a till cannot print, picked out of Chromium's noise.
 *
 * A real till spent hours logging `Failed to launch the browser process!` and then a blank line,
 * twice per job, because the retry turned on Chromium's logging but nothing was reading the pipe.
 * The browser is now run directly and its output captured — and this is the part that decides
 * whether what gets captured is the answer or four hundred lines of push-messaging chatter.
 */
test("interestingStderr picks the complaint out of the noise", () => {
  const { interestingStderr } = require("../src/render");

  const noise = (n, i) => `[1:2:0828/101531.1:VERBOSE1:google_apis/gcm/engine/${n}.cc:${i}] chatter`;
  const lines = [
    ...Array.from({ length: 40 }, (_, i) => noise("registration_request", i)),
    "[1:2:0828/101532.0:ERROR:process_singleton_win.cc:123] Failed to create profile lock: Access is denied. (0x5)",
    ...Array.from({ length: 10 }, (_, i) => noise("more_noise", i)),
  ].join("\n");

  const picked = interestingStderr(lines);
  assert.match(picked, /Access is denied/);
  assert.ok(!picked.includes("chatter"), "the chatter must not crowd out the error");
});

test("interestingStderr falls back to the tail when nothing complained", () => {
  const { interestingStderr } = require("../src/render");
  // A browser that died without saying anything at ERROR is itself worth seeing.
  const picked = interestingStderr("one\ntwo\nthree\nfour\nfive");
  assert.match(picked, /five/);
});

test("interestingStderr says nothing rather than an empty string", () => {
  const { interestingStderr } = require("../src/render");
  assert.equal(interestingStderr(""), null);
  assert.equal(interestingStderr(undefined), null);
});

/**
 * The pair of probes, turned into a sentence.
 *
 * A till on 1.1.2 reported `exitCode: 0` with no error and no output — the browser started, did
 * the work and exited cleanly. That ruled out the browser, the profile and the path all at once,
 * and left only the thing puppeteer does differently: ask for a debugging endpoint. These are the
 * three states that pair can be in, and each needs a different person to do a different thing.
 */
const RENDERED = { exitCode: 0, spawnError: null, stdoutBytes: 2048 };
const RAN_BUT_DID_NOTHING = { exitCode: 0, spawnError: null, stdoutBytes: 0 };
const DEAD = { exitCode: 1, spawnError: null, stdoutBytes: 0 };

test("verdictFor names the machine's policy when only debugging fails", () => {
  const { verdictFor } = require("../src/render");
  const v = verdictFor(RENDERED, DEAD);
  assert.match(v, /RemoteDebuggingAllowed/);
  assert.match(v, /edge:\/\/policy/);
});

test("verdictFor blames the browser when it will not run at all", () => {
  const { verdictFor } = require("../src/render");
  const v = verdictFor(DEAD, DEAD);
  assert.match(v, /not the agent/);
  assert.ok(!/RemoteDebuggingAllowed/.test(v), "a browser that never runs is not a policy problem");
});

test("verdictFor does not blame the browser when both probes rendered", () => {
  const { verdictFor } = require("../src/render");
  assert.match(verdictFor(RENDERED, RENDERED), /not the browser/);
});

/**
 * The one a real till got wrong.
 *
 * 1.1.3 judged on the exit code alone and told a shop "the browser runs fine both ways" about a
 * browser that was exiting immediately having rendered nothing. `--dump-dom` prints the page, so
 * no output means no render — that is a quitting browser, not a healthy one.
 */
test("verdictFor does not call a browser healthy when it rendered nothing", () => {
  const { verdictFor } = require("../src/render");
  const v = verdictFor(RAN_BUT_DID_NOTHING, RAN_BUT_DID_NOTHING);
  assert.match(v, /without rendering anything/);
  assert.ok(!/not the browser/.test(v), "it very much is the browser");
  assert.match(v, /Chrome/, "and the way out is the other browser on the machine");
});

test("verdictFor treats a timeout and a spawn error as failures, not successes", () => {
  const { verdictFor } = require("../src/render");
  assert.match(verdictFor(RENDERED, { ...DEAD, exitCode: 0, timedOut: true }), /RemoteDebuggingAllowed/);
  assert.match(verdictFor(RENDERED, { ...DEAD, exitCode: 0, spawnError: "ENOENT" }), /RemoteDebuggingAllowed/);
});

/**
 * Edge and Chrome cannot share a profile directory.
 *
 * Trying every browser installed pointed both at the same `--user-data-dir`, and a Chromium
 * profile is not portable between them — each read the other's files and refused to start:
 * "Settings version is not 7" from Edge, "Settings version is not 1" from Chrome, in the same
 * log, seconds apart.
 */
test("each browser gets its own profile directory", () => {
  const { profileKeyFor } = require("../src/render");
  assert.equal(profileKeyFor("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), "msedge");
  assert.equal(profileKeyFor("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"), "chrome");
  assert.notEqual(profileKeyFor("msedge.exe"), profileKeyFor("chrome.exe"));
});

test("the profile is wiped once per run, not once per print", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { freshProfileDir } = require("../src/render");

  const base = path.join(os.tmpdir(), `sos-agent-test-${process.pid}`);
  const dir = freshProfileDir(base, "chrome.exe");

  // A stale SingletonLock is what makes Chromium report PROFILE_IN_USE and quit with status 0
  // for ever after a crash — so the first call of a run has to clear the directory.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SingletonLock"), "stale");

  // Same run: left alone, because the browser it belongs to may be up and printing.
  assert.equal(freshProfileDir(base, "chrome.exe"), dir);
  assert.ok(fs.existsSync(path.join(dir, "SingletonLock")), "an in-run call must not wipe a live profile");

  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Nothing may pass a JavaScript function into the browser.
 *
 * `pkg` compiles this agent to V8 bytecode, and a bytecode function does not stringify back into
 * source — so puppeteer, which sends functions by calling `toString()` on them, refuses with
 * `Passed function cannot be serialized!`. It works under `npm start` and fails in the shipped
 * exe, so no test that runs the source tree can catch it by executing anything. This one reads
 * the file instead.
 *
 * It cost a shop an evening: every docket failed while stickers printed, because only the
 * auto-height path (dockets, receipts) measures the page, and the app reported the puppeteer
 * error as "check the printer is on and not jammed".
 */
test("nothing passes a function into the page", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "render.js"), "utf8");

  // `page.evaluate(` / `page.evaluateOnNewDocument(` followed by anything that starts a function.
  const offenders = [...src.matchAll(/\.evaluate(?:OnNewDocument|Handle)?\(\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/g)];

  assert.equal(
    offenders.length,
    0,
    `pass a string expression instead — ${offenders.length} call(s) hand puppeteer a function, ` +
      "which cannot survive being packaged with pkg",
  );
});

test("the calls that are there use strings", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "render.js"), "utf8");

  // The height measurement is the one that broke, so assert it specifically rather than only
  // asserting the absence of a pattern.
  assert.match(src, /page\.evaluate\(\s*"Math\.ceil\(document\.documentElement\.scrollHeight\)"\s*\)/);
});

/**
 * The relay is off unless a shop has asked for it.
 *
 * Every till in all 26 shops runs this binary. One that only ever prints for the browser on its
 * own machine must not start talking to the network because a new version shipped — and a
 * half-edited config file must not stop it printing through the path that needs no network at
 * all.
 */
test("the relay stays off without a complete configuration", () => {
  const { configured } = require("../src/relay");
  // Nothing is set in this environment, which is the state of every existing install.
  assert.equal(configured(), false);
});

test("relay URLs carry the store and never double their slashes", () => {
  // `url()` is only meaningful with a configured relay, so this exercises the shape rather than
  // the module's own state: a trailing slash is what a person actually pastes.
  const joined = new URL("/api/print-jobs/claim", "https://app.sospos.com.au/".replace(/\/+$/, ""));
  assert.equal(joined.toString(), "https://app.sospos.com.au/api/print-jobs/claim");
});

/**
 * Setting a printing PC up from the settings page, rather than by hand.
 *
 * The first version of this needed a person to save a JSON file into ProgramData and restart the
 * agent. Three steps to get wrong with no feedback on any of them — a shop followed them exactly
 * and still ended up looking at an empty Printing PCs list. The page can reach the agent on
 * loopback, so it just tells it.
 */
test("a relay configuration missing any part is refused", () => {
  const { applyRelayConfig } = require("../src/relay");
  for (const bad of [
    {},
    { serverUrl: "https://app.sospos.com.au" },
    { serverUrl: "https://app.sospos.com.au", storeId: "s1" },
    { storeId: "s1", token: "t" },
  ]) {
    assert.throws(() => applyRelayConfig(bad), /required/, `should have refused ${JSON.stringify(bad)}`);
  }
});

test("a server address that is not a web address is refused", () => {
  const { applyRelayConfig } = require("../src/relay");
  // Otherwise a typo surfaces as a heartbeat failing every twenty seconds, for ever, with the
  // settings page saying only that the station never appeared.
  assert.throws(
    () => applyRelayConfig({ serverUrl: "app.sospos.com.au", storeId: "s1", token: "t" }),
    /not a web address/,
  );
  assert.throws(
    () => applyRelayConfig({ serverUrl: "ftp://app.sospos.com.au", storeId: "s1", token: "t" }),
    /http or https/,
  );
});

test("the status never reports the token back", () => {
  const { relayStatus } = require("../src/relay");
  // It is write-only from the agent's side: the page already knows it, and anything that can read
  // /relay could otherwise read a store's print credential out of a machine.
  assert.ok(!("token" in relayStatus()));
});
