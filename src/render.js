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
const puppeteer = require("puppeteer-core");
const log = require("./log");

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

  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // A till is not browsing. Nothing here should reach the network or keep state.
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
    ],
  });

  const browser = await browserPromise;
  log.info("renderer started", { executablePath, version: await browser.version().catch(() => "?") });
  return browser;
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
  try {
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

    return await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: 20000,
    });
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

module.exports = { htmlToPdf, findBrowser, closeRenderer, neutralisePrintScripts };
