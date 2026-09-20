/**
 * Renders public/og.png — the 1200×630 card that every social scraper shows.
 *
 * Run it whenever the hero copy changes:  pnpm og
 *
 * A real browser rather than an SVG rasteriser, because the card uses the same
 * webfont, gradients and optical sizing as the page it represents. The template
 * next door is plain HTML for exactly that reason: it can be opened and eyeballed
 * on its own.
 *
 * Requires Chrome (or Chromium) installed — playwright-core drives the system
 * browser rather than downloading its own.
 */
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(root, "public/og.png");

const asset = (p) => pathToFileURL(path.join(root, p)).href;
const font = (weight) =>
  asset(`node_modules/@fontsource/geist-sans/files/geist-sans-latin-${weight}-normal.woff2`);

const html = (await fs.readFile(path.join(here, "card.html"), "utf8"))
  .replace("FONT_400", font(400))
  .replace("FONT_600", font(600))
  .replace("LOGO_SRC", asset("public/logo.png"));

const tmp = path.join(here, ".card.rendered.html");
await fs.writeFile(tmp, html);

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
} catch {
  // oxlint-disable-next-line eslint/no-console
  console.error(
    "Could not launch Chrome. Install Google Chrome, or run:\n" +
      "  pnpm dlx playwright install chromium\n" +
      "and change `channel: \"chrome\"` in this file.",
  );
  await fs.rm(tmp, { force: true });
  process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
await fs.rm(tmp, { force: true });

const { size } = await fs.stat(out);
// oxlint-disable-next-line eslint/no-console
console.log(`og.png → 1200×630, ${(size / 1024).toFixed(0)} KB`);
