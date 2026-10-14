/**
 * AN OWNER'S OWN POSTER BACKGROUND (2026-10-14, the "Posters" card).
 *
 * The owner uploads a portrait picture; MatchTime draws its own board on
 * top of it (`match-graphics-render.tsx`, the `background` option). This
 * file decides what is accepted and what is stored:
 *
 *   - JPEG, PNG or WebP, told by the file's own first bytes (never its
 *     name, never the type the browser claims): anything else is
 *     "bad-type", and a file that claims to be a picture but is not one,
 *     or is cut short, is "bad-bytes";
 *   - at most `BACKGROUND_MAX_BYTES`, under Vercel's 4.5 MB request cap;
 *   - big enough to fill the poster, and portrait (square allowed), with
 *     a phone photo's EXIF turn counted;
 *   - STORED re-encoded by sharp as a 1080 x 1350 JPEG, cropped to fill
 *     (EXIF turned, metadata dropped, so no location or camera data is
 *     kept). The renderer then only ever draws one size and one type.
 *     Where sharp cannot be loaded, a JPEG or PNG is stored as uploaded
 *     (after the checks above) and drawn with object-fit: cover; a WebP
 *     is refused then, since the renderer cannot draw it.
 *
 * `checkBackground`, `sniffImageType`, `imageDimensions` and
 * `portraitProblem` are pure; `prepareBackground` runs sharp.
 */
import { GRAPHIC_HEIGHT, GRAPHIC_WIDTH } from "./match-graphics-layout";

export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024;
export const BACKGROUND_MIN_WIDTH = 540;
export const BACKGROUND_MIN_HEIGHT = 675;
/** A side longer than this is refused before it is decoded. */
const MAX_SIDE = 10_000;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";
export type BackgroundProblem = "empty" | "too-large" | "bad-type" | "bad-bytes" | "too-small" | "not-portrait";

const ACCEPTED_CLAIMS = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/webp"]);

const ascii = (b: Uint8Array, at: number, s: string) => s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

export function sniffImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  return null;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/** Width and height from the header, or null for a header that is not there or not whole. */
export function imageDimensions(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  if (type === "image/png") {
    if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (type === "image/webp") {
    if (b.length < 30) return null;
    if (ascii(b, 12, "VP8 ")) {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (ascii(b, 12, "VP8L")) {
      if (b[20] !== 0x2f) return null;
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(b, 12, "VP8X")) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  // JPEG: walk the markers to the first start-of-frame.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    i += 2 + len;
  }
  return null;
}

export function portraitProblem(width: number, height: number): "not-portrait" | null {
  return width > height ? "not-portrait" : null;
}

export type BackgroundCheck = { ok: true; type: ImageType; width: number; height: number } | { ok: false; problem: BackgroundProblem };

/** The upload's bytes and the type the browser claimed. Pure. */
export function checkBackground(bytes: Uint8Array, claimedType?: string | null): BackgroundCheck {
  if (bytes.length === 0) return { ok: false, problem: "empty" };
  if (bytes.length > BACKGROUND_MAX_BYTES) return { ok: false, problem: "too-large" };
  const type = sniffImageType(bytes);
  if (!type) {
    const claimed = (claimedType ?? "").toLowerCase().trim();
    return { ok: false, problem: ACCEPTED_CLAIMS.has(claimed) ? "bad-bytes" : "bad-type" };
  }
  const dims = imageDimensions(bytes, type);
  if (!dims || dims.width < 1 || dims.height < 1 || dims.width > MAX_SIDE || dims.height > MAX_SIDE) return { ok: false, problem: "bad-bytes" };
  const shorter = Math.min(dims.width, dims.height);
  const longer = Math.max(dims.width, dims.height);
  if (shorter < BACKGROUND_MIN_WIDTH || longer < BACKGROUND_MIN_HEIGHT) return { ok: false, problem: "too-small" };
  return { ok: true, type, ...dims };
}

export type PreparedBackground =
  | { ok: true; image: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number }
  | { ok: false; problem: BackgroundProblem };

type SharpFn = typeof import("sharp");

async function loadSharp(): Promise<SharpFn | null> {
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFn } & SharpFn;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** Check, turn, crop and re-encode an upload; or say why it is refused. Never throws. */
export async function prepareBackground(bytes: Uint8Array, claimedType?: string | null): Promise<PreparedBackground> {
  const check = checkBackground(bytes, claimedType);
  if (!check.ok) return check;
  const sharp = await loadSharp();

  if (!sharp) {
    // No sharp: only what the renderer can draw as it is.
    if (check.type === "image/webp") return { ok: false, problem: "bad-type" };
    if (portraitProblem(check.width, check.height)) return { ok: false, problem: "not-portrait" };
    return { ok: true, image: Buffer.from(bytes), mimeType: check.type, width: check.width, height: check.height };
  }

  try {
    const input = Buffer.from(bytes);
    const meta = await sharp(input, { failOn: "error", limitInputPixels: MAX_SIDE * MAX_SIDE }).metadata();
    if (!meta.width || !meta.height) return { ok: false, problem: "bad-bytes" };
    // EXIF orientations 5 to 8 turn the picture a quarter: shown sideways.
    const turned = (meta.orientation ?? 1) >= 5;
    const shownW = turned ? meta.height : meta.width;
    const shownH = turned ? meta.width : meta.height;
    if (portraitProblem(shownW, shownH)) return { ok: false, problem: "not-portrait" };
    const image = await sharp(input, { failOn: "error", limitInputPixels: MAX_SIDE * MAX_SIDE })
      .rotate()
      .resize(GRAPHIC_WIDTH, GRAPHIC_HEIGHT, { fit: "cover", position: "centre" })
      .flatten({ background: "#0f172a" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { ok: true, image, mimeType: "image/jpeg", width: GRAPHIC_WIDTH, height: GRAPHIC_HEIGHT };
  } catch {
    return { ok: false, problem: "bad-bytes" };
  }
}
