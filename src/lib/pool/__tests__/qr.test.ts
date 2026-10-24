/**
 * The QR downloads (slice G1): a real PNG and a real SVG for the link.
 */
import QRCode from "qrcode";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { poolQrPng, poolQrSvg, readQrFormat } from "../qr";

const URL = "https://matchtime.ai/play?src=leaflet-sutton-oct";

describe("pool QR codes", () => {
  it("a PNG, 1024 pixels square", async () => {
    const png = await poolQrPng(URL);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1024);
  });

  it("an SVG of the same code", async () => {
    const svg = await poolQrSvg(URL);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain("<path");
    // The same link always draws the same code; another link draws another.
    expect(await poolQrSvg(URL)).toBe(svg);
    expect(await poolQrSvg(`${URL}x`)).not.toBe(svg);
  });

  it("encodes exactly the link, at error correction M", () => {
    const qr = QRCode.create(URL, { errorCorrectionLevel: "M" });
    const bytes = qr.segments.map((s) => Buffer.from((s as unknown as { data: Uint8Array }).data).toString("utf8")).join("");
    expect(bytes).toBe(URL);
  });

  it("PNG unless SVG is asked for", () => {
    expect(readQrFormat("svg")).toBe("svg");
    expect(readQrFormat("png")).toBe("png");
    expect(readQrFormat(null)).toBe("png");
    expect(readQrFormat("gif")).toBe("png");
  });
});
