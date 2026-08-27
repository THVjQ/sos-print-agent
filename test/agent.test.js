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
