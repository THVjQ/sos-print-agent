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
const log = require("./log");
const { LOG_DIR } = require("./config");

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

function findBrowser() {
  for (const candidate of candidatePaths()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
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

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
    // Someone closed it, Windows Update replaced Edge, or it crashed. Drop it and start again.
    browserPromise = null;
  }

  const executablePath = findBrowser();
  if (!executablePath) {
    const err = new Error("no_renderer");
    err.code = "no_renderer";
    throw err;
  }

  /*
   * An explicit profile directory, under ProgramData.
   *
   * The agent runs as a Windows service under LocalSystem, which has no desktop, no user profile
   * and a temp directory of its own. Letting Chromium pick its own scratch space there is how you
   * get "Failed to launch the browser process!" with no reason attached — which is exactly what a
   * till reports as "it just doesn't print".
   */
  const profileDir = path.join(LOG_DIR, "browser-profile");
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {
    /* fall back to Chromium's own choice rather than refusing to print */
  }

  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    // The service has no console to inherit, and losing the browser's stderr is what turns a
    // launch failure into "undefined". Piped, it reaches our own log instead.
    dumpio: false,
    args: [
      // Required under LocalSystem: Chromium refuses to run as a system account otherwise.
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
    ],
  });

  let browser;
  try {
    browser = await browserPromise;
  } catch (err) {
    // Keep the real reason. Puppeteer's own message is often just "undefined" when the process
    // dies before it can say anything, so the executable path and the account matter more.
    browserPromise = null;
    log.error("could not start the renderer", {
      executablePath,
      profileDir,
      user: os.userInfo && os.userInfo().username,
      message: String(err && err.message),
    });
    throw err;
  }

  log.info("renderer started", {
    executablePath,
    profileDir,
    version: await browser.version().catch(() => "?"),
  });
  return browser;
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

module.exports = { htmlToPdf, findBrowser, closeRenderer, neutralisePrintScripts, readPageRule, autoHeightWidthMm, toMm };
