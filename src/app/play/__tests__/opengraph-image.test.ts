/**
 * The picture under a shared /play link (2026-11-10), checked on the pixels
 * of the real PNG (next/og renders under vitest; sharp reads it back).
 *
 * Facebook on a phone can centre-crop the 1200 x 630 picture to its middle
 * 630 x 630 square, so every word and the logo sit inside the centred safe
 * area (x 330 to 870); outside it there is only faint decoration. "Ink" is
 * a pixel the background never draws: near white (the words, the logo's
 * lines) or the badge's green.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { SHARE_IMAGE, SHARE_IMAGE_SAFE_AREA as SAFE } from "@/lib/pool/share-image-layout";
import OpenGraphImage, * as og from "../opengraph-image";
import * as tw from "../twitter-image";

const EN = poolLinkPreviewCopy("en");

async function render(): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const res = await OpenGraphImage();
  const png = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

const isInk = (r: number, g: number, b: number) => Math.min(r, g, b) >= 170 || (g >= 150 && r <= 120 && b <= 140);

describe("the /play share picture", () => {
  it("declares a 1200 x 630 PNG with the copy's alt text; X's picture is the same", () => {
    expect(og.size).toEqual(SHARE_IMAGE);
    expect(og.contentType).toBe("image/png");
    expect(og.alt).toBe(EN.imageAlt);
    expect(tw.size).toEqual(SHARE_IMAGE);
    expect(tw.contentType).toBe("image/png");
    expect(tw.alt).toBe(EN.imageAlt);
  });

  it("no step list in the copy any more: the alt text names what the picture shows", () => {
    expect(EN).not.toHaveProperty("imageSteps");
    expect(EN.imageAlt).toContain(EN.imageBadge);
  });

  it("every word and the logo sit inside the centred safe area, big; the picture fills 1200 x 630", { timeout: 30_000 }, async () => {
    const img = await render();
    expect([img.width, img.height]).toEqual([SHARE_IMAGE.width, SHARE_IMAGE.height]);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const outside: Array<[number, number]> = [];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * img.channels;
        if (!isInk(img.data[i], img.data[i + 1], img.data[i + 2])) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (x < SAFE.left || x >= SAFE.right || y < SAFE.top || y >= SAFE.bottom) outside.push([x, y]);
      }
    }
    expect(outside.slice(0, 5)).toEqual([]);
    // Centred, and big: the words fill most of the safe area's width and height.
    expect(Math.abs((minX + maxX) / 2 - SHARE_IMAGE.width / 2)).toBeLessThanOrEqual(24);
    expect(maxX - minX).toBeGreaterThanOrEqual(420);
    expect(maxY - minY).toBeGreaterThanOrEqual(380);
  });
});
