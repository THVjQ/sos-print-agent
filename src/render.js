"use strict";

/**
 * Turning the app's HTML into a PDF, on the till.
 *
 * SOS POS has always built a complete printable document in the browser — the sticker template a
 * store edits in Printer Settings, the docket, the receipt, the claim letter — and handed it to
 * `window.print()`. That HTML is what arrives here. Rendering it rather than re-deriving a PDF
 * on the server is what guarantees the label that comes out is the label the preview showed:
 * there is only ever one layout engine involved, and it is Chromium either way.
 *
 * The renderer is the Edge that is already on every Windows machine. Nothing to download, no
 * Chromium in the installer, and it updates itself with the OS.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const puppeteer = require("puppeteer-core");
const { spawnSync } = require("child_process");
const log = require("./log");
const { BROWSER_PROFILE_DIR, ELEVATED } = require("./config");

/** Where Edge and Chrome actually live. First one present wins. */
function candidatePaths() {
  if (process.env.SOS_PRINT_BROWSER) return [process.env.SOS_PRINT_BROWSER];

  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || "";
    return [
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }

  // Linux and macOS are for developing against a real printer, not for the shops.
  return [
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
}

/**
 * Every browser on this machine, not just the first one.
 *
 * `findBrowser` returned the first path that existed and the launch never looked at the rest, so
 * one uncooperative install was the end of it — with a perfectly good Chrome sitting beside it.
 *
 * That matters more than it sounds on Windows. `Program Files (x86)\\Microsoft\\Edge` is tried
 * first and is where Edge normally lives, but a machine that has been through an upgrade can have
 * an msedge.exe there that hands off to another install and exits 0 immediately — which looks
 * exactly like the failure on this till: the process we are holding is gone before it says
 * anything, every time, whatever the profile or the transport.
 */
function browserCandidates() {
  const found = [];
  for (const candidate of candidatePaths()) {
    try {
      if (fs.existsSync(candidate)) found.push(candidate);
    } catch {
      /* keep looking */
    }
  }
  return found;
}

/** The one we would use first. Kept for the health endpoint and the startup log. */
function findBrowser() {
  return browserCandidates()[0] || null;
}

/**
 * A directory Chromium can actually keep a profile in.
 *
 * `mkdir` succeeding is not the question — under ProgramData a standard user may create folders
 * and still not be allowed to create a file inside one. So the probe writes a file, which is what
 * Chromium is about to do. Getting this wrong is silent: Chromium exits before it opens its
 * logging, and puppeteer reports a launch failure with an empty reason.
 */
function usableProfileDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * The profile used when the proper one cannot be written to.
 *
 * A fixed name rather than a fresh temp directory each time, so a till that has fallen back keeps
 * one warm browser instead of leaving a new profile behind on every print.
 */
const FALLBACK_PROFILE_DIR = path.join(os.tmpdir(), "sos-print-agent-profile");

/**
 * @param verbose turns on Chromium's own logging, to stderr, where puppeteer is already reading.
 *   Off for normal launches — it is thousands of lines an hour that nobody reads. On for the
 *   second attempt, because puppeteer's message carries whatever the browser wrote, and without
 *   it a launch that fails early says literally nothing: `Failed to launch the browser process!`
 *   and then a blank line. That blank line is what a support call has to work from otherwise.
 */
function launchArgs(profileDir, verbose) {
  return [
    // Chromium refuses to run as a system account without these, and they cost nothing here.
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    `--crash-dumps-dir=${os.tmpdir()}`,
    // A till is not browsing. Nothing here should reach the network or keep state.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    ...(verbose ? ["--enable-logging=stderr", "--v=1"] : []),
  ];
}

/**
 * The lines of Chromium's output worth putting in a log a shop will email us.
 *
 * Chromium is chatty even when healthy, so the last N lines are usually about cloud policy and
 * push messaging. What is wanted is the complaint, and it is written at ERROR or FATAL — with the
 * tail kept only for the case where it died without saying anything at that level, which is
 * itself worth seeing.
 */
function interestingStderr(stderr) {
  const lines = String(stderr || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;

  const complaints = lines.filter((l) => /:(ERROR|FATAL):|Failed to|denied|not permitted|cannot /i.test(l));
  const picked = complaints.length > 0 ? complaints.slice(-6) : lines.slice(-4);
  return picked.join(" | ").slice(0, 1200);
}

/**
 * What the pair of probes means, in a sentence.
 *
 * The log is read by whoever is standing at the till, not by whoever wrote this, so the
 * conclusion belongs in the file rather than in somebody's head.
 */
function verdictFor(plain, debugging) {
  // Exit code AND evidence of work. `--dump-dom` prints the page, so a run that exits 0 having
  // printed nothing did not render — see stdoutBytes.
  const ok = (r) => r.exitCode === 0 && !r.spawnError && !r.timedOut && (r.stdoutBytes || 0) > 0;
  const ran = (r) => r.exitCode === 0 && !r.spawnError && !r.timedOut;

  if (!ran(plain)) {
    return "the browser will not run at all on this machine, with or without debugging — this is Edge itself, not the agent";
  }

  if (!ok(plain) && !ok(debugging)) {
    return (
      "the browser exits straight away, reporting success, without rendering anything — so it is " +
      "not being driven, it is quitting. On Windows that is usually an msedge.exe that hands off " +
      "to another install and exits: try Chrome on this machine instead (the agent now tries " +
      "every browser it finds), or repair the Edge installation."
    );
  }

  if (ok(debugging)) {
    return "the browser renders fine both ways, so the launch failure is not the browser — suspect a security product closing the debugging connection, or an agent bug";
  }

  return (
    "the browser renders fine UNTIL it is asked for a debugging endpoint, then it exits. That is " +
    "almost always the Edge policy RemoteDebuggingAllowed being turned off on this machine " +
    "(check edge://policy), or a security product blocking it. The agent needs that endpoint to " +
    "drive the browser, so printing cannot work until it is allowed."
  );
}

/**
 * Ask the browser directly why it will not start.
 *
 * The retry below turns on Chromium's own logging and the comment used to claim that meant the
 * failure message would carry it. It does not, and a till proved it: BOTH attempts logged
 * `Failed to launch the browser process!` followed by a blank line, twice, for hours. Puppeteer
 * launches with `dumpio: false`, so the browser's stderr is piped nowhere — `--enable-logging`
 * writes diligently into a pipe with no reader. And turning `dumpio` on would not fix it either,
 * because that sends the output to the AGENT's stdout, and this log file is written by log.js
 * rather than captured from the stream. The shop sends us agent.log; the reason was never in it.
 *
 * So the browser is run directly, with the output captured — which is the one thing that turns
 * "it will not start" into a sentence somebody can act on. `--dump-dom about:blank` is the
 * cheapest thing that makes it do real work and exit on its own.
 *
 * IT IS RUN TWICE, and the pair is the diagnosis. A till running 1.1.2 reported `exitCode: 0`
 * with no error and no output at all — Edge started, did the work, and exited cleanly. So the
 * browser is fine, the profile is fine, and the path is fine. The only thing puppeteer does
 * differently is ask for a debugging endpoint and wait for it. So the second probe adds exactly
 * that flag and nothing else: if the plain run succeeds and the debugging one does not, the
 * browser is refusing to expose the endpoint, which is a policy on the machine and not a fault
 * in this agent.
 *
 * WITHOUT `--v=1`. Verbose logging was measured here and it buries the answer: a healthy launch
 * writes hundreds of VERBOSE1 lines about GCM registration and cloud policy, so the tail of
 * stderr is noise and the one line that matters has scrolled past. Chromium writes its real
 * complaints at ERROR/FATAL, so those are picked out and the tail is only the fallback.
 *
 * Once per agent run, not once per print: with Edge properly broken every job would otherwise
 * pay the timeout, and the answer would be the same every time.
 */
let probed = null;

function probeBrowser(executablePath, profileDir) {
  if (probed) return probed;

  try {
    const run = (extra) => {
      const res = spawnSync(
        executablePath,
        [
          ...launchArgs(profileDir, false),
          "--enable-logging=stderr",
          "--headless=new",
          ...extra,
          "--dump-dom",
          "about:blank",
        ],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      );
      return {
        // A non-zero exit, a signal, or no exit at all before the timeout — each means something
        // different, and none of them were visible before.
        exitCode: res.status,
        signal: res.signal || null,
        timedOut: res.error && res.error.code === "ETIMEDOUT" ? true : undefined,
        // ENOENT here means the path is wrong, which no amount of profile juggling would fix.
        spawnError: res.error ? String(res.error.message) : null,
        // Did it actually DO anything. This is the field the 1.1.3 probe was missing, and its
        // absence made the verdict wrong on a real till: `--dump-dom` asks the browser to print
        // the page and exit, so an exit code of 0 with no output at all is not a healthy browser
        // — it is one that started and stopped without rendering, which is precisely the failure
        // being chased. Treating exit 0 as success said "the browser is fine" about a browser
        // that was doing nothing.
        stdoutBytes: String(res.stdout || "").length,
        reason: interestingStderr(res.stderr),
      };
    };

    const plain = run([]);
    const debugging = run(["--remote-debugging-port=0"]);

    probed = {
      plain,
      debugging,
      // The sentence somebody can act on, worked out here rather than left to the reader.
      verdict: verdictFor(plain, debugging),
    };
  } catch (err) {
    probed = { spawnError: String(err && err.message) };
  }

  return probed;
}

/**
 * One browser, kept warm.
 *
 * Starting Chromium costs about a second. Doing that per label would make printing a run of
 * refurb stickers noticeably worse than the dialog it replaced, so the first print of the day
 * pays for the launch and every one after it is fast. Held as the *promise* rather than the
 * browser so two prints arriving together share one launch instead of racing to start two.
 */
let browserPromise = null;

/**
 * @param pipe drives the browser over a pair of file descriptors instead of a localhost TCP
 *   port. Puppeteer's default is `--remote-debugging-port=0`, and on a managed Windows machine
 *   that port is the fragile part: Edge policy can forbid it outright, and security software
 *   routinely blocks a process connecting to a listening port that another process just opened.
 *   The pipe asks for none of that, so it is worth trying before giving up.
 */
async function start(executablePath, profileDir, verbose, pipe) {
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    dumpio: false,
    pipe: !!pipe,
    args: launchArgs(profileDir, verbose),
  });

  let browser;
  try {
    browser = await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }

  log.info("renderer started", {
    executablePath,
    profileDir,
    transport: pipe ? "pipe" : "port",
    version: await browser.version().catch(() => "?"),
  });
  return browser;
}

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
    // Someone closed it, Windows Update replaced Edge, or it crashed. Drop it and start again.
    browserPromise = null;
  }

  const candidates = browserCandidates();
  if (candidates.length === 0) {
    const err = new Error("no_renderer");
    err.code = "no_renderer";
    throw err;
  }

  /*
   * Every browser installed, in turn.
   *
   * A till spent an evening on this: Edge started, exited 0 immediately and said nothing, over a
   * port and over a pipe and on two different profiles — and Chrome was installed on the same
   * machine the whole time, never tried, because the first path that existed was the only one
   * this ever looked at.
   */
  let lastError = null;
  for (const executablePath of candidates) {
    try {
      return await tryBrowser(executablePath);
    } catch (err) {
      lastError = err;
      if (candidates.length > 1) {
        log.warn("that browser would not start — trying the next one installed", {
          failed: executablePath,
          remaining: candidates.filter((c) => c !== executablePath),
        });
      }
    }
  }
  throw lastError;
}

/** Everything we are willing to try for ONE browser: two profiles, then a pipe. */
async function tryBrowser(executablePath) {

  let profileDir = BROWSER_PROFILE_DIR;
  if (!usableProfileDir(profileDir)) {
    log.warn("cannot write to the browser profile directory — using a temporary one", {
      wanted: profileDir,
      using: FALLBACK_PROFILE_DIR,
    });
    profileDir = FALLBACK_PROFILE_DIR;
  }

  try {
    return await start(executablePath, profileDir, false, false);
  } catch (err) {
    // Puppeteer's own message is "undefined" when the browser exits with a code, and empty when
    // it exits cleanly without ever opening its debugging port — so the path, the account and
    // whether we are elevated carry more than the message does.
    log.error("could not start the renderer", {
      executablePath,
      profileDir,
      user: os.userInfo && os.userInfo().username,
      elevated: ELEVATED,
      message: String(err && err.message),
    });

    if (ELEVATED) {
      log.error(
        "the agent is running as administrator — Edge will not run elevated, it re-launches " +
          "itself de-elevated and the process we are holding exits immediately. Sign out and " +
          "back in so the agent starts from the logon entry as a normal user.",
      );
    }

    /*
     * One more attempt, on a throwaway profile, with the browser's own logging on.
     *
     * It fixes the two failures that are about the profile and not the browser — one that cannot
     * be written to, and one still locked by a headless Edge orphaned when the agent was killed —
     * and when it fails anyway, it fails *loudly*: whatever Chromium wrote is inside this second
     * message, where the first had nothing at all.
     */
    const retryDir =
      profileDir === FALLBACK_PROFILE_DIR
        ? path.join(os.tmpdir(), `sos-print-agent-profile-${process.pid}`)
        : FALLBACK_PROFILE_DIR;

    try {
      const browser = await start(executablePath, retryDir, true, false);
      log.warn("renderer started on a second attempt — the usual profile could not be used", {
        wanted: profileDir,
        using: retryDir,
      });
      return browser;
    } catch (retryErr) {
      log.error("the renderer would not start on a fresh profile either", {
        profileDir: retryDir,
        message: String(retryErr && retryErr.message),
      });

      /*
       * Third attempt, over a pipe instead of a localhost port.
       *
       * Both failures above are the SAME failure twice — the profile was never the problem, which
       * a till proved: run directly, the browser starts, works and exits 0. What it will not do
       * is hand back a debugging endpoint on a TCP port. The pipe transport asks for no port at
       * all, so where a policy or a security product is blocking that port, this is the attempt
       * that prints.
       */
      try {
        const browser = await start(executablePath, profileDir, false, true);
        log.warn(
          "renderer started over a pipe — this machine will not allow the debugging port, so " +
            "printing works but something here is blocking localhost debugging",
          { profileDir },
        );
        return browser;
      } catch (pipeErr) {
        log.error("the renderer would not start over a pipe either", {
          message: String(pipeErr && pipeErr.message),
        });
      }

      // Nothing worked. Run the browser ourselves, twice, and write down what it actually did —
      // so the next person reading this file has a reason rather than a punctuation mark.
      log.error("asked the browser directly why it will not start", probeBrowser(executablePath, retryDir));
      // The first failure is the one that describes the till's actual state.
      throw err;
    }
  }
}

const PX_PER_MM = 96 / 25.4;

/** "80mm" / "3in" / "226.77pt" → millimetres. Null for anything that is not a plain length. */
function toMm(value) {
  const m = String(value == null ? "" : value).trim().match(/^([\d.]+)\s*(mm|cm|in|pt|px)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] || "px").toLowerCase()) {
    case "mm": return n;
    case "cm": return n * 10;
    case "in": return n * 25.4;
    case "pt": return (n * 25.4) / 72;
    default: return (n * 25.4) / 96;
  }
}

/**
 * The `@page` rule the document declares, if any.
 *
 * A regex rather than a CSS parser because every document that reaches this agent is generated by
 * SOS POS from one of five templates, and all five write a single plain `@page` block at the top
 * of their stylesheet. Anything more clever would be a parser maintained for no additional case.
 */
function readPageRule(html) {
  const block = String(html).match(/@page[^{]*\{([^}]*)\}/i);
  if (!block) return null;
  const size = (block[1].match(/size\s*:\s*([^;]+)/i) || [])[1];
  return size ? { size: size.trim() } : null;
}

/**
 * Receipt and docket rolls: a fixed width and a height that grows with the content.
 *
 * `@page { size: 80mm auto }` is what those templates have always written, and it is **not valid
 * CSS** — `size` takes one or two lengths, or a page-size keyword, and `auto` may only appear on
 * its own. Chromium silently discards the whole declaration and falls back to Letter, so a
 * receipt destined for an 80mm roll comes out 216mm wide. Through the browser's print dialog this
 * never showed, because the printer driver's own paper size took over; through
 * `preferCSSPageSize` there is no driver to save it.
 *
 * Found by asserting the page size of a rendered receipt rather than trusting it. Rather than
 * rewrite five templates and hope nobody writes `auto` again, the width is honoured here and the
 * height measured from the laid-out content.
 */
function autoHeightWidthMm(rule) {
  if (!rule) return null;
  const m = rule.size.match(/^([\d.]+\s*(?:mm|cm|in|pt|px)?)\s+auto$/i);
  return m ? toMm(m[1]) : null;
}

/**
 * HTML in, PDF bytes out.
 *
 * Two details carry the whole thing:
 *
 * `preferCSSPageSize` — every one of these documents already declares its own paper in CSS
 * (`@page { size: 54mm 25.4mm }` for a label, `A4` for a claim). Without this flag Chromium
 * ignores that and scales the content onto Letter, which on a label printer means a sticker
 * shrunk into the corner of nothing. The margins are zeroed here for the same reason: the
 * document's own `@page` margin is the one the store configured.
 *
 * The `window.print` stub — the documents end with `window.onload = () => window.print()`, which
 * is how they printed before, and several follow it with `onafterprint = () => window.close()`.
 * In headless that is not the no-op you would hope for: the print really runs, `onafterprint`
 * really fires, and the page closes itself out from under the render. What you get back is
 * `Protocol error (Page.printToPDF): Printing failed`, which says nothing about the cause.
 *
 * The stub has to be injected into the HTML itself. `evaluateOnNewDocument` looks like the right
 * tool and is not — `setContent` rewrites the current document rather than navigating, so the
 * hook never re-runs and the stub is gone by the time the page's own scripts execute. Verified,
 * not assumed. It is left in place as well, for the day this renders by navigation instead.
 */
/**
 * Put the stub at the top of the document, before anything the page brought with it.
 *
 * Into `<head>` when there is one, which is every document SOS POS produces. The other two
 * branches are for hand-written HTML arriving through the API — better to render it than to
 * refuse it over a missing tag.
 */
function neutralisePrintScripts(html) {
  const stub = "<script>window.print=function(){};window.close=function(){};</script>";

  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + stub);

  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) return html.replace(htmlTag[0], htmlTag[0] + stub);

  return stub + html;
}

async function htmlToPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const autoWidthMm = autoHeightWidthMm(readPageRule(html));
  try {
    if (autoWidthMm) {
      // The viewport width is what the content lays out against when the height is measured, so
      // it has to be the paper width and not the default 800px. The height is 1px because
      // `scrollHeight` can never report less than the viewport — measuring against a normal
      // viewport gave every receipt the same 264mm, which is the viewport, not the content.
      await page.setViewport({ width: Math.max(1, Math.round(autoWidthMm * PX_PER_MM)), height: 1 });
    }
    await page.evaluateOnNewDocument(() => {
      window.print = function () {};
      window.close = function () {};
    });

    // `load` rather than `networkidle`: these documents are self-contained — images arrive as
    // data URIs — so there is no network to go idle, and waiting for it costs half a second per
    // label for nothing.
    await page.setContent(neutralisePrintScripts(String(html)), { waitUntil: "load", timeout: 15000 });

    // The sticker templates shrink their own text to fit the label on load. Give that a frame to
    // run before measuring the page.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const common = { printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, timeout: 20000 };

    if (autoWidthMm) {
      // Lay the content out at the roll's real width, then make the page exactly as long as what
      // came out. Margins stay at zero here as they do on the fixed-size path: every one of these
      // templates already insets itself with padding on `body`, and applying the `@page` margin
      // as well would inset it twice.
      const heightPx = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
      const heightMm = Math.max(heightPx / (96 / 25.4), 10);
      return await page.pdf({
        ...common,
        width: `${autoWidthMm}mm`,
        height: `${heightMm.toFixed(2)}mm`,
        preferCSSPageSize: false,
      });
    }

    return await page.pdf({ ...common, preferCSSPageSize: true });
  } finally {
    await page.close().catch(() => {});
  }
}

/** Shut the renderer down cleanly on service stop, so no headless Edge is left behind. */
async function closeRenderer() {
  const browser = await (browserPromise || Promise.resolve(null)).catch(() => null);
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
}

module.exports = { htmlToPdf, findBrowser, browserCandidates, closeRenderer, neutralisePrintScripts, readPageRule, autoHeightWidthMm, toMm, interestingStderr, verdictFor };
