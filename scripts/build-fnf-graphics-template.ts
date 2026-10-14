/**
 * BUILD FNF'S GRAPHICS TEMPLATE FROM THEIR OWN TEAM SHEET (2026-10-14).
 *
 * FNF post their teams on a designed board (night stadium, billboard,
 * their logo, a white and a pink column of nine rows). This takes one of
 * their real team sheets and paints out everything that changes week to
 * week, the 18 names, the date and the time, so MatchTime can draw new
 * ones in the same places. What stays: the stadium, the frame, the logo,
 * the calendar and clock icons, the TEAM 1 / TEAM 2 headers with their
 * shirts, the shirt icon on every row and the separators.
 *
 *   npx tsx scripts/build-fnf-graphics-template.ts <source.jpg> <out-dir>
 *
 * Writes <out-dir>/fnf-template.jpg and <out-dir>/fnf-layout.json. Run it
 * LOCALLY and keep the output OUTSIDE the repo: the source carries real
 * names and the template carries FNF's branding, which is club data and
 * never goes into git. `scripts/seed-club-graphics-template.ts` then
 * stores the pair on the club.
 *
 * HOW A NAME IS PAINTED OUT. Every row's background is a smooth
 * horizontal gradient (near black on the left, glowing pink towards the
 * right edge of the pink column) that hardly changes from top to bottom
 * of a row. So each pixel column of a name's box is refilled by
 * interpolating, top to bottom, between the real pixels just above and
 * just below the lettering at that same x. The gradient, the pink glow
 * and the separators (which lie outside the boxes) are therefore the
 * source's own pixels, and a little grain is added so the fill does not
 * read as flatter than the JPEG around it.
 *
 * The coordinates were measured on FNF's 941 x 1672 export (the cap
 * height of a name is 29 px, the lettering starts at x 200 on the left
 * and x 618 on the right). The script refuses a source of another size.
 *
 * Uses `sharp`, which ships with Next.js; this script is not part of the
 * app and needs no network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ClubGraphicsLayout } from "../src/lib/club-graphics-layout";

const WIDTH = 941;
const HEIGHT = 1672;

/** Cap top and bottom of the lettering on each of the nine rows, measured. */
const ROW_CAPS: Array<[number, number]> = [
  [529, 557],
  [592, 620],
  [654, 683],
  [715, 744],
  [777, 806],
  [840, 869],
  [904, 934],
  [969, 999],
  [1033, 1063],
];

/** The x span refilled in each column: from just before the lettering to short of the column's lit edge. */
const COLUMN_SPANS: Array<[number, number]> = [
  [192, 438],
  [610, 848],
];

/** Date and time text boxes (the icons to their left are kept). */
const DATE_BOX = { x0: 758, x1: 864, top: 224, bottom: 241 };
const TIME_BOX = { x0: 758, x1: 838, top: 262, bottom: 283 };

const PAD = 7; // halo around the lettering that is refilled too
const SAMPLE = 4; // rows averaged above and below for each column of pixels
const SMOOTH = 8; // half-width, in pixels, of the median along the row

const FNF_LAYOUT: ClubGraphicsLayout = {
  version: 1,
  width: WIDTH,
  height: HEIGHT,
  rows: ROW_CAPS.map(([top, bottom]) => Math.round(((top + bottom) / 2) * 10) / 10),
  capHeight: 29,
  name: { colour: "#ffffff", maxFontSize: 42, minFontSize: 26 },
  columns: [
    { nameX: 200, maxWidth: 232, iconCentreX: 142, badgeColour: "#0b0b0d" },
    { nameX: 618, maxWidth: 222, iconCentreX: 562, badgeColour: "#ffffff" },
  ],
  date: { x: 764, centreY: 232.5, fontSize: 20, colour: "#ffffff", maxWidth: 98 },
  time: { x: 765, centreY: 270, fontSize: 20, colour: "#ffffff", maxWidth: 98 },
  squadHeader: {
    panel: { x: 72, y: 377, width: 801, height: 123 },
    from: "#e9e9eb",
    to: "#f9047f",
    titleColour: "#0b0b0d",
    titleFontSize: 72,
    keep: [
      { x: 80, y: 340, width: 190, height: 160 },
      { x: 712, y: 340, width: 158, height: 160 },
    ],
  },
  reserves: { centreX: 470, centreY: 1096, fontSize: 19, colour: "#ffffff", maxWidth: 760 },
};

function grain(): number {
  // Small, roughly normal noise (sum of uniforms), about +-1.5 levels.
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.8;
}

/** The median of the values within `radius` of each index (clamped at the ends). */
function medianSmooth(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const window = values.slice(Math.max(0, i - radius), Math.min(values.length, i + radius + 1)).sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)];
  });
}

function refill(pixels: Buffer, channels: number, box: { x0: number; x1: number; top: number; bottom: number }) {
  const at = (x: number, y: number, c: number) => (y * WIDTH + x) * channels + c;
  const span = box.bottom - box.top + 1;
  for (let c = 0; c < 3; c++) {
    // The background just above and just below the box at every x,
    // median-smoothed along the row so the JPEG ringing around the old
    // lettering cannot print a ghost of it into the fill.
    const sample = (edge: (k: number) => number) => {
      const raw: number[] = [];
      for (let x = box.x0; x <= box.x1; x++) {
        let sum = 0;
        for (let k = 1; k <= SAMPLE; k++) sum += pixels[at(x, edge(k), c)];
        raw.push(sum / SAMPLE);
      }
      return medianSmooth(raw, SMOOTH);
    };
    const above = sample((k) => box.top - k);
    const below = sample((k) => box.bottom + k);
    for (let x = box.x0; x <= box.x1; x++) {
      const a = above[x - box.x0];
      const b = below[x - box.x0];
      for (let y = box.top; y <= box.bottom; y++) {
        const t = (y - box.top + 1) / (span + 1);
        pixels[at(x, y, c)] = Math.max(0, Math.min(255, Math.round(a + (b - a) * t + grain())));
      }
    }
  }
}

async function main() {
  const [source, outDir] = process.argv.slice(2);
  if (!source || !outDir) {
    console.error("usage: build-fnf-graphics-template.ts <source.jpg> <out-dir>");
    process.exit(1);
  }
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== WIDTH || info.height !== HEIGHT) {
    console.error(`expected a ${WIDTH}x${HEIGHT} source, got ${info.width}x${info.height}`);
    process.exit(1);
  }
  const pixels = Buffer.from(data);

  for (const [x0, x1] of COLUMN_SPANS) {
    for (const [capTop, capBottom] of ROW_CAPS) {
      refill(pixels, info.channels, { x0, x1, top: capTop - PAD, bottom: capBottom + PAD });
    }
  }
  refill(pixels, info.channels, DATE_BOX);
  refill(pixels, info.channels, TIME_BOX);

  await mkdir(outDir, { recursive: true });
  const jpg = await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: info.channels } })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const imagePath = path.join(outDir, "fnf-template.jpg");
  const layoutPath = path.join(outDir, "fnf-layout.json");
  await writeFile(imagePath, jpg);
  await writeFile(layoutPath, `${JSON.stringify(FNF_LAYOUT, null, 2)}\n`);
  console.log(`template ${imagePath} bytes=${jpg.length}`);
  console.log(`layout   ${layoutPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
