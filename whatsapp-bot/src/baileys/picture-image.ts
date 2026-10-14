/**
 * PICTURE READING: getting the picture's bytes, in memory only (2026-10-14).
 *
 * `downloadPicture` streams the image straight into a Buffer through
 * Baileys' own decrypting download (`downloadContentFromMessage`, the same
 * one `downloadMediaMessage` uses, with no reupload request and no file).
 * A picture that SAYS it is larger than the cap is not fetched at all, and
 * one that turns out larger is abandoned mid-stream.
 *
 * `shrinkPicture` scales it so the long edge is at most 1,568 px, the size
 * the model reads at anyway (anything larger is scaled down by the API and
 * billed the same), as a JPEG. It uses `sharp` when it is installed (an
 * optional dependency of Baileys), entirely in memory. Without it, a JPEG,
 * PNG or WebP that is already small enough goes as it is, and anything
 * else is not sent.
 *
 * Never throws, never logs, never writes to disk.
 */
import { downloadContentFromMessage, normalizeMessageContent } from "baileys";

export const MAX_PICTURE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
/** What may go to the server (its own limit is 3.75 MB decoded). */
export const MAX_SEND_BYTES = 3 * 1024 * 1024;
export const PICTURE_LONG_EDGE = 1568;
const JPEG_QUALITY = 85;

type Bytes = AsyncIterable<Uint8Array>;

interface SharpLike {
  rotate(): SharpLike;
  resize(o: Record<string, unknown>): SharpLike;
  jpeg(o: Record<string, unknown>): SharpLike;
  toBuffer(): Promise<Buffer>;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as { toNumber?: unknown }).toNumber === "function") return (v as { toNumber(): number }).toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function downloadPicture(
  raw: unknown,
  opts: { open?: (media: Record<string, unknown>) => Promise<Bytes>; maxBytes?: number } = {},
): Promise<Buffer | null> {
  try {
    const maxBytes = opts.maxBytes ?? MAX_PICTURE_DOWNLOAD_BYTES;
    const message = (raw as { message?: unknown } | null)?.message;
    const content = normalizeMessageContent(message as never) as { imageMessage?: Record<string, unknown> } | undefined;
    const image = content?.imageMessage;
    if (!image) return null;
    if (toNumber(image.fileLength) > maxBytes) return null;
    const open = opts.open ?? ((media) => downloadContentFromMessage(media as never, "image") as Promise<Bytes>);
    const stream = await open(image);
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) {
        (stream as { destroy?: () => void }).destroy?.();
        return null;
      }
      parts.push(Buffer.from(chunk));
    }
    return total > 0 ? Buffer.concat(parts) : null;
  } catch {
    return null;
  }
}

function sniff(b: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function defaultLoadSharp(): Promise<((b: Buffer) => SharpLike) | null> {
  try {
    // A variable specifier: `sharp` is optional and not a declared dependency.
    const name = "sharp";
    const mod = (await import(name)) as { default?: unknown };
    return typeof mod.default === "function" ? (mod.default as (b: Buffer) => SharpLike) : null;
  } catch {
    return null;
  }
}

export async function shrinkPicture(
  bytes: Buffer,
  opts: { loadSharp?: () => Promise<((b: Buffer) => SharpLike) | null> } = {},
): Promise<{ data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/webp" } | null> {
  try {
    const sharp = await (opts.loadSharp ?? defaultLoadSharp)();
    if (sharp) {
      try {
        const data = await sharp(bytes)
          .rotate()
          .resize({ width: PICTURE_LONG_EDGE, height: PICTURE_LONG_EDGE, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY })
          .toBuffer();
        if (data.length > 0 && data.length <= MAX_SEND_BYTES) return { data, mediaType: "image/jpeg" };
      } catch {
        /* fall through to sending it as it is */
      }
    }
    const type = sniff(bytes);
    if (!type || bytes.length > MAX_SEND_BYTES) return null;
    return { data: bytes, mediaType: type };
  } catch {
    return null;
  }
}
