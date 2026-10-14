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
 *   npx tsx scripts/build-fnf-graphics-template.ts --shared <fnf-template.jpg> <out-dir>
 *
 * Writes <out-dir>/fnf-template.jpg and <out-dir>/fnf-layout.json (FNF's
 * own board), and <out-dir>/fnf-shared-template.jpg and
 * fnf-shared-layout.json: the "Floodlights" variant other clubs get when
 * FNF's board is shared, with FNF's logo, its "FRIDAY NIGHT FOOTBALL" line
 * and the FNF on both shirts painted out (see below). `--shared` builds
 * only the variant, from an already blank fnf-template.jpg. Run it
 * LOCALLY and keep the output OUTSIDE the repo: the source carries real
 * names and the templates carry FNF's artwork, which is club data and
 * never goes into git. `scripts/seed-club-graphics-template.ts` then
 * stores them on the club (its header has both commands).
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

// ── The shared variant, "Floodlights" (2026-10-14) ──────────────────────
//
// Other clubs may pick FNF's board (FNF agreed), but never with FNF on it.
// The shared variant is the blank template with FNF's branding painted
// out, the same way the names are: the big "FNF" logo with its "FRIDAY
// NIGHT FOOTBALL" line, and the "FNF" printed on the white shirt and on
// the pink bib in the two headers (refilled from the fabric above and
// below, so the shirts read as plain). In its layout, `brandArea` is where
// the logo was: MatchTime writes the picking club's name there in the
// logo's heavy italic, and under it "<WEEKDAY> NIGHT FOOTBALL" spaced out
// like FNF's line (`club-graphics-render.tsx`). FNF itself keeps the
// branded template; the variant is stored beside it (`sharedImage`,
// `sharedLayout`) and only drawn for other clubs.

/** The logo and the line under it, up to the calendar and clock icons. */
const LOGO_BOX = { x0: 232, x1: 712, top: 206, bottom: 339 };
/**
 * "FNF" on the white shirt (TEAM 1) and on the pink bib (TEAM 2), each
 * with a clean patch of the same fabric below the print (its fine texture,
 * the bib's mesh, is tiled into the fill).
 */
interface FabricBox {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** A clean patch of the same fabric whose fine grain is tiled in. */
  texture: { x: number; y: number; w: number; h: number };
  /** How much of that grain: the bib's mesh needs it, the shirt hardly. */
  grain: number;
}

const SHIRT_BOXES: FabricBox[] = [
  { x0: 133, x1: 238, top: 401, bottom: 455, texture: { x: 150, y: 460, w: 40, h: 28 }, grain: 0.4 },
  { x0: 733, x1: 832, top: 399, bottom: 461, texture: { x: 782, y: 465, w: 40, h: 26 }, grain: 1 },
];

const SHARED_LAYOUT: ClubGraphicsLayout = {
  ...FNF_LAYOUT,
  brandArea: {
    x: 236,
    y: 206,
    width: 468,
    height: 132,
    colour: "#ececee",
    maxFontSize: 96,
    nameCentreY: 266,
    subtitle: { centreY: 329, fontSize: 17, colour: "#ffffff", letterSpacing: 5 },
  },
};

function paintOutBranding(pixels: Buffer, channels: number) {
  refill(pixels, channels, LOGO_BOX);
  for (const box of SHIRT_BOXES) refillFabric(pixels, channels, box);
}

/**
 * A print on a garment refilled so it reads as plain fabric:
 *   - the shading: each pixel column interpolated between the fabric just
 *     above and just below the print (as for the names), which meets the
 *     garment with no step at the top or the bottom;
 *   - the texture: the FINE grain of a clean patch of the same fabric
 *     (each pixel minus the mean of its 3 x 3 neighbours, so folds and
 *     shading do not come along), tiled mirrored across the box, so the
 *     bib's mesh carries on through it;
 *   - the sides: blended into the untouched garment over `FEATHER`
 *     pixels, so no vertical edge shows where the shading turns.
 */
const FEATHER = 6;

function refillFabric(pixels: Buffer, channels: number, box: FabricBox) {
  const at = (x: number, y: number, c: number) => (y * WIDTH + x) * channels + c;
  const { x0, x1, top, bottom, texture: tx, grain: amount } = box;
  const original = Buffer.from(pixels);
  const span = bottom - top + 1;

  const detail: number[][] = [0, 1, 2].map((c) => {
    const out: number[] = [];
    for (let j = 0; j < tx.h; j++) {
      for (let i = 0; i < tx.w; i++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += original[at(tx.x + i + dx, tx.y + j + dy, c)];
        out.push((original[at(tx.x + i, tx.y + j, c)] - sum / 9) * amount);
      }
    }
    return out;
  });
  const mirror = (v: number, n: number) => {
    const q = v % (2 * n);
    return q < n ? q : 2 * n - 1 - q;
  };

  for (let c = 0; c < 3; c++) {
    const edge = (y0: number, step: number) =>
      medianSmooth(
        Array.from({ length: x1 - x0 + 1 }, (_, i) => {
          let sum = 0;
          for (let k = 1; k <= SAMPLE; k++) sum += original[at(x0 + i, y0 + step * k, c)];
          return sum / SAMPLE;
        }),
        3,
      );
    const above = edge(top, -1);
    const below = edge(bottom, 1);
    for (let x = x0; x <= x1; x++) {
      const i = x - x0;
      const alpha = Math.min(1, (Math.min(x - x0, x1 - x) + 1) / FEATHER);
      for (let y = top; y <= bottom; y++) {
        const t = (y - top + 1) / (span + 1);
        const fill = above[i] + (below[i] - above[i]) * t + detail[c][mirror(y - top, tx.h) * tx.w + mirror(i, tx.w)];
        const v = alpha * fill + (1 - alpha) * original[at(x, y, c)];
        pixels[at(x, y, c)] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
}

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

const encode = (pixels: Buffer, channels: number) =>
  sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: channels as 3 } })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();

async function readPixels(file: string): Promise<{ pixels: Buffer; channels: number }> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== WIDTH || info.height !== HEIGHT) {
    console.error(`expected a ${WIDTH}x${HEIGHT} image, got ${info.width}x${info.height}`);
    process.exit(1);
  }
  return { pixels: Buffer.from(data), channels: info.channels };
}

async function writePair(outDir: string, name: string, jpg: Buffer, layout: ClubGraphicsLayout) {
  const imagePath = path.join(outDir, `${name}-template.jpg`);
  const layoutPath = path.join(outDir, `${name}-layout.json`);
  await writeFile(imagePath, jpg);
  await writeFile(layoutPath, `${JSON.stringify(layout, null, 2)}\n`);
  console.log(`template ${imagePath} bytes=${jpg.length}`);
  console.log(`layout   ${layoutPath}`);
}

/**
 *   <source.jpg> <out-dir>              FNF's own blank template AND the shared variant
 *   --shared <fnf-template.jpg> <out-dir>   only the shared variant, from the blank template
 */
async function main() {
  const args = process.argv.slice(2);
  const sharedOnly = args[0] === "--shared";
  const [source, outDir] = sharedOnly ? args.slice(1) : args;
  if (!source || !outDir) {
    console.error("usage: build-fnf-graphics-template.ts [--shared] <source.jpg> <out-dir>");
    process.exit(1);
  }
  const { pixels, channels } = await readPixels(source);
  await mkdir(outDir, { recursive: true });

  if (!sharedOnly) {
    for (const [x0, x1] of COLUMN_SPANS) {
      for (const [capTop, capBottom] of ROW_CAPS) {
        refill(pixels, channels, { x0, x1, top: capTop - PAD, bottom: capBottom + PAD });
      }
    }
    refill(pixels, channels, DATE_BOX);
    refill(pixels, channels, TIME_BOX);
    await writePair(outDir, "fnf", await encode(pixels, channels), FNF_LAYOUT);
  }

  paintOutBranding(pixels, channels);
  await writePair(outDir, "fnf-shared", await encode(pixels, channels), SHARED_LAYOUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
