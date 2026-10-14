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
import { normalizeMessageContent, proto, type WAMessage } from "baileys";
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
/**
 * One message's text, in characters. The server's reader cuts a message to
 * 400 for the model (`MAX_MESSAGE_CHARS`, src/lib/setup-learning/rules.ts),
 * so nothing is lost that would have been read, and a bundle of 64 KB
 * messages cannot push megabytes of text to the server.
 */
export const MAX_BUNDLE_TEXT_CHARS = 1000;
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
  /** At most `MAX_BUNDLE_TEXT_CHARS` characters. */
  text: string;
  /** The text was longer and was cut. */
  truncated: boolean;
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
      /** Rows whose text is an edit's (the message had been edited before it was shared). */
      edited: number;
      /** Entries that decoded, belong to this chat, and yielded no text. */
      noText: number;
      /** What those were, by field name: most frequent first, at most `MAX_NO_TEXT_SHAPES` and an "other". */
      noTextShapes: NoTextShape[];
      /** Messages whose text was cut to `MAX_BUNDLE_TEXT_CHARS`. */
      textCut: number;
      authors: number;
      /** True when the time budget ran out and the rest was left undecoded. */
      partial: boolean;
      /** Pictures among the decoded entries (Phase 0 of picture reading). */
      imageCounts: BundleImageCounts;
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

/** At most `max` UTF-16 units, never ending on half of a surrogate pair. */
function capText(text: string, max = MAX_BUNDLE_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end).trimEnd(), truncated: true };
}

// ── Edited messages ──────────────────────────────────────────────────
// Measured in production on 2026-10-11: a bundle of 26 entries held three
// messages that had been edited in WhatsApp, and none of the three came
// out as a row, in either wording. WHAT SHAPE an edit has inside a bundle
// entry is NOT known: the log carries no content and nobody has seen one.
// So this reads every shape the Baileys proto allows for (WAProto.proto):
//
//   Message.editedMessage = 58            a FutureProofMessage around the
//                                         current content. Baileys'
//                                         `normalizeMessageContent` already
//                                         peels this one.
//   Message.protocolMessage = 12          with ProtocolMessage.editedMessage
//                                         = 14 (a whole Message: the new
//                                         content), type MESSAGE_EDIT = 14,
//                                         and `key` naming the message that
//                                         was edited. On its own, or inside
//                                         the wrapper above. The live mapper
//                                         drops every protocol message, which
//                                         is right for a live edit and is
//                                         what would lose these here.
//
// This is done HERE and not in `mapInboundMessage`: what the live bot does
// with an edit that arrives on the socket must not change.

/** The wrappers a message can sit in: Baileys' own list (`normalizeMessageContent`) and the device-sent one. */
const WRAPPER_FIELDS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "documentWithCaptionMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "editedMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
  "deviceSentMessage",
] as const;
/** How many edit protocol messages are followed inwards before giving up. */
const MAX_EDIT_DEPTH = 3;

type Bag = Record<string, unknown>;

function asBag(v: unknown): Bag | null {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) ? (v as Bag) : null;
}

/** The message inside the first wrapper this one has, with the wrapper's name. */
function innerOf(message: Bag): { name: string; message: Bag } | null {
  for (const name of WRAPPER_FIELDS) {
    const inner = asBag(asBag(message[name])?.message);
    if (inner) return { name, message: inner };
  }
  return null;
}

function insideEditWrapper(message: Bag | null): boolean {
  let at = message;
  for (let i = 0; i < 5 && at; i++) {
    const inner = innerOf(at);
    if (!inner) return false;
    if (inner.name === "editedMessage") return true;
    at = inner.message;
  }
  return false;
}

/**
 * What a bundle entry says NOW: its content with any edit followed to the
 * new content, the id of the message that edit names, and how recent the
 * edit is (milliseconds, for choosing between two edits of one message).
 */
function currentContent(m: proto.IWebMessageInfo): {
  message: proto.IMessage | null | undefined;
  edited: boolean;
  target: string | null;
  rank: number;
} {
  let message = m.message;
  let edited = false;
  let target: string | null = null;
  let rank = 0;
  for (let depth = 0; depth < MAX_EDIT_DEPTH; depth++) {
    if (insideEditWrapper(asBag(message))) edited = true;
    const protocol = normalizeMessageContent(message ?? undefined)?.protocolMessage;
    const next = protocol?.editedMessage;
    if (!protocol || !next) break;
    edited = true;
    const named = protocol.key?.id;
    if (!target && typeof named === "string" && PLAUSIBLE_ID.test(named)) target = named;
    if (!rank) rank = toNumber(protocol.timestampMs);
    message = next;
  }
  if (edited && !rank) rank = toNumber(m.messageTimestamp) * 1000;
  return { message, edited, target, rank };
}

// ── What an entry with no text was ───────────────────────────────────
// So that the next real bundle says what it held if the reading above is
// wrong. FIELD NAMES, COUNTS AND ENUM NUMBERS ONLY: never a value. The
// names come from the protobuf schema (a decoded message has no other
// keys), and are checked against a pattern anyway before they are kept.

/** Distinct shapes listed for one bundle; the rest are counted as "other". */
export const MAX_NO_TEXT_SHAPES = 8;
/** One shape description, in characters. */
export const MAX_NO_TEXT_SHAPE_CHARS = 80;
/** The whole `noText=…` part of the log line, in characters. */
export const MAX_NO_TEXT_SUMMARY_CHARS = 400;
const SHAPE_DEPTH = 4;
const SHAPE_NAMES_PER_LEVEL = 4;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,47}$/;
/** On almost every message, and says nothing about what the message is. */
const NOT_CONTENT = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);
/** WebMessageInfo fields every entry has, left out when one with no message is described. */
const ENTRY_ENVELOPE = new Set([
  "key",
  "message",
  "messageTimestamp",
  "messageC2STimestamp",
  "status",
  "participant",
  "pushName",
  "messageStubType",
  "messageStubParameters",
]);

/** The names of the fields that are set (an empty repeated field is not). */
function setFields(bag: Bag, skip: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const name of Object.keys(bag)) {
    const v = bag[name];
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    if (skip.has(name) || !FIELD_NAME.test(name)) continue;
    names.push(name);
  }
  return names.sort();
}

function listNames(names: string[], label: (name: string) => string = (n) => n): string {
  const shown = names.slice(0, SHAPE_NAMES_PER_LEVEL).map(label).join("+");
  return names.length > SHAPE_NAMES_PER_LEVEL ? `${shown}+${names.length - SHAPE_NAMES_PER_LEVEL}more` : shown;
}

/** An enum's number, or `?`. */
function enumNumber(v: unknown): string {
  if (v === null || v === undefined) return "?";
  const n = toNumber(v);
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? String(n) : "?";
}

function describeContent(message: Bag, depth: number): string {
  const names = setFields(message, NOT_CONTENT);
  if (!names.length) return "empty";
  const here = listNames(names, (name) => {
    if (name === "protocolMessage") return `${name}:${enumNumber(asBag(message[name])?.type)}`;
    if (name === "secretEncryptedMessage") return `${name}:${enumNumber(asBag(message[name])?.secretEncType)}`;
    return name;
  });
  if (depth >= SHAPE_DEPTH) return here;
  // One level down: into a wrapper, or into what an edit carries.
  const inner = innerOf(message)?.message ?? asBag(asBag(message.protocolMessage)?.editedMessage);
  return inner ? `${here}>${describeContent(inner, depth + 1)}` : here;
}

/** The shape of an entry that yielded no text. Never a value, never throws. */
function describeNoText(m: proto.IWebMessageInfo): string {
  try {
    const message = asBag(m.message);
    let shape: string;
    if (message && setFields(message, NOT_CONTENT).length) {
      shape = describeContent(message, 1);
    } else if (m.messageStubType !== null && m.messageStubType !== undefined && toNumber(m.messageStubType) > 0) {
      shape = `stub:${enumNumber(m.messageStubType)}`;
    } else {
      const others = setFields(m as Bag, ENTRY_ENVELOPE);
      shape = others.length ? `noMessage[${listNames(others)}]` : "noMessage";
    }
    return shape.replace(/[^A-Za-z0-9:+>\[\]?]/g, "").slice(0, MAX_NO_TEXT_SHAPE_CHARS) || "unreadable";
  } catch {
    return "unreadable";
  }
}

export interface NoTextShape {
  shape: string;
  count: number;
}

// ── Pictures in a bundle (picture reading, Phase 0, 2026-10-14) ──────
// Whether WhatsApp's shared history carries pictures at all is NOT known.
// An entry is a whole WebMessageInfo, so it CAN hold an imageMessage with
// everything a download needs (url or directPath, and mediaKey); the one
// open-source sender (whatsapp-rust, which mirrors WhatsApp Web) shares
// plain `conversation` text only. These counts settle it from the next
// real bundle: how many entries were pictures, how many carried a
// downloadable pointer, how many had a caption (which is already kept as
// that row's text). COUNTS ONLY: never a URL, path, key or hash.

export interface BundleImageCounts {
  images: number;
  /** With a url or directPath AND a mediaKey: enough to download. */
  withPointer: number;
  captioned: number;
}

function imageFacts(m: proto.IWebMessageInfo): { pointer: boolean; captioned: boolean } | null {
  try {
    const content = normalizeMessageContent(currentContent(m).message ?? undefined);
    const image = content?.imageMessage;
    if (!image) return null;
    const hasKey = image.mediaKey instanceof Uint8Array ? image.mediaKey.length > 0 : !!image.mediaKey;
    return {
      pointer: hasKey && (!!image.url || !!image.directPath),
      captioned: typeof image.caption === "string" && image.caption.trim().length > 0,
    };
  } catch {
    return null;
  }
}

type RowOutcome =
  | { kind: "row"; row: BundleRow; edited: boolean; rank: number }
  | { kind: "other-chat" }
  | { kind: "no-text"; shape: string };

/**
 * One decoded entry as a row. The LIVE path's mapper does the reading
 * (unwraps, takes text or a caption, and returns null for system notices,
 * reactions, polls and the rest); the only thing added here is that an
 * edit is followed to its new content first. Never throws.
 */
function toRow(m: proto.IWebMessageInfo, group: string): RowOutcome {
  try {
    const key = m.key ?? {};
    if (key.remoteJid && key.remoteJid !== group) return { kind: "other-chat" };
    const current = currentContent(m);
    const mapped = mapInboundMessage({
      ...m,
      key: { ...key, remoteJid: group },
      message: current.message,
    } as WAMessage);
    if (!mapped || !mapped.body) return { kind: "no-text", shape: describeNoText(m) };
    const senderJid = key.participant || m.participant || null;
    const cut = capText(mapped.body);
    return {
      kind: "row",
      edited: current.edited,
      rank: current.rank,
      row: {
        // An edit sent as its own entry names the message it edits.
        id: current.target ?? (key.id as string),
        senderJid,
        fromBundleSender: !senderJid && key.fromMe === true,
        pushName: mapped.pushName ? capText(mapped.pushName, 100).text : null,
        text: cut.text,
        truncated: cut.truncated,
        timestampSec: toNumber(m.messageTimestamp),
      },
    };
  } catch {
    return { kind: "no-text", shape: "unreadable" };
  }
}

/** One message as the bundle holds it: as first sent, as edited, or both. */
interface Held {
  original: BundleRow | null;
  edit: BundleRow | null;
  rank: number;
}

/** The edit's words, in the original's place and under its author when the bundle has the original too. */
function settle(h: Held): BundleRow {
  if (!h.edit) return h.original as BundleRow;
  if (!h.original) return h.edit;
  return {
    ...h.original,
    pushName: h.original.pushName ?? h.edit.pushName,
    text: h.edit.text,
    truncated: h.edit.truncated,
    timestampSec: h.original.timestampSec || h.edit.timestampSec,
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
        // At most one per decoded entry, so never more than `limit`.
        const held = new Map<string, Held>();
        const tally = new Map<string, number>();
        let noText = 0;
        let noTextOther = 0;
        let read = 0;
        let tooLarge = 0;
        let valid = 0;
        let otherChat = 0;
        let partial = false;
        let spent = 0;
        const imageCounts: BundleImageCounts = { images: 0, withPointer: 0, captioned: 0 };
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
            const pic = imageFacts(m);
            if (pic) {
              imageCounts.images++;
              if (pic.pointer) imageCounts.withPointer++;
              if (pic.captioned) imageCounts.captioned++;
            }
            const got = toRow(m, group);
            if (got.kind === "other-chat") otherChat++;
            else if (got.kind === "no-text") {
              noText++;
              if (tally.has(got.shape) || tally.size < MAX_NO_TEXT_SHAPES) {
                tally.set(got.shape, (tally.get(got.shape) ?? 0) + 1);
              } else noTextOther++;
            } else {
              // Decoded newest first, so the first one seen of a kind is
              // kept: a repeated message as before, and of two edits the
              // later one (by its own time, then by position).
              const h = held.get(got.row.id);
              if (!h) {
                held.set(
                  got.row.id,
                  got.edited ? { original: null, edit: got.row, rank: got.rank } : { original: got.row, edit: null, rank: 0 },
                );
              } else if (!got.edited) {
                if (!h.original) h.original = got.row;
              } else if (!h.edit || got.rank > h.rank) {
                h.edit = got.row;
                h.rank = got.rank;
              }
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
        const rows: BundleRow[] = [];
        let edited = 0;
        for (const h of held.values()) {
          if (h.edit) edited++;
          rows.push(settle(h));
        }
        rows.reverse();
        rows.sort((a, b) => a.timestampSec - b.timestampSec);
        const noTextShapes: NoTextShape[] = [...tally.entries()]
          .map(([shape, count]) => ({ shape, count }))
          .sort((a, b) => b.count - a.count);
        if (noTextOther) noTextShapes.push({ shape: "other", count: noTextOther });
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
          edited,
          noText,
          noTextShapes,
          textCut: rows.filter((r) => r.truncated).length,
          authors: new Set(rows.map((r) => r.senderJid ?? (r.fromBundleSender ? "(sharer)" : "(unknown)"))).size,
          partial,
          imageCounts,
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
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" },
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
  edited?: number;
  noText?: number;
  noTextShapes?: NoTextShape[];
  textCut?: number;
  authors?: number;
  kept?: number;
  partial?: boolean;
  imageCounts?: BundleImageCounts;
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
        // Not awaited: a cancel that never settles must not hold the read.
        void reader.cancel().catch(() => {});
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
        // The host is pinned and a redirect is never expected: following
        // one would let the answer come from somewhere else.
        redirect: "error",
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
    report.imageCounts = unpacked.imageCounts;
    report.valid = unpacked.valid;
    report.otherChat = unpacked.otherChat;
    report.withText = unpacked.withText;
    report.edited = unpacked.edited;
    report.noText = unpacked.noText;
    report.noTextShapes = unpacked.noTextShapes;
    report.textCut = unpacked.textCut;
    report.authors = unpacked.authors;
    report.kept = unpacked.rows.length;
    return { ok: true, rows: unpacked.rows, report };
  } catch (err) {
    return fail(`unexpected failure (${errorKind(err)})`);
  }
}

/**
 * `noText=4 (2 x editedMessage>protocolMessage:14>stickerMessage, 1 x stub:20, 1 x imageMessage)`:
 * how many entries yielded no text and what they were, by field name. At
 * most `MAX_NO_TEXT_SUMMARY_CHARS` long; shapes that do not fit become `...`.
 */
function noTextSummary(noText: number, shapes: NoTextShape[] | null | undefined): string {
  const head = `noText=${noText}`;
  if (!Array.isArray(shapes) || !shapes.length) return head;
  const SAFE = /^[A-Za-z0-9:+>\[\]?]{1,80}$/;
  let listed = "";
  for (const s of shapes) {
    const shape = typeof s?.shape === "string" && SAFE.test(s.shape) ? s.shape : "unreadable";
    const item = `${listed ? ", " : ""}${toNumber(s?.count)} x ${shape}`;
    // Room is kept for the `, ...)` that says the list was cut.
    if (head.length + 2 + listed.length + item.length + 6 > MAX_NO_TEXT_SUMMARY_CHARS) {
      listed += listed ? ", ..." : "...";
      break;
    }
    listed += item;
  }
  return `${head} (${listed})`;
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
          `valid=${report.valid} otherChat=${report.otherChat} withText=${report.withText} textCut=${report.textCut} ` +
          `authors=${report.authors} kept=${report.kept} (stated messageCount=${report.statedMessages ?? "?"})` +
          // Both are left off when zero.
          (report.edited ? `; edited=${report.edited}` : "") +
          (report.noText ? `; ${noTextSummary(report.noText, report.noTextShapes)}` : "") +
          // Picture reading, Phase 0: left off when there were none.
          (report.imageCounts?.images
            ? `; images=${toNumber(report.imageCounts.images)} (withPointer=${toNumber(report.imageCounts.withPointer)}, ` +
              `captioned=${toNumber(report.imageCounts.captioned)})`
            : "") +
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
