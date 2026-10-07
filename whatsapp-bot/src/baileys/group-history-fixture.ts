/**
 * Builds a SYNTHETIC group history bundle for tests, the way a WhatsApp
 * client that shares history would: a protobuf, compressed, encrypted with
 * the media scheme, with the hashes the pointer message carries.
 *
 * Not a test file and not imported by the bot: like `fake-socket.ts`, it
 * exists so more than one test can exercise download, decrypt and parse
 * end to end without a real bundle (none has been captured yet).
 */
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { proto } from "baileys";
import { deriveMediaKeys } from "./group-history-bundle.js";

export function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

/** One length-delimited protobuf field. */
export function lenField(fieldNo: number, bytes: Uint8Array): Buffer {
  return Buffer.concat([varint(fieldNo * 8 + 2), varint(bytes.length), Buffer.from(bytes)]);
}

export function encodeWebMessageInfo(m: proto.IWebMessageInfo): Buffer {
  return Buffer.from(proto.WebMessageInfo.encode(proto.WebMessageInfo.fromObject(m as never)).finish());
}

/** `GroupHistory { repeated WebMessageInfo messages = 1; ... outOfWindowPinnedMessages = 4 }`. */
export function encodeGroupHistory(messages: proto.IWebMessageInfo[], pinned: proto.IWebMessageInfo[] = []): Buffer {
  return Buffer.concat([
    ...messages.map((m) => lenField(1, encodeWebMessageInfo(m))),
    ...pinned.map((m) => lenField(4, encodeWebMessageInfo(m))),
  ]);
}

/** A list of `HistorySyncMsg { WebMessageInfo message = 1 }` under field 1. */
export function encodeHistorySyncMsgList(messages: proto.IWebMessageInfo[]): Buffer {
  return Buffer.concat(messages.map((m) => lenField(1, lenField(1, encodeWebMessageInfo(m)))));
}

export type Packing = "zlib" | "none" | "gzip" | "raw-deflate";

export function pack(plain: Buffer, packing: Packing): Buffer {
  if (packing === "zlib") return deflateSync(plain);
  if (packing === "gzip") return gzipSync(plain);
  if (packing === "raw-deflate") return deflateRawSync(plain);
  return plain;
}

export interface SyntheticBundle {
  /** What the media server would return for `directPath`. */
  enc: Buffer;
  /** The pointer, as it would sit on `Message.messageHistoryBundle`. */
  bundle: proto.Message.IMessageHistoryBundle;
}

/** Encrypts `payload` under the media scheme with the given HKDF info string. */
export function encryptBundle(
  payload: Buffer,
  opts: { info?: string; mediaKey?: Buffer; messageCount?: number; directPath?: string } = {},
): SyntheticBundle {
  const mediaKey = opts.mediaKey ?? randomBytes(32);
  const { iv, cipherKey, macKey } = deriveMediaKeys(mediaKey, opts.info ?? "Group History");
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  const enc = Buffer.concat([ciphertext, mac]);
  return {
    enc,
    bundle: {
      mimetype: "application/protobuf",
      mediaKey,
      directPath: opts.directPath ?? "/v/t62.0000-0/synthetic.enc?ccb=1",
      fileSha256: createHash("sha256").update(payload).digest(),
      fileEncSha256: createHash("sha256").update(enc).digest(),
      messageHistoryMetadata: { messageCount: opts.messageCount ?? 0, historyReceivers: ["1@lid"] },
    },
  };
}

/** A fetch that serves one body, and remembers what it was asked for. */
export function servingFetch(body: Buffer | null, opts: { status?: number; contentLength?: string } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchBundle = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const headers: Record<string, string> = {};
    if (opts.contentLength) headers["content-length"] = opts.contentLength;
    return new Response(body ? new Uint8Array(body) : null, { status: opts.status ?? 200, headers });
  };
  return { fetchBundle, calls };
}
