// Hermes — brand asset generator (Run 31, the official rebrand).
//
// Single source of truth: upload/HermesLogo.jpeg — the OFFICIAL Hermes
// mark (the golden caduceus on the dark tile, chosen by the owner).
// Everything the app wears is derived here:
//
//   public/hermes-mark.png      1024px  · the caduceus with the dark
//                                        studio background knocked out
//                                        to true transparency — the
//                                        inline brand mark (sidebar,
//                                        welcome hero, splash)
//   public/icon-192.png          192px   · mark @ 80% on #0d0d0d tile · manifest "any"
//   public/icon-512.png          512px   · mark @ 80% on #0d0d0d tile · manifest "any"
//   public/icon-maskable-512.png 512px   · mark @ 62% on #0d0d0d tile · manifest "maskable"
//   public/apple-icon.png        180px   · mark @ 80% on #0d0d0d tile · apple-touch-icon
//   src/app/icon.png             256px   · mark @ 80% on #0d0d0d tile · favicon
//
// Transparency: the official artwork is a JPEG, so the dark studio
// background is removed by a luminance-distance alpha ramp (the gold
// sits ~200 Chebyshev units above the ~#1a1a18 background; the ramp
// spans 24→64, safely above JPEG noise and vignette). The mark is
// taller than wide, so tiles use fit:"contain" — nothing is ever
// cropped, and the 62% maskable ratio keeps every gold pixel inside
// the circular safe zone (inner 80% disc Android masks with).
// Re-run after a logo change: `bun scripts/gen-pwa-icons.mjs`.

import sharp from "sharp";

const SRC = "upload/HermesLogo.jpeg";
const BG = { r: 13, g: 13, b: 13, alpha: 1 }; // #0d0d0d — the app tile
const WORK = 1600; // extraction resolution (downscaled later — crisp)

/** Extract the caduceus from the JPEG into a transparent PNG buffer. */
async function extractMark() {
  const { data, info } = await sharp(SRC)
    .resize(WORK, WORK, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // background = median of the border ring (robust vs vignette corners)
  const vals = [];
  const at = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  for (let x = 0; x < info.width; x += 4) {
    vals.push(at(x, 0), at(x, info.height - 1));
  }
  for (let y = 0; y < info.height; y += 4) {
    vals.push(at(0, y), at(info.width - 1, y));
  }
  const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bg = [med(vals.map((v) => v[0])), med(vals.map((v) => v[1])), med(vals.map((v) => v[2]))];

  // alpha ramp: 0 below LO (noise/vignette), 1 above HI (the gold)
  const LO = 24, HI = 64;
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let p = 0, q = 0; p < data.length; p += info.channels, q += 4) {
    const d = Math.max(
      Math.abs(data[p] - bg[0]),
      Math.abs(data[p + 1] - bg[1]),
      Math.abs(data[p + 2] - bg[2])
    );
    let a = (d - LO) / (HI - LO);
    a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a); // smoothstep
    const alpha = Math.round(a * 255);
    out[q] = data[p];
    out[q + 1] = data[p + 1];
    out[q + 2] = data[p + 2];
    out[q + 3] = alpha < 10 ? 0 : alpha > 246 ? 255 : alpha;
  }

  // trim the dead margins to the gold's bounding box (top-left pixel
  // is fully transparent after the ramp — trim eats the empty border),
  // add ~5% breathing room, downscale to a crisp 1024px asset
  const rawPng = await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const bbox = await sharp(rawPng)
    .trim()
    .png()
    .toBuffer()
    .then((b) => sharp(b).metadata());
  const pad = Math.round(Math.max(bbox.width, bbox.height) * 0.05);
  return sharp(rawPng)
    .trim()
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(1024, 1024, { fit: "inside" })
    .png()
    .toBuffer();
}

const mark = await extractMark();
await sharp(mark).toFile("public/hermes-mark.png");
console.log("✓ public/hermes-mark.png (transparent inline mark)");

async function tile(size, markRatio, out) {
  const inner = Math.round(size * markRatio);
  const logo = await sharp(mark)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(out);
  console.log(`✓ ${out} (${size}×${size}, mark ${Math.round(markRatio * 100)}%)`);
}

await tile(192, 0.8, "public/icon-192.png");
await tile(512, 0.8, "public/icon-512.png");
await tile(512, 0.62, "public/icon-maskable-512.png");
await tile(180, 0.8, "public/apple-icon.png");
await tile(256, 0.8, "src/app/icon.png");
console.log("done");
