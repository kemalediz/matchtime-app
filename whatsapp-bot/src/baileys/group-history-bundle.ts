/**
 * Reads the recent messages WhatsApp shares with a member who has just
 * been added to a group ("Message history: send recent messages to the
 * selected member").
 *
 * ── What arrives ────────────────────────────────────────────────────
 * Measured in production on 2026-10-08: about a second after the join
 * notice, the adder's phone sends the new member a live message whose
 * content is `Message.messageHistoryBundle` (field 70): a media pointer
 * (mimetype application/protobuf, mediaKey, directPath, two hashes) plus
 * `messageHistoryMetadata`. Baileys 7.0.0-rc14 has the protobuf fields and
 * no code that reads them.
 *
 * ── What is established, and what is not ────────────────────────────
 * Nothing here has been run against a real bundle. The format is taken
 * from the one open-source client that implements the SENDING side,
 * oxidezap/whatsapp-rust, which derives it from WhatsApp Web:
 *
 *   wacore/src/download.rs   MediaType::GroupHistory: HKDF info string
 *                            "Group History", media path
 *                            /mms/group-history, the ordinary media
 *                            scheme (112-byte expand to iv, cipher key,
 *                            MAC key; AES-256-CBC; the first 10 bytes of
 *                            HMAC-SHA256 over iv and ciphertext).
 *   src/features/groups.rs   the payload is zlib-compressed
 *                            (`compress_group_history`) and the mimetype
 *                            is application/protobuf, which matches the
 *                            production log line.
 *   waproto/whatsapp.proto   `message GroupHistory { repeated
 *                            WebMessageInfo messages = 1; ...;
 *                            repeated WebMessageInfo
 *                            outOfWindowPinnedMessages = 4; }`. rc14's
 *                            own protobuf has no `GroupHistory`, so the
 *                            top level is walked by hand here and each
 *                            entry handed to `proto.WebMessageInfo`.
 *
 * Because that is a second-hand reading, every step is an ORDERED LIST of
 * candidates that each fail safely, and the report says which one worked:
 *
 *   key      a wrong HKDF info string fails the MAC check;
 *   unpack   a wrong decompressor throws;
 *   decode   a wrong protobuf yields no message with a plausible key.
 *
 * ── What this must never do ─────────────────────────────────────────
 * Throw, read more than the caps, or put text, names, keys, paths, URLs
 * or hashes in the report. The caller decides WHETHER a bundle may be read
 * at all (only for a group the bot was just added to): see
 * `join-history.ts` and the driver.
 */
import { createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, inflate, inflateRaw } from "node:zlib";
import { proto, type WAMessage } from "baileys";
import { mapInboundMessage, toNumber } from "./inbound.js";

/** HKDF info strings, most likely first. A wrong one fails the MAC check. */
export const GROUP_HISTORY_KEY_CANDIDATES: ReadonlyArray<{ info: string }> = [
  { info: "Group History" },
  // The linked-device history sync, Baileys' 'md-msg-hist'.
  { info: "WhatsApp History Keys" },
  // The pointer looks like a document (a mimetype, no dimensions).
  { info: "WhatsApp Document Keys" },
  { info: "WhatsApp App State Keys" },
];

// ── The caps ─────────────────────────────────────────────────────────
// Anyone who can add the bot to a group can send it a bundle, and this
// runs in the process that serves the live club. So the caps bound WORK,
// not just bytes: a 49 KB download can inflate to millions of entries.
// WhatsApp shares about 100 text messages; everything here is sized for
// 600 of them and nothing trusts a number the sender wrote.

/** The same cap the bot-added flow has always applied to captured history. Also the most entries ever decoded. */
export const MAX_BUNDLE_MESSAGES = 600;
export const MAX_BUNDLE_ENC_BYTES = 1024 * 1024;
/** After inflating. Enforced by zlib while it inflates. */
export const MAX_BUNDLE_PLAIN_BYTES = 2 * 1024 * 1024;
/** More top-level entries than this and the payload is refused before anything is decoded. */
export const MAX_BUNDLE_ENTRIES = 5000;
/** A text message is small. A larger entry is counted and skipped undecoded. */
export const MAX_BUNDLE_ENTRY_BYTES = 64 * 1024;
/** Only for the `HistorySync` candidate, which nests its entries. */
export const MAX_BUNDLE_CONVERSATIONS = 16;
/** The decoder is chosen on this many entries, not on the whole payload. */
export const DECODER_SAMPLE = 8;
/** Entries decoded between yields to the event loop. */
export const DECODE_CHUNK = 20;
/** Milliseconds of decoding work before it stops and keeps what it has. */
export const BUNDLE_DECODE_BUDGET_MS = 2000;
/** A pointer that states more than this is refused unread (the stated number is NOT what bounds the work). */
export const MAX_STATED_MESSAGES = 5000;
export const BUNDLE_DOWNLOAD_TIMEOUT_MS = 15_000;

/** `DEF_MEDIA_HOST` and `DEFAULT_ORIGIN` in Baileys (`lib/Utils/messages-media.js`, `lib/Defaults`). */
const MEDIA_HOST = "mmg.whatsapp.net";
const ORIGIN = "https://web.whatsapp.com";
const MAC_BYTES = 10;
const AES_BLOCK = 16;

export interface MediaKeys {
  iv: Buffer;
  cipherKey: Buffer;
  macKey: Buffer;
}

/** The media key expansion: HKDF-SHA256, no salt, 112 bytes (Baileys `getMediaKeys`). */
export function deriveMediaKeys(mediaKey: Uint8Array, info: string): MediaKeys {
  const expanded = Buffer.from(hkdfSync("sha256", mediaKey, Buffer.alloc(0), info, 112));
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
  };
}

type HashCheck = "ok" | "mismatch" | "absent";

export type DecryptResult =
  | { ok: true; plain: Buffer; key: string; keyIndex: number; encSha: HashCheck; plainSha: HashCheck }
  | { ok: false; reason: string };

function bytesOf(v: unknown): Buffer | null {
  if (v instanceof Uint8Array) return v.length ? Buffer.from(v) : null;
  // A media key can arrive base64-encoded after a JSON round trip.
  if (typeof v === "string" && v) return Buffer.from(v.replace("data:;base64,", ""), "base64");
  return null;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify, then decrypt. Unlike Baileys' streaming download, the MAC is
 * CHECKED here, which is what makes a list of candidate keys safe: the
 * wrong info string cannot produce a plaintext.
 */
export function decryptBundle(enc: Buffer, bundle: proto.Message.IMessageHistoryBundle): DecryptResult {
  try {
    const mediaKey = bytesOf(bundle.mediaKey);
    if (!mediaKey) return { ok: false, reason: "the pointer carries no usable media key" };

    let encSha: HashCheck = "absent";
    const wantEnc = bytesOf(bundle.fileEncSha256);
    if (wantEnc) {
      if (!sameBytes(createHash("sha256").update(enc).digest(), wantEnc)) {
        return { ok: false, reason: "the downloaded bytes do not match the hash on the pointer" };
      }
      encSha = "ok";
    }

    const cipherLength = enc.length - MAC_BYTES;
    if (cipherLength < AES_BLOCK || cipherLength % AES_BLOCK !== 0) {
      return { ok: false, reason: `the download is ${enc.length} bytes, which is not a media ciphertext` };
    }
    const ciphertext = enc.subarray(0, cipherLength);
    const mac = enc.subarray(cipherLength);

    for (let i = 0; i < GROUP_HISTORY_KEY_CANDIDATES.length; i++) {
      const { info } = GROUP_HISTORY_KEY_CANDIDATES[i];
      const keys = deriveMediaKeys(mediaKey, info);
      const expected = createHmac("sha256", keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, MAC_BYTES);
      if (!sameBytes(expected, mac)) continue;
      const aes = createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
      const plain = Buffer.concat([aes.update(ciphertext), aes.final()]);
      let plainSha: HashCheck = "absent";
      const wantPlain = bytesOf(bundle.fileSha256);
      if (wantPlain) plainSha = sameBytes(createHash("sha256").update(plain).digest(), wantPlain) ? "ok" : "mismatch";
      return { ok: true, plain, key: info, keyIndex: i, encSha, plainSha };
    }
    return {
      ok: false,
      reason: `no key candidate passed the MAC check (${GROUP_HISTORY_KEY_CANDIDATES.length} tried)`,
    };
  } catch (err) {
    return { ok: false, reason: `decryption failed (${errorKind(err)})` };
  }
}

/** The kind of an error, never its message: a fetch error can carry the URL. */
function errorKind(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown };
    if (typeof e.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.code)) return e.code;
    if (typeof e.name === "string" && /^[A-Za-z]{2,40}$/.test(e.name)) return e.name;
  }
  return "error";
}

// ── The protobuf top level, by hand ──────────────────────────────────

const WIRE_NAMES: Record<number, string> = { 0: "varint", 1: "fixed64", 2: "len", 5: "fixed32" };

/**
 * Visit the top-level fields of a protobuf message WITHOUT building
 * anything: the visitor gets offsets and decides what to keep. Stops when
 * the visitor returns false, so a payload of millions of entries costs as
 * much as the caller is willing to look at and no more.
 *
 * Returns where it stopped being a protobuf message (null if it never did)
 * and whether the visitor cut it short.
 */
function visitTopLevel(
  buf: Buffer,
  visit: (no: number, wire: number, start: number, end: number) => boolean,
): { stoppedAt: number | null; cut: boolean } {
  let pos = 0;
  const readVarint = (): number | null => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) return null;
      const b = buf[pos++];
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
    return null;
  };
  while (pos < buf.length) {
    const at = pos;
    const tag = readVarint();
    if (tag === null) return { stoppedAt: at, cut: false };
    const no = Math.floor(tag / 8);
    const wire = tag % 8;
    if (no < 1) return { stoppedAt: at, cut: false };
    let start = pos;
    let end = pos;
    if (wire === 0) {
      if (readVarint() === null) return { stoppedAt: at, cut: false };
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (pos + size > buf.length) return { stoppedAt: at, cut: false };
      pos += size;
    } else if (wire === 2) {
      const length = readVarint();
      if (length === null || pos + length > buf.length) return { stoppedAt: at, cut: false };
      start = pos;
      end = pos + length;
      pos = end;
    } else {
      return { stoppedAt: at, cut: false };
    }
    if (!visit(no, wire, start, end)) return { stoppedAt: null, cut: true };
  }
  return { stoppedAt: null, cut: false };
}

/** How many top-level fields a shape description will count before it stops. */
const MAX_SHAPE_FIELDS = 20_000;

/**
 * Field numbers and wire types of the top level, with counts. NO values:
 * this is what gets logged when a real bundle cannot be decoded, so the
 * format can be worked out from the log without anybody's messages in it.
 * Bounded: it stops counting after `MAX_SHAPE_FIELDS` fields.
 */
export function describeProtoShape(buf: Buffer): string {
  if (buf.length === 0) return "empty";
  const counts = new Map<string, number>();
  let seen = 0;
  const { stoppedAt, cut } = visitTopLevel(buf, (no, wire) => {
    const k = `${no}:${WIRE_NAMES[wire] ?? `wire${wire}`}`;
    if (counts.size < 24 || counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return ++seen < MAX_SHAPE_FIELDS;
  });
  const listed =
    [...counts.entries()].map(([k, n]) => `${k} x${n}`).join(", ") +
    (cut ? ` (stopped counting after ${MAX_SHAPE_FIELDS} fields)` : "");
  if (stoppedAt === null) return listed;
  return `not a protobuf message (stops at byte ${stoppedAt} of ${buf.length}${listed ? `; before that: ${listed}` : ""})`;
}

// ── Unpack and decode ────────────────────────────────────────────────

const inflateAsync = promisify(inflate);
const gunzipAsync = promisify(gunzip);
const inflateRawAsync = promisify(inflateRaw);

// `maxOutputLength` is enforced by zlib WHILE it inflates: it stops and
// throws ERR_BUFFER_TOO_LARGE at the cap, it does not inflate and then look.
const UNPACKERS: ReadonlyArray<{ name: string; inflated: boolean; run(buf: Buffer, max: number): Promise<Buffer> }> = [
  { name: "zlib inflate", inflated: true, run: (b, max) => inflateAsync(b, { maxOutputLength: max }) },
  { name: "not compressed", inflated: false, run: async (b) => b },
  { name: "gzip", inflated: true, run: (b, max) => gunzipAsync(b, { maxOutputLength: max }) },
  { name: "raw deflate", inflated: true, run: (b, max) => inflateRawAsync(b, { maxOutputLength: max }) },
];

/**
 * The entries of a payload: views into it, never copies, and never more
 * than `ceiling` of them. `over` means there were more, and the caller
 * refuses the payload without decoding anything.
 */
interface EntryScan {
  entries: Buffer[];
  over: boolean;
}

function scanFields(buf: Buffer, numbers: number[], ceiling: number, into: Buffer[] = []): EntryScan {
  let over = false;
  const { stoppedAt } = visitTopLevel(buf, (no, wire, start, end) => {
    if (wire !== 2 || !numbers.includes(no)) return true;
    if (into.length >= ceiling) {
      over = true;
      return false;
    }
    into.push(buf.subarray(start, end));
    return true;
  });
  // A payload that is not a protobuf message has no entries of this shape.
  if (stoppedAt !== null && !over) return { entries: [], over: false };
  return { entries: into, over };
}

/**
 * Protobuf shapes the payload might be, most likely first. Each says where
 * its entries are and how ONE entry decodes; nothing here decodes a whole
 * payload.
 */
const DECODERS: ReadonlyArray<{
  name: string;
  scan(buf: Buffer, ceiling: number): EntryScan;
  decode(entry: Buffer): proto.IWebMessageInfo | null | undefined;
}> = [
  {
    // messages = 1 and outOfWindowPinnedMessages = 4. An entry of
    // `GroupHistoryWithMessageBytes` (key = 1, messageBytes = 2) has the
    // same wire layout as a WebMessageInfo and decodes here too.
    name: "GroupHistory",
    scan: (buf, ceiling) => scanFields(buf, [1, 4], ceiling),
    decode: (b) => proto.WebMessageInfo.decode(b),
  },
  {
    // HistorySync { conversations = 2 { messages = 2 (HistorySyncMsg) } }
    name: "HistorySync",
    scan(buf, ceiling) {
      const conversations = scanFields(buf, [2], MAX_BUNDLE_CONVERSATIONS);
      if (conversations.over) return { entries: [], over: true };
      const all: Buffer[] = [];
      for (const c of conversations.entries) {
        if (scanFields(c, [2], ceiling, all).over) return { entries: [], over: true };
      }
      return { entries: all, over: false };
    },
    decode: (b) => proto.HistorySyncMsg.decode(b).message,
  },
  {
    name: "HistorySyncMsg list",
    scan: (buf, ceiling) => scanFields(buf, [1], ceiling),
    decode: (b) => proto.HistorySyncMsg.decode(b).message,
  },
];

const PLAUSIBLE_ID = /^[0-9A-Za-z._:-]{8,64}$/;
const PLAUSIBLE_JID = /^[0-9A-Za-z._:-]{1,64}@[a-z.]{2,32}$/;

/** A decoded entry is a message only if its key looks like one. This is what rejects a wrong protobuf. */
function plausible(m: proto.IWebMessageInfo | null | undefined): m is proto.IWebMessageInfo {
  const key = m?.key;
  if (!key || typeof key.id !== "string" || !PLAUSIBLE_ID.test(key.id)) return false;
  if (key.remoteJid && !PLAUSIBLE_JID.test(key.remoteJid)) return false;
  if (key.participant && !PLAUSIBLE_JID.test(key.participant)) return false;
  return true;
}

function decodeOne(
  decode: (entry: Buffer) => proto.IWebMessageInfo | null | undefined,
  entry: Buffer,
): proto.IWebMessageInfo | null {
  try {
    const m = decode(entry);
    return plausible(m) ? m : null;
  } catch {
    return null;
  }
}

/** One message out of a bundle: text and who wrote it, not yet resolved to a person. */
export interface BundleRow {
  id: string;
  /** `key.participant` (or the message's `participant`), as the bundle spelled it. */
  senderJid: string | null;
  /**
   * `key.fromMe` with no participant: the bundle is the SHARER's stored
   * history, so "from me" means from whoever sent the bundle, not from us.
   */
  fromBundleSender: boolean;
  pushName: string | null;
  text: string;
  /** Unix seconds; 0 when the message carried none. */
  timestampSec: number;
}

export type UnpackResult =
  | {
      ok: true;
      unpack: string;
      inflated: boolean;
      unpackedBytes: number;
      decoder: string;
      /** Entries in the payload (at most the ceiling, or it is refused). */
      entries: number;
      /** Entries actually decoded: at most the message limit. */
      read: number;
      /** Entries skipped undecoded because they were over the per-entry size. */
      tooLarge: number;
      valid: number;
      otherChat: number;
      withText: number;
      authors: number;
      /** True when the time budget ran out and the rest was left undecoded. */
      partial: boolean;
      rows: BundleRow[];
    }
  | { ok: false; reason: string; shapes: string[] };

export interface UnpackOptions {
  /** Messages kept, and the most entries ever decoded. */
  limit?: number;
  maxPlainBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  /** Milliseconds of decoding before it stops and keeps what it has. */
  budgetMs?: number;
  /** Injected for tests. */
  nowMs?(): number;
  yieldToLoop?(): Promise<void>;
}

/** The live path's mapper turns one decoded message into a row, or nothing. */
function toRow(m: proto.IWebMessageInfo, group: string): BundleRow | "other-chat" | null {
  const key = m.key ?? {};
  if (key.remoteJid && key.remoteJid !== group) return "other-chat";
  // Unwraps, takes text or a caption, and returns null for system
  // notices, reactions, polls and the rest.
  const mapped = mapInboundMessage({ ...m, key: { ...key, remoteJid: group } } as WAMessage);
  if (!mapped || !mapped.body) return null;
  const senderJid = key.participant || m.participant || null;
  return {
    id: key.id as string,
    senderJid,
    fromBundleSender: !senderJid && key.fromMe === true,
    pushName: mapped.pushName,
    text: mapped.body,
    timestampSec: toNumber(m.messageTimestamp),
  };
}

/**
 * The decrypted payload as rows. Never throws, and bounded at every step:
 *
 *  - inflating stops at `maxPlainBytes`;
 *  - the top level is walked without building anything, and a payload with
 *    more than `maxEntries` entries is refused before any entry is decoded;
 *  - the decoder is chosen on the first `DECODER_SAMPLE` entries, not by
 *    running every candidate over everything;
 *  - at most `limit` entries are ever decoded: the LAST ones by position,
 *    newest first (a sharing client writes oldest first), so running out of
 *    time keeps the most recent messages;
 *  - an entry over `maxEntryBytes` is counted and skipped undecoded;
 *  - decoding is done a few entries at a time with a yield to the event
 *    loop between, and stops after `budgetMs` of work.
 */
export async function unpackBundle(plain: Buffer, group: string, opts: UnpackOptions = {}): Promise<UnpackResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_BUNDLE_MESSAGES, MAX_BUNDLE_MESSAGES));
  const maxPlain = opts.maxPlainBytes ?? MAX_BUNDLE_PLAIN_BYTES;
  const maxEntries = opts.maxEntries ?? MAX_BUNDLE_ENTRIES;
  const maxEntryBytes = opts.maxEntryBytes ?? MAX_BUNDLE_ENTRY_BYTES;
  const budgetMs = opts.budgetMs ?? BUNDLE_DECODE_BUDGET_MS;
  const nowMs = opts.nowMs ?? (() => performance.now());
  const yieldToLoop = opts.yieldToLoop ?? (() => new Promise<void>((r) => setImmediate(r)));
  const shapes: string[] = [];
  try {
    for (const unpacker of UNPACKERS) {
      let data: Buffer;
      try {
        data = await unpacker.run(plain, maxPlain);
      } catch (err) {
        if ((err as { code?: unknown })?.code === "ERR_BUFFER_TOO_LARGE") {
          return {
            ok: false,
            reason: `the payload inflates (${unpacker.name}) past the ${maxPlain} bytes this will read; nothing was decoded`,
            shapes,
          };
        }
        continue;
      }
      if (data.length > maxPlain) {
        return {
          ok: false,
          reason: `the payload is ${data.length} bytes, past the ${maxPlain} this will read; nothing was decoded`,
          shapes,
        };
      }
      for (const decoder of DECODERS) {
        const scan = decoder.scan(data, maxEntries);
        if (scan.over) {
          return {
            ok: false,
            reason: `the payload has more than ${maxEntries} entries (read as ${decoder.name}); nothing was decoded`,
            shapes,
          };
        }
        const sample = scan.entries.filter((e) => e.length <= maxEntryBytes).slice(0, DECODER_SAMPLE);
        if (!sample.some((e) => decodeOne(decoder.decode, e))) continue;

        // This is the shape. Decode the last `limit` entries, newest first.
        const chosen = scan.entries.slice(Math.max(0, scan.entries.length - limit));
        const seen = new Set<string>();
        const rows: BundleRow[] = [];
        let read = 0;
        let tooLarge = 0;
        let valid = 0;
        let otherChat = 0;
        let partial = false;
        let spent = 0;
        for (let i = chosen.length - 1; i >= 0; ) {
          const started = nowMs();
          for (let n = 0; n < DECODE_CHUNK && i >= 0; n++, i--) {
            const entry = chosen[i];
            if (entry.length > maxEntryBytes) {
              tooLarge++;
              continue;
            }
            read++;
            const m = decodeOne(decoder.decode, entry);
            if (!m) continue;
            valid++;
            const row = toRow(m, group);
            if (row === "other-chat") otherChat++;
            else if (row && !seen.has(row.id)) {
              seen.add(row.id);
              rows.push(row);
            }
          }
          spent += nowMs() - started;
          if (i < 0) break;
          if (spent >= budgetMs) {
            partial = true;
            break;
          }
          await yieldToLoop();
        }
        // Oldest first. Decoded newest first, so put the bundle's own
        // order back before the (stable) sort by timestamp.
        rows.reverse();
        rows.sort((a, b) => a.timestampSec - b.timestampSec);
        return {
          ok: true,
          unpack: unpacker.name,
          inflated: unpacker.inflated,
          unpackedBytes: data.length,
          decoder: decoder.name,
          entries: scan.entries.length,
          read,
          tooLarge,
          valid,
          otherChat,
          withText: rows.length,
          authors: new Set(rows.map((r) => r.senderJid ?? (r.fromBundleSender ? "(sharer)" : "(unknown)"))).size,
          partial,
          rows,
        };
      }
      shapes.push(`${unpacker.name} (${data.length} bytes): ${describeProtoShape(data)}`);
    }
  } catch (err) {
    return { ok: false, reason: `the payload could not be unpacked (${errorKind(err)})`, shapes };
  }
  return { ok: false, reason: "no protobuf candidate found a message in the payload", shapes };
}

// ── Download ─────────────────────────────────────────────────────────

export interface BundleFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  body?: unknown;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type BundleFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<BundleFetchResponse>;

export interface BundleReadDeps {
  fetchBundle?: BundleFetch;
  timeoutMs?: number;
  maxEncBytes?: number;
  maxPlainBytes?: number;
  limit?: number;
  /** Passed to `unpackBundle`: its bounds, and its clock and yield for tests. */
  unpack?: UnpackOptions;
}

type Stage = "pointer" | "download" | "decrypt" | "decode" | "done";

/** Everything the log line needs. Counts, names of candidates and sizes only. */
export interface BundleReport {
  stage: Stage;
  failure?: string;
  statedMessages: number | null;
  httpStatus?: number;
  encBytes?: number;
  key?: string;
  keyIndex?: number;
  encSha?: HashCheck;
  plainSha?: HashCheck;
  plainBytes?: number;
  unpack?: string;
  inflated?: boolean;
  unpackedBytes?: number;
  decoder?: string;
  entries?: number;
  read?: number;
  tooLarge?: number;
  valid?: number;
  otherChat?: number;
  withText?: number;
  authors?: number;
  kept?: number;
  partial?: boolean;
  shapes?: string[];
}

export type BundleReadResult =
  | { ok: true; rows: BundleRow[]; report: BundleReport }
  | { ok: false; reason: string; report: BundleReport };

async function readCapped(res: BundleFetchResponse, max: number): Promise<Buffer | "too-large"> {
  const body = res.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (typeof res.arrayBuffer === "function") {
    const all = Buffer.from(await res.arrayBuffer());
    return all.length > max ? "too-large" : all;
  }
  return Buffer.alloc(0);
}

/**
 * Download, verify, decrypt, unpack, decode. Resolves to rows or to a
 * reason; NEVER throws and never reads past the caps.
 */
export async function readGroupHistoryBundle(
  bundle: proto.Message.IMessageHistoryBundle | null | undefined,
  group: string,
  deps: BundleReadDeps = {},
): Promise<BundleReadResult> {
  const stated = bundle?.messageHistoryMetadata?.messageCount;
  const report: BundleReport = {
    stage: "pointer",
    statedMessages: stated === null || stated === undefined ? null : toNumber(stated),
  };
  const fail = (reason: string): BundleReadResult => {
    report.failure = reason;
    return { ok: false, reason, report };
  };
  try {
    const maxEnc = deps.maxEncBytes ?? MAX_BUNDLE_ENC_BYTES;
    const timeoutMs = deps.timeoutMs ?? BUNDLE_DOWNLOAD_TIMEOUT_MS;
    if (!bundle) return fail("there is no pointer");
    if (!bytesOf(bundle.mediaKey)) return fail("the pointer carries no usable media key");
    // A path, on WhatsApp's media host, and nothing that can name another.
    const path = bundle.directPath;
    if (typeof path !== "string" || !/^\/[^/\\\s][^\\\s]*$/.test(path)) {
      return fail("the pointer has no usable direct path");
    }
    if (report.statedMessages !== null && report.statedMessages > MAX_STATED_MESSAGES) {
      return fail(
        `the pointer states ${report.statedMessages} messages, over the ${MAX_STATED_MESSAGES} this will read`,
      );
    }

    report.stage = "download";
    const fetchBundle = deps.fetchBundle ?? (globalThis.fetch as unknown as BundleFetch);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let enc: Buffer | "too-large";
    try {
      const res = await fetchBundle(`https://${MEDIA_HOST}${path}`, {
        headers: { Origin: ORIGIN },
        signal: controller.signal,
      });
      report.httpStatus = res.status;
      if (!res.ok) return fail(`the media server answered http ${res.status}`);
      const statedLength = Number(res.headers?.get("content-length") ?? NaN);
      if (Number.isFinite(statedLength) && statedLength > maxEnc) {
        controller.abort();
        return fail(`the server states ${statedLength} bytes, over the ${maxEnc} this will download`);
      }
      enc = await readCapped(res, maxEnc);
    } catch (err) {
      if (timedOut) return fail(`the download did not finish within ${timeoutMs}ms`);
      return fail(`the download failed (${errorKind(err)})`);
    } finally {
      clearTimeout(timer);
    }
    if (enc === "too-large") {
      controller.abort();
      return fail(`the download passed ${maxEnc} bytes and was abandoned`);
    }
    report.encBytes = enc.length;

    report.stage = "decrypt";
    const decrypted = decryptBundle(enc, bundle);
    if (!decrypted.ok) return fail(decrypted.reason);
    report.key = decrypted.key;
    report.keyIndex = decrypted.keyIndex;
    report.encSha = decrypted.encSha;
    report.plainSha = decrypted.plainSha;
    report.plainBytes = decrypted.plain.length;

    report.stage = "decode";
    const unpacked = await unpackBundle(decrypted.plain, group, {
      ...deps.unpack,
      limit: deps.limit ?? deps.unpack?.limit,
      maxPlainBytes: deps.maxPlainBytes ?? deps.unpack?.maxPlainBytes,
    });
    if (!unpacked.ok) {
      report.shapes = unpacked.shapes;
      return fail(unpacked.reason);
    }
    report.stage = "done";
    report.unpack = unpacked.unpack;
    report.inflated = unpacked.inflated;
    report.unpackedBytes = unpacked.unpackedBytes;
    report.decoder = unpacked.decoder;
    report.entries = unpacked.entries;
    report.read = unpacked.read;
    report.tooLarge = unpacked.tooLarge;
    report.partial = unpacked.partial;
    report.valid = unpacked.valid;
    report.otherChat = unpacked.otherChat;
    report.withText = unpacked.withText;
    report.authors = unpacked.authors;
    report.kept = unpacked.rows.length;
    return { ok: true, rows: unpacked.rows, report };
  } catch (err) {
    return fail(`unexpected failure (${errorKind(err)})`);
  }
}

/**
 * The report as log lines, WITHOUT a prefix (the driver adds the group and
 * message id). The first line always says how far it got; a decode failure
 * adds one line per plaintext shape. Never throws.
 */
export function formatBundleReport(report: BundleReport): string[] {
  try {
    const parts: string[] = [];
    if (report.encBytes !== undefined) {
      parts.push(`downloaded ${report.encBytes} bytes (http ${report.httpStatus ?? "?"})`);
    }
    if (report.key !== undefined) {
      parts.push(
        `decrypted with "${report.key}" (candidate ${(report.keyIndex ?? 0) + 1} of ` +
          `${GROUP_HISTORY_KEY_CANDIDATES.length}, download hash ${report.encSha}, content hash ${report.plainSha}) ` +
          `to ${report.plainBytes} bytes`,
      );
    }
    if (report.stage === "done") {
      parts.push(
        `unpacked as ${report.unpack} (inflate needed: ${report.inflated ? "yes" : "no"}) to ${report.unpackedBytes} bytes`,
      );
      parts.push(
        `decoded as ${report.decoder}: entries=${report.entries} read=${report.read} tooLarge=${report.tooLarge} ` +
          `valid=${report.valid} otherChat=${report.otherChat} withText=${report.withText} ` +
          `authors=${report.authors} kept=${report.kept} (stated messageCount=${report.statedMessages ?? "?"})` +
          (report.partial ? "; STOPPED EARLY: the decode time budget ran out, the oldest entries were left unread" : ""),
      );
      return [parts.join("; ")];
    }
    const head = `FAILED at ${report.stage}: ${report.failure ?? "unknown"} (stated messageCount=${report.statedMessages ?? "?"})`;
    const lines = [parts.length ? `${head}; before that: ${parts.join("; ")}` : head];
    for (const shape of report.shapes ?? []) lines.push(`  plaintext shape, ${shape}`);
    return lines;
  } catch {
    return ["the bundle report could not be written"];
  }
}
