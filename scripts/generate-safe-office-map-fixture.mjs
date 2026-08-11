import { mkdir } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const width = 1_014;
const height = 1_314;
const channels = 3;
const pixels = Buffer.alloc(width * height * channels);

// Deterministic, high-information background used only for visual regression tests.
// It intentionally contains no real office layout, employee name, or business data.
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * channels;
    const grid = x % 48 < 3 || y % 48 < 3 ? 42 : 0;
    const texture = (x * 17 + y * 29 + ((x ^ y) % 31) * 7) % 38;
    pixels[offset] = Math.min(255, 214 + texture - grid);
    pixels[offset + 1] = Math.min(255, 230 + Math.floor(texture / 2) - grid);
    pixels[offset + 2] = Math.min(255, 244 + Math.floor(texture / 3) - grid);
  }
}

const overlay = Buffer.from(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="54" y="58" width="906" height="1198" rx="34" fill="none" stroke="#0b5fa5" stroke-width="10"/>
    <text x="507" y="142" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="700" fill="#0b3158">SYNTHETIC TEST MAP</text>
    <text x="507" y="190" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#356b91">NO REAL PEOPLE OR OFFICE DATA</text>
    <g stroke="#0b5fa5" stroke-width="7" fill="#ffffff" fill-opacity="0.76">
      <rect x="104" y="246" width="350" height="300" rx="20"/>
      <rect x="560" y="246" width="350" height="300" rx="20"/>
      <rect x="104" y="646" width="350" height="300" rx="20"/>
      <rect x="560" y="646" width="350" height="300" rx="20"/>
    </g>
    <g font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#0b3158" text-anchor="middle">
      <text x="279" y="410">ZONE A</text>
      <text x="735" y="410">ZONE B</text>
      <text x="279" y="810">ZONE C</text>
      <text x="735" y="810">ZONE D</text>
    </g>
    <g fill="none" stroke-linecap="round" stroke-width="18">
      <path d="M148 505 L248 310 L410 490" stroke="#12a6a0"/>
      <path d="M604 488 C650 305 840 305 870 488" stroke="#f29a2e"/>
      <path d="M150 704 L410 904 M410 704 L150 904" stroke="#7b61d1"/>
      <circle cx="735" cy="796" r="105" stroke="#e04f5f"/>
      <path d="M507 226 L507 1088" stroke="#0b5fa5" stroke-dasharray="24 22"/>
    </g>
    <rect x="178" y="1042" width="658" height="114" rx="24" fill="#0b5fa5"/>
    <text x="507" y="1111" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#ffffff">VISUAL REGRESSION FIXTURE</text>
  </svg>
`);

const target = path.join(process.cwd(), "tests", "fixtures", "office-map.png");
await mkdir(path.dirname(target), { recursive: true });
await sharp(pixels, { raw: { width, height, channels } })
  .composite([{ input: overlay }])
  .png({ compressionLevel: 9, adaptiveFiltering: false })
  .toFile(target);

console.log(`Generated ${target}`);
