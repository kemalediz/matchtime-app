/**
 * Download, decrypt, unpack and decode of a shared group history bundle,
 * end to end against a synthetic bundle encrypted here with the same
 * primitives (`group-history-fixture.ts`). No network: the fetch is a stub.
 */
import { describe, it, expect } from "vitest";
import { proto } from "baileys";
import {
  GROUP_HISTORY_KEY_CANDIDATES,
  MAX_BUNDLE_ENC_BYTES,
  MAX_STATED_MESSAGES,
  decryptBundle,
  deriveMediaKeys,
  describeProtoShape,
  formatBundleReport,
  readGroupHistoryBundle,
  unpackBundle,
} from "./group-history-bundle.js";
import {
  encodeGroupHistory,
  encodeHistorySyncMsgList,
  encryptBundle,
  lenField,
  pack,
  servingFetch,
  varint,
} from "./group-history-fixture.js";

const GROUP = "120363000000000000@g.us";
const OTHER_GROUP = "120363999999999999@g.us";
const ALICE = "111111111111111@lid";
const BOB = "447700900222@s.whatsapp.net";
const SECRET = "bring the orange bibs on Tuesday";
const T0 = 1_759_000_000;

function msg(
  id: string,
  text: string | null,
  extra: { participant?: string; fromMe?: boolean; ts?: number; pushName?: string; chat?: string | null } = {},
): proto.IWebMessageInfo {
  const key: proto.IMessageKey = { id, fromMe: extra.fromMe ?? false };
  if (extra.chat !== null) key.remoteJid = extra.chat ?? GROUP;
  if (extra.participant) key.participant = extra.participant;
  return {
    key,
    message: text === null ? undefined : { conversation: text },
    messageTimestamp: extra.ts ?? T0,
    pushName: extra.pushName,
  };
}

const THREE = [
  msg("3EB0AAAAAAAAAAAA0001", SECRET, { participant: ALICE, ts: T0 + 20, pushName: "Alice" }),
  msg("3EB0AAAAAAAAAAAA0002", "I am in", { participant: BOB, ts: T0 + 10 }),
  msg("3EB0AAAAAAAAAAAA0003", "me too", { fromMe: true, ts: T0 + 30 }),
];

describe("the media keys", () => {
  it("derives the Group History keys the way WhatsApp Web does (fixture from whatsapp-rust)", () => {
    // wacore/src/download.rs: hkdfSync('sha256', [0x5a; 32], empty salt, 'Group History', 112)
    const keys = deriveMediaKeys(Buffer.alloc(32, 0x5a), "Group History");
    expect(keys.iv.toString("hex")).toBe("71bae6974461bf53abc89acdf9cabe19");
    expect(keys.cipherKey.length).toBe(32);
    expect(keys.macKey.length).toBe(32);
  });

  it("matches Baileys' own derivation for the linked-device history type", async () => {
    const { getMediaKeys } = await import("baileys");
    const key = Buffer.alloc(32, 7);
    const theirs = await getMediaKeys(key, "md-msg-hist");
    const ours = deriveMediaKeys(key, "WhatsApp History Keys");
    expect(ours.iv.equals(Buffer.from(theirs.iv))).toBe(true);
    expect(ours.cipherKey.equals(Buffer.from(theirs.cipherKey))).toBe(true);
    expect(ours.macKey.equals(Buffer.from(theirs.macKey!))).toBe(true);
  });

  it("tries Group History first", () => {
    expect(GROUP_HISTORY_KEY_CANDIDATES.map((c) => c.info)).toEqual([
      "Group History",
      "WhatsApp History Keys",
      "WhatsApp Document Keys",
      "WhatsApp App State Keys",
    ]);
  });
});

describe("decryptBundle", () => {
  const payload = Buffer.from("any payload at all, of any length");

  it("decrypts with the first candidate and checks both hashes", () => {
    const { enc, bundle } = encryptBundle(payload);
    const r = decryptBundle(enc, bundle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plain.equals(payload)).toBe(true);
    expect(r.key).toBe("Group History");
    expect(r.keyIndex).toBe(0);
    expect(r.encSha).toBe("ok");
    expect(r.plainSha).toBe("ok");
  });

  it("falls through to a later candidate when the first fails the MAC check", () => {
    const { enc, bundle } = encryptBundle(payload, { info: "WhatsApp Document Keys" });
    const r = decryptBundle(enc, bundle);
    expect(r.ok && r.key).toBe("WhatsApp Document Keys");
    expect(r.ok && r.keyIndex).toBe(2);
  });

  it("fails safely when no candidate passes the MAC check", () => {
    const { enc, bundle } = encryptBundle(payload, { info: "Something Else Entirely" });
    const r = decryptBundle(enc, bundle);
    expect(r).toEqual({ ok: false, reason: "no key candidate passed the MAC check (4 tried)" });
  });

  it("refuses a download that is not what the pointer promised", () => {
    const { enc, bundle } = encryptBundle(payload);
    const tampered = Buffer.from(enc);
    tampered[0] ^= 1;
    expect(decryptBundle(tampered, bundle)).toEqual({
      ok: false,
      reason: "the downloaded bytes do not match the hash on the pointer",
    });
  });

  it("refuses a body that cannot be a media ciphertext, and a pointer with no key", () => {
    const { bundle } = encryptBundle(payload);
    expect(decryptBundle(Buffer.alloc(7), { ...bundle, fileEncSha256: null }).ok).toBe(false);
    expect(decryptBundle(Buffer.alloc(31), { ...bundle, fileEncSha256: null }).ok).toBe(false);
    const noKey = decryptBundle(Buffer.alloc(42), { ...bundle, mediaKey: null });
    expect(noKey).toEqual({ ok: false, reason: "the pointer carries no usable media key" });
  });

  it("reports a plaintext hash mismatch without discarding an authenticated payload", () => {
    const { enc, bundle } = encryptBundle(payload);
    const r = decryptBundle(enc, { ...bundle, fileSha256: Buffer.alloc(32) });
    expect(r.ok && r.plainSha).toBe("mismatch");
  });
});

describe("unpackBundle", () => {
  it("reads a zlib-compressed GroupHistory", async () => {
    const r = await unpackBundle(pack(encodeGroupHistory(THREE), "zlib"), GROUP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unpack).toBe("zlib inflate");
    expect(r.decoder).toBe("GroupHistory");
    expect(r.entries).toBe(3);
    expect(r.valid).toBe(3);
    // Oldest first, whatever order the bundle was in.
    expect(r.rows.map((x) => x.id)).toEqual([
      "3EB0AAAAAAAAAAAA0002",
      "3EB0AAAAAAAAAAAA0001",
      "3EB0AAAAAAAAAAAA0003",
    ]);
    expect(r.rows[1]).toEqual({
      id: "3EB0AAAAAAAAAAAA0001",
      senderJid: ALICE,
      fromBundleSender: false,
      pushName: "Alice",
      text: SECRET,
      timestampSec: T0 + 20,
    });
    // The sharer's own message: no participant, flagged for the caller.
    expect(r.rows[2]).toMatchObject({ senderJid: null, fromBundleSender: true, pushName: null });
  });

  it.each([
    ["none", "not compressed"],
    ["gzip", "gzip"],
    ["raw-deflate", "raw deflate"],
  ] as const)("falls back when the payload is packed as %s", async (packing, name) => {
    const r = await unpackBundle(pack(encodeGroupHistory(THREE), packing), GROUP);
    expect(r.ok && r.unpack).toBe(name);
    expect(r.ok && r.rows.length).toBe(3);
  });

  it("falls back to the other protobuf candidates, in order", async () => {
    const list = await unpackBundle(pack(encodeHistorySyncMsgList(THREE), "zlib"), GROUP);
    expect(list.ok && list.decoder).toBe("HistorySyncMsg list");
    expect(list.ok && list.rows.length).toBe(3);

    const sync = proto.HistorySync.encode(
      proto.HistorySync.fromObject({
        syncType: proto.HistorySync.HistorySyncType.RECENT,
        conversations: [{ id: GROUP, messages: THREE.map((m) => ({ message: m })) }],
      }),
    ).finish();
    const hs = await unpackBundle(pack(Buffer.from(sync), "zlib"), GROUP);
    expect(hs.ok && hs.decoder).toBe("HistorySync");
    expect(hs.ok && hs.rows.length).toBe(3);
  });

  it("also reads the pinned messages outside the window (field 4)", async () => {
    const pinned = msg("3EB0AAAAAAAAAAAA0009", "pitch 3 from now on", { participant: BOB, ts: T0 - 99_999 });
    const r = await unpackBundle(pack(encodeGroupHistory(THREE, [pinned]), "zlib"), GROUP);
    expect(r.ok && r.rows[0].id).toBe("3EB0AAAAAAAAAAAA0009");
    expect(r.ok && r.rows.length).toBe(4);
  });

  it("keeps text and captions only, and drops another chat's messages", async () => {
    const mixed: proto.IWebMessageInfo[] = [
      ...THREE,
      msg("3EB0AAAAAAAAAAAA0004", "   ", { participant: BOB }),
      msg("3EB0AAAAAAAAAAAA0005", null, { participant: BOB }), // a system notice: no content
      { ...msg("3EB0AAAAAAAAAAAA0006", null, { participant: BOB }), message: { imageMessage: { mimetype: "image/jpeg" } } },
      {
        ...msg("3EB0AAAAAAAAAAAA0007", null, { participant: BOB, ts: T0 + 40 }),
        message: { imageMessage: { mimetype: "image/jpeg", caption: "the new kit" } },
      },
      msg("3EB0AAAAAAAAAAAA0008", "from somewhere else", { participant: BOB, chat: OTHER_GROUP }),
      // A duplicate id is one message.
      msg("3EB0AAAAAAAAAAAA0001", SECRET, { participant: ALICE, ts: T0 + 20 }),
      // No chat on the key at all: taken as this group's.
      msg("3EB0AAAAAAAAAAAA0010", "no chat on my key", { participant: ALICE, chat: null, ts: T0 + 50 }),
    ];
    const r = await unpackBundle(pack(encodeGroupHistory(mixed), "zlib"), GROUP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toBe(10);
    expect(r.otherChat).toBe(1);
    expect(r.rows.map((x) => x.text)).toEqual(["I am in", SECRET, "me too", "the new kit", "no chat on my key"]);
  });

  it("keeps only the newest messages up to the limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      msg(`3EB0AAAAAAAAAAAA${String(1000 + i)}`, `message ${i}`, { participant: BOB, ts: T0 + i }),
    );
    const r = await unpackBundle(pack(encodeGroupHistory(many), "zlib"), GROUP, { limit: 5 });
    expect(r.ok && r.withText).toBe(30);
    expect(r.ok && r.rows.map((x) => x.text)).toEqual([25, 26, 27, 28, 29].map((i) => `message ${i}`));
  });

  it("refuses to inflate past the plaintext cap", async () => {
    const bomb = pack(Buffer.alloc(200_000, 0x0a), "zlib");
    const r = await unpackBundle(bomb, GROUP, { maxPlainBytes: 10_000 });
    expect(r.ok).toBe(false);
  });

  it("on a payload it cannot decode, reports field numbers and wire types and no values", async () => {
    const unknown = Buffer.concat([
      lenField(7, Buffer.from(SECRET)),
      lenField(7, Buffer.from(SECRET)),
      Buffer.from([9 * 8 + 0]),
      varint(42),
    ]);
    const r = await unpackBundle(pack(unknown, "zlib"), GROUP);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no protobuf candidate found a message in the payload");
    expect(r.shapes[0]).toBe(`zlib inflate (${unknown.length} bytes): 7:len x2, 9:varint x1`);
    // The still-compressed bytes are described too: they are what a wrong unpacker would have left.
    expect(r.shapes[1]).toMatch(/^not compressed \(\d+ bytes\): /);
    expect(r.shapes).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("describeProtoShape", () => {
  it("names fields and wire types, and says where a non-protobuf stops parsing", () => {
    expect(describeProtoShape(encodeGroupHistory(THREE))).toBe("1:len x3");
    expect(describeProtoShape(Buffer.alloc(0))).toBe("empty");
    expect(describeProtoShape(Buffer.from([0x0a, 0x7f, 0x01]))).toMatch(/^not a protobuf message \(stops at byte \d+ of 3/);
  });
});

describe("readGroupHistoryBundle", () => {
  const payload = pack(encodeGroupHistory(THREE), "zlib");

  it("downloads from WhatsApp's media host, decrypts and parses", async () => {
    const { enc, bundle } = encryptBundle(payload, { messageCount: 3 });
    const { fetchBundle, calls } = servingFetch(enc);
    const r = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.text)).toEqual(["I am in", SECRET, "me too"]);
    expect(calls).toEqual([
      {
        url: "https://mmg.whatsapp.net/v/t62.0000-0/synthetic.enc?ccb=1",
        headers: { Origin: "https://web.whatsapp.com" },
      },
    ]);

    const lines = formatBundleReport(r.report);
    expect(lines).toEqual([
      `downloaded ${enc.length} bytes (http 200); decrypted with "Group History" (candidate 1 of 4, ` +
        `download hash ok, content hash ok) to ${payload.length} bytes; unpacked as zlib inflate ` +
        `(inflate needed: yes) to ${encodeGroupHistory(THREE).length} bytes; decoded as GroupHistory: ` +
        "entries=3 valid=3 otherChat=0 withText=3 authors=3 kept=3 (stated messageCount=3)",
    ]);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("synthetic.enc");
  });

  it.each([
    ["no direct path", { directPath: null }, "the pointer has no usable direct path"],
    ["a path that names another host", { directPath: "//evil.example/x" }, "the pointer has no usable direct path"],
    ["a path that is a whole URL", { directPath: "https://evil.example/x" }, "the pointer has no usable direct path"],
    ["no media key", { mediaKey: null }, "the pointer carries no usable media key"],
    [
      "an absurd stated count",
      { messageHistoryMetadata: { messageCount: MAX_STATED_MESSAGES + 1 } },
      `the pointer states ${MAX_STATED_MESSAGES + 1} messages, over the ${MAX_STATED_MESSAGES} this will read`,
    ],
  ])("refuses %s before any download", async (_name, patch, reason) => {
    const { enc, bundle } = encryptBundle(payload);
    const { fetchBundle, calls } = servingFetch(enc);
    const r = await readGroupHistoryBundle({ ...bundle, ...patch }, GROUP, { fetchBundle });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
    expect(!r.ok && r.report.stage).toBe("pointer");
    expect(calls).toEqual([]);
  });

  it("refuses a body the server says is too large, without reading it", async () => {
    const { enc, bundle } = encryptBundle(payload);
    const { fetchBundle } = servingFetch(enc, { contentLength: String(MAX_BUNDLE_ENC_BYTES + 1) });
    const r = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle });
    expect(!r.ok && r.report.stage).toBe("download");
    expect(!r.ok && r.reason).toMatch(/^the server states \d+ bytes, over the \d+ this will download$/);
  });

  it("stops reading a body that turns out to be too large", async () => {
    const { enc, bundle } = encryptBundle(payload);
    const { fetchBundle } = servingFetch(enc);
    const r = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle, maxEncBytes: 16 });
    expect(!r.ok && r.reason).toBe("the download passed 16 bytes and was abandoned");
  });

  it("degrades on an HTTP error, a network error and a timeout, never throwing", async () => {
    const { bundle } = encryptBundle(payload);
    const gone = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle: servingFetch(null, { status: 410 }).fetchBundle });
    expect(!gone.ok && gone.reason).toBe("the media server answered http 410");

    const down = await readGroupHistoryBundle(bundle, GROUP, {
      fetchBundle: async () => {
        throw new Error("getaddrinfo ENOTFOUND mmg.whatsapp.net /v/secret-path");
      },
    });
    // The error text can carry the URL: only its kind is kept.
    expect(!down.ok && down.reason).toBe("the download failed (Error)");

    const hung = await readGroupHistoryBundle(bundle, GROUP, {
      timeoutMs: 5,
      fetchBundle: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    expect(!hung.ok && hung.reason).toBe("the download did not finish within 5ms");
  });

  it("reports a decode failure with the shape of the plaintext", async () => {
    const odd = pack(lenField(12, Buffer.from(SECRET)), "zlib");
    const { enc, bundle } = encryptBundle(odd);
    const r = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle: servingFetch(enc).fetchBundle });
    expect(r.ok).toBe(false);
    const lines = formatBundleReport(r.report);
    expect(lines[0]).toContain("FAILED at decode: no protobuf candidate found a message in the payload");
    expect(lines[0]).toContain('decrypted with "Group History"');
    expect(lines.slice(1)).toEqual([
      `  plaintext shape, zlib inflate (${SECRET.length + 2} bytes): 12:len x1`,
      `  plaintext shape, not compressed (${odd.length} bytes): ${describeProtoShape(odd)}`,
    ]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
