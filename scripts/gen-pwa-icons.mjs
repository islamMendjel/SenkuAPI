// SenkuAPI — PWA icon generator (Run 27).
//
// Renders every PWA icon from the ONE brand asset the app already
// uses everywhere (public/senku-sparkle.png), composited on the
// brand tile (#0d0d0d) so the icon reads on any OS surface:
//
//   public/icon-192.png          192×192  · sparkle @ 80%  · manifest "any"
//   public/icon-512.png          512×512  · sparkle @ 80%  · manifest "any"
//   public/icon-maskable-512.png 512×512  · sparkle @ 64%  · manifest "maskable"
//   public/apple-icon.png        180×180  · sparkle @ 80%  · apple-touch-icon
//   src/app/icon.png             256×256  · sparkle @ 80%  · favicon
//
// The 64% maskable ratio keeps the mark inside the circular safe
// zone (the inner 80% diameter disc Chrome/Android masks with), so
// nothing is ever clipped on round/ squircle/ crop launches.
// Re-run after a logo change: `bun scripts/gen-pwa-icons.mjs`.

import sharp from "sharp";

const SRC = "public/senku-sparkle.png";
const BG = { r: 13, g: 13, b: 13, alpha: 1 }; // #0d0d0d

async function tile(size, logoRatio, out) {
  const inner = Math.round(size * logoRatio);
  const logo = await sharp(SRC)
    .resize(inner, inner, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(out);
  console.log(`✓ ${out} (${size}×${size}, sparkle ${Math.round(logoRatio * 100)}%)`);
}

await tile(192, 0.8, "public/icon-192.png");
await tile(512, 0.8, "public/icon-512.png");
await tile(512, 0.64, "public/icon-maskable-512.png");
await tile(180, 0.8, "public/apple-icon.png");
await tile(256, 0.8, "src/app/icon.png");
console.log("done");
