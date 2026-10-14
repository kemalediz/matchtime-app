import { describe, expect, it, vi } from "vitest";
import { downloadPicture, shrinkPicture, MAX_PICTURE_DOWNLOAD_BYTES, MAX_SEND_BYTES, PICTURE_LONG_EDGE } from "./picture-image.js";

async function* chunks(...parts: Buffer[]) {
  for (const p of parts) yield p;
}

const msg = (fileLength?: number, extra: Record<string, unknown> = {}) => ({
  key: { id: "X" },
  message: { imageMessage: { mimetype: "image/jpeg", fileLength, mediaKey: new Uint8Array([1]), directPath: "/p", ...extra } },
});

describe("downloadPicture", () => {
  it("collects the stream in memory", async () => {
    const open = vi.fn(async () => chunks(Buffer.from("ab"), Buffer.from("cd")));
    expect((await downloadPicture(msg(4), { open }))?.toString()).toBe("abcd");
  });

  it("a picture that says it is too large is not downloaded at all", async () => {
    const open = vi.fn(async () => chunks(Buffer.from("x")));
    expect(await downloadPicture(msg(MAX_PICTURE_DOWNLOAD_BYTES + 1), { open })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("a stream that runs past the cap is abandoned", async () => {
    const open = vi.fn(async () => chunks(Buffer.alloc(10), Buffer.alloc(10)));
    expect(await downloadPicture(msg(5), { open, maxBytes: 15 })).toBeNull();
  });

  it("a message with no image is not downloaded", async () => {
    const open = vi.fn();
    expect(await downloadPicture({ key: {}, message: { conversation: "hi" } }, { open })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("finds an image inside a wrapper (disappearing messages)", async () => {
    const open = vi.fn(async () => chunks(Buffer.from("z")));
    const wrapped = { key: {}, message: { ephemeralMessage: { message: msg(1).message } } };
    expect((await downloadPicture(wrapped, { open }))?.toString()).toBe("z");
  });
});

describe("shrinkPicture", () => {
  it("resizes to the long edge as JPEG when the image library is there", async () => {
    const calls: unknown[] = [];
    const sharp = vi.fn((_b: Buffer) => {
      const api = {
        rotate: () => api,
        resize: (o: unknown) => (calls.push(o), api),
        jpeg: (o: unknown) => (calls.push(o), api),
        toBuffer: async () => Buffer.from("small"),
      };
      return api;
    });
    const out = await shrinkPicture(Buffer.alloc(100), { loadSharp: async () => sharp as never });
    expect(out).toEqual({ data: Buffer.from("small"), mediaType: "image/jpeg" });
    expect(calls[0]).toMatchObject({ width: PICTURE_LONG_EDGE, height: PICTURE_LONG_EDGE, fit: "inside", withoutEnlargement: true });
  });

  it("no image library: a small JPEG goes as it is", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    expect(await shrinkPicture(jpeg, { loadSharp: async () => null })).toEqual({ data: jpeg, mediaType: "image/jpeg" });
  });

  it("no image library: a picture that is too large, or not a known type, is not sent", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_SEND_BYTES)]);
    expect(await shrinkPicture(big, { loadSharp: async () => null })).toBeNull();
    expect(await shrinkPicture(Buffer.from("GIF89a"), { loadSharp: async () => null })).toBeNull();
  });

  it("a library that throws falls back, never throws", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const sharp = () => {
      throw new Error("bad input");
    };
    expect(await shrinkPicture(jpeg, { loadSharp: async () => sharp as never })).toEqual({ data: jpeg, mediaType: "image/jpeg" });
  });
});
