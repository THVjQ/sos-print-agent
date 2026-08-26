#!/usr/bin/env node
"use strict";

/**
 * Does this machine's browser render a label at the size the label actually is?
 *
 * The single assumption the whole design rests on. Every document SOS POS prints declares its own
 * paper in CSS — `@page { size: 54mm 25.4mm }` for a sticker, `A4` for a claim — and the renderer
 * is asked for `preferCSSPageSize` so Chromium honours it. Without that it scales the content
 * onto Letter, which on a label printer means a sticker shrunk into the corner of nothing. It
 * prints, it looks like it worked, and it is wrong.
 *
 * Run on every Windows build, because the browser doing the rendering is whatever Edge that till
 * happens to have, and it is not the one this was developed against.
 *
 * The page size is read with pdf-lib rather than by looking for `MediaBox` in the bytes: current
 * Chromium writes compressed object streams, so the string is not in the file at all. The regex
 * version of this check passed on Linux and failed on Windows for exactly that reason, which is
 * the sort of thing that makes you distrust a green build.
 */

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { htmlToPdf, findBrowser, closeRenderer } = require("../src/render.js");

const MM_PER_PT = 25.4 / 72;

const STICKER = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>@page { size: 54mm 25.4mm; margin: 0; } body { margin:0; font-family:Arial; font-size:9pt; background:#eee }</style>
</head><body><div>TICKET #A0001</div><div>JOHN SMITH</div><div>IPHONE 14 PRO</div>
<script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};<\/script>
</body></html>`;

const REPORT = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>@page { size: A4; margin: 0; } .page{padding:8mm;font-family:Arial}</style></head>
<body><div class="page"><h1>Damage Report</h1><p>Body copy.</p></div>
<script>window.onload=function(){window.print();};<\/script></body></html>`;

/** Receipt rolls are the odd one: a fixed width and a height that grows with the content. */
const RECEIPT = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>@page { size: 80mm auto; margin: 5mm; } body{font-family:'Courier New';font-size:10pt}</style></head>
<body><div>SOS PHONE REPAIRS</div><div>TAX INVOICE</div><div>Total $250.00</div>
<script>window.onload=function(){window.print();};<\/script></body></html>`;

async function sizeOf(pdf) {
  const doc = await PDFDocument.load(pdf);
  const { width, height } = doc.getPage(0).getSize();
  return { widthMm: width * MM_PER_PT, heightMm: height * MM_PER_PT, pages: doc.getPageCount() };
}

/** Half a millimetre. Rounding is fine; landing on Letter instead of a label is not. */
function expect(name, actual, wanted, tolerance = 0.5) {
  const ok = Math.abs(actual - wanted) <= tolerance;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${actual.toFixed(2)}mm (wanted ${wanted}mm)`);
  if (!ok) throw new Error(`${name} was ${actual.toFixed(2)}mm, expected ${wanted}mm`);
}

(async () => {
  const browser = findBrowser();
  console.log("renderer:", browser || "NONE FOUND");
  if (!browser) throw new Error("no Edge or Chrome on this machine — the agent cannot render");

  const outDir = path.join(process.cwd(), "render-check-output");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\nsticker — 54mm x 25.4mm");
  const t0 = Date.now();
  const sticker = await htmlToPdf(STICKER);
  const cold = Date.now() - t0;
  fs.writeFileSync(path.join(outDir, "sticker.pdf"), sticker);
  const s = await sizeOf(sticker);
  expect("width", s.widthMm, 54);
  expect("height", s.heightMm, 25.4);
  if (s.pages !== 1) throw new Error(`sticker came out on ${s.pages} pages`);
  console.log(`  ${sticker.length} bytes, ${cold}ms cold start`);

  console.log("\nreport — A4");
  const t1 = Date.now();
  const report = await htmlToPdf(REPORT);
  fs.writeFileSync(path.join(outDir, "report.pdf"), report);
  const r = await sizeOf(report);
  expect("width", r.widthMm, 210, 1);
  expect("height", r.heightMm, 297, 1);
  console.log(`  ${report.length} bytes, ${Date.now() - t1}ms warm`);

  console.log("\nreceipt — 80mm roll, height grows with content");
  const receipt = await htmlToPdf(RECEIPT);
  fs.writeFileSync(path.join(outDir, "receipt.pdf"), receipt);
  const c = await sizeOf(receipt);
  expect("width", c.widthMm, 80, 1);
  if (c.heightMm <= 0) throw new Error("receipt has no height");
  console.log(`  height ${c.heightMm.toFixed(1)}mm, ${receipt.length} bytes`);

  // The documents carry their own window.print() and onafterprint -> window.close(). In headless
  // that is not a no-op: the page closes itself out from under the render and the only symptom is
  // "Printing failed". A second render through the same warm browser is what catches it.
  // A roll's height has to actually track its content. If the measurement silently reported the
  // viewport instead — which it did, at first — every receipt would come out the same length
  // regardless of what was on it, wasting a third of a metre of paper on a two-line refund.
  console.log("\nreceipt — a long one must be longer");
  const longHtml = RECEIPT.replace(
    "<div>Total $250.00</div>",
    Array.from({ length: 40 }, (_, i) => `<div>Line item ${i + 1} .......... $12.00</div>`).join("") +
      "<div>Total $250.00</div>",
  );
  const longReceipt = await htmlToPdf(longHtml);
  fs.writeFileSync(path.join(outDir, "receipt-long.pdf"), longReceipt);
  const l = await sizeOf(longReceipt);
  expect("width", l.widthMm, 80, 1);
  console.log(`  height ${l.heightMm.toFixed(1)}mm against ${c.heightMm.toFixed(1)}mm for the short one`);
  if (l.heightMm < c.heightMm * 2) {
    throw new Error(`a 40-line receipt came out ${l.heightMm.toFixed(1)}mm against ${c.heightMm.toFixed(1)}mm — the height is not following the content`);
  }

  console.log("\nthe same browser, a second time");
  const t2 = Date.now();
  const again = await htmlToPdf(STICKER);
  const s2 = await sizeOf(again);
  expect("width", s2.widthMm, 54);
  console.log(`  ${Date.now() - t2}ms warm — the page's own print/close calls did not kill it`);

  await closeRenderer();
  console.log("\nRENDER OK");
})().catch(async (err) => {
  console.error("\nRENDER CHECK FAILED:", err.message);
  await closeRenderer().catch(() => {});
  process.exit(1);
});
