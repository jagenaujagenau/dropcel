/**
 * Builds every icon the page references, from one source PNG.
 *
 * Run it when the app icon changes:  pnpm icons
 *
 * Source is the app's own icon (../../assets/icon.png in the Tauri repo). The
 * 1254px original is ~1.8 MB — shipping that as a 40px header logo is what this
 * exists to prevent.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const src = path.resolve(root, "../assets/icon.png");
const pub = (p) => path.join(root, "public", p);

/** macOS ships `sips`; nothing else is needed for a handful of resizes. */
const resize = (size, out) => run("sips", ["-Z", String(size), "--out", out, src]);

const PNGS = [
  [16, "favicon-16.png"],
  [32, "favicon.png"],
  [180, "apple-touch-icon.png"],
  [192, "logo.png"],
  [192, "icon-192.png"],
  [512, "icon.png"],
];

/**
 * A real .ico, because /favicon.ico is still requested unprompted by feed
 * readers, link unfurlers and Windows — and a 404 on every one of those is noise
 * in the logs for no reason. Modern .ico may embed PNGs directly, so this is a
 * 22-byte header around the two files above rather than a BMP encoder.
 */
async function ico(sizes, out) {
  const images = await Promise.all(sizes.map(([, file]) => fs.readFile(pub(file))));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((png, i) => {
    const [size] = sizes[i];
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });

  await fs.writeFile(out, Buffer.concat([header, ...entries, ...images]));
}

await fs.access(src).catch(() => {
  // oxlint-disable-next-line eslint/no-console
  console.error(`Source icon not found at ${src}`);
  process.exit(1);
});

for (const [size, file] of PNGS) await resize(size, pub(file));
await ico(
  [
    [16, "favicon-16.png"],
    [32, "favicon.png"],
  ],
  pub("favicon.ico"),
);

for (const [, file] of [...PNGS, [0, "favicon.ico"]]) {
  const { size } = await fs.stat(pub(file));
  // oxlint-disable-next-line eslint/no-console
  console.log(`${file.padEnd(22)} ${(size / 1024).toFixed(1)} KB`);
}
