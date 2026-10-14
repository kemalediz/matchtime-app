/**
 * An owner's own poster background (2026-10-14, "Posters"): what is
 * accepted, what is refused and why, and what is stored.
 *
 *   - JPEG, PNG or WebP, decided by the file's own first bytes, never by
 *     its name or the type the browser claims;
 *   - at most BACKGROUND_MAX_BYTES (under Vercel's 4.5 MB request cap);
 *   - portrait (taller than wide, a phone photo's EXIF turn counted) and
 *     big enough to fill the poster;
 *   - stored re-encoded with sharp as a 1080 x 1350 JPEG, cropped to fill,
 *     so the renderer only ever draws one size and one type.
 *
 * The images are made here with sharp: invented flat colours, no club's
 * artwork.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  BACKGROUND_MAX_BYTES,
  checkBackground,
  imageDimensions,
  portraitProblem,
  prepareBackground,
  sniffImageType,
} from "../graphics-background";

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });
const png = (w: number, h: number) => solid(w, h).png().toBuffer();
const jpeg = (w: number, h: number) => solid(w, h).jpeg().toBuffer();
const webp = (w: number, h: number) => solid(w, h).webp().toBuffer();

describe("sniffImageType: by the first bytes only", () => {
  it("JPEG, PNG and WebP", async () => {
    expect(sniffImageType(await jpeg(10, 20))).toBe("image/jpeg");
    expect(sniffImageType(await png(10, 20))).toBe("image/png");
    expect(sniffImageType(await webp(10, 20))).toBe("image/webp");
  });

  it("anything else, or too short: null", async () => {
    expect(sniffImageType(Buffer.from("GIF89a......"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("imageDimensions: from the header", () => {
  it("reads PNG, JPEG and WebP sizes", async () => {
    expect(imageDimensions(await png(600, 800), "image/png")).toEqual({ width: 600, height: 800 });
    expect(imageDimensions(await jpeg(601, 801), "image/jpeg")).toEqual({ width: 601, height: 801 });
    expect(imageDimensions(await webp(602, 802), "image/webp")).toEqual({ width: 602, height: 802 });
    expect(imageDimensions(await solid(603, 803).webp({ lossless: true }).toBuffer(), "image/webp")).toEqual({ width: 603, height: 803 });
  });

  it("a truncated file: null", async () => {
    expect(imageDimensions((await jpeg(600, 800)).subarray(0, 12), "image/jpeg")).toBeNull();
    expect(imageDimensions((await png(600, 800)).subarray(0, 12), "image/png")).toBeNull();
  });
});

describe("checkBackground: type, size and bytes", () => {
  it("a portrait PNG of a usable size: accepted, with its type and size", async () => {
    expect(checkBackground(await png(1080, 1350), "image/png")).toEqual({ ok: true, type: "image/png", width: 1080, height: 1350 });
  });

  it("the bytes decide the type, not the browser's claim", async () => {
    expect(checkBackground(await jpeg(800, 1000), "image/png")).toMatchObject({ ok: true, type: "image/jpeg" });
  });

  it("nothing uploaded: empty", () => {
    expect(checkBackground(Buffer.alloc(0), "image/png")).toEqual({ ok: false, problem: "empty" });
  });

  it("over the limit: too-large, before anything else is looked at", () => {
    expect(checkBackground(Buffer.alloc(BACKGROUND_MAX_BYTES + 1), "image/png")).toEqual({ ok: false, problem: "too-large" });
    expect(BACKGROUND_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });

  it("not one of the three types (a GIF, an SVG, a PDF): bad-type", () => {
    expect(checkBackground(Buffer.from("GIF89a" + "x".repeat(40)), "image/gif")).toEqual({ ok: false, problem: "bad-type" });
    expect(checkBackground(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml")).toEqual({ ok: false, problem: "bad-type" });
    expect(checkBackground(Buffer.from("%PDF-1.7 ..."), "application/pdf")).toEqual({ ok: false, problem: "bad-type" });
  });

  it("claims to be a picture but the bytes are not one, or are cut short: bad-bytes", async () => {
    expect(checkBackground(Buffer.from("this is not really a png at all"), "image/png")).toEqual({ ok: false, problem: "bad-bytes" });
    expect(checkBackground((await png(600, 800)).subarray(0, 20), "image/png")).toEqual({ ok: false, problem: "bad-bytes" });
  });

  it("too small to fill the poster: too-small", async () => {
    expect(checkBackground(await png(400, 600), "image/png")).toEqual({ ok: false, problem: "too-small" });
  });
});

describe("portraitProblem", () => {
  it("taller than wide, or square: fine; wider than tall: not-portrait", () => {
    expect(portraitProblem(1080, 1350)).toBeNull();
    expect(portraitProblem(1000, 1000)).toBeNull();
    expect(portraitProblem(1350, 1080)).toBe("not-portrait");
  });
});

describe("prepareBackground: what is stored", () => {
  it("a portrait picture: re-encoded as a 1080 x 1350 JPEG, filled and cropped", async () => {
    const r = await prepareBackground(await png(900, 1600));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mimeType).toBe("image/jpeg");
    expect([r.width, r.height]).toEqual([1080, 1350]);
    const m = await sharp(r.image).metadata();
    expect([m.format, m.width, m.height]).toEqual(["jpeg", 1080, 1350]);
  });

  it("WebP is taken and stored as JPEG (the renderer draws JPEG and PNG only)", async () => {
    const r = await prepareBackground(await webp(800, 1000));
    expect(r).toMatchObject({ ok: true, mimeType: "image/jpeg", width: 1080, height: 1350 });
  });

  it("a landscape picture: not-portrait", async () => {
    expect(await prepareBackground(await png(1600, 900))).toEqual({ ok: false, problem: "not-portrait" });
  });

  it("a phone photo stored sideways with an EXIF turn that makes it portrait: accepted", async () => {
    // 1600 x 900 pixels, orientation 6 (turn 90 degrees): shown 900 x 1600.
    const sideways = await solid(1600, 900).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await prepareBackground(sideways);
    expect(r).toMatchObject({ ok: true, width: 1080, height: 1350 });
  });

  it("good magic bytes, broken picture: bad-bytes, never a crash", async () => {
    const good = await jpeg(800, 1000);
    const broken = Buffer.concat([good.subarray(0, 400), Buffer.alloc(2000, 0x41)]);
    const r = await prepareBackground(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["bad-bytes"]).toContain(r.problem);
  });
});
