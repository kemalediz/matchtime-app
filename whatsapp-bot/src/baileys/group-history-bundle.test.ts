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
  MAX_BUNDLE_TEXT_CHARS,
  MAX_NO_TEXT_SHAPES,
  MAX_NO_TEXT_SUMMARY_CHARS,
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
      truncated: false,
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
    // Only the last five entries are ever decoded.
    expect(r.ok && r.entries).toBe(30);
    expect(r.ok && r.read).toBe(5);
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
        redirect: "error",
      },
    ]);

    const lines = formatBundleReport(r.report);
    expect(lines).toEqual([
      `downloaded ${enc.length} bytes (http 200); decrypted with "Group History" (candidate 1 of 4, ` +
        `download hash ok, content hash ok) to ${payload.length} bytes; unpacked as zlib inflate ` +
        `(inflate needed: yes) to ${encodeGroupHistory(THREE).length} bytes; decoded as GroupHistory: ` +
        "entries=3 read=3 tooLarge=0 valid=3 otherChat=0 withText=3 textCut=0 authors=3 kept=3 (stated messageCount=3)",
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

describe("a redirect is never followed (review 2, item 5)", () => {
  it("asks the real fetch not to follow one, and a 302 fails the download cleanly", async () => {
    const { createServer } = await import("node:http");
    let elsewhereHits = 0;
    const server = createServer((req, res) => {
      if (req.url === "/elsewhere") {
        elsewhereHits++;
        res.end("not the bundle");
        return;
      }
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const { bundle } = encryptBundle(Buffer.from("x"));
      // The media host is pinned, so the real fetch is pointed at a local
      // server here, with exactly the options the reader passes.
      const r = await readGroupHistoryBundle(bundle, GROUP, {
        fetchBundle: (_url, init) => fetch(`http://127.0.0.1:${port}/bundle`, init as RequestInit) as never,
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.report.stage).toBe("download");
      expect(!r.ok && r.reason).toBe("the download failed (TypeError)");
      expect(elsewhereHits).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("one message's text is capped (review 2, residual)", () => {
  it("cuts a long text to 1,000 characters, counts it, and never splits a surrogate pair", async () => {
    const long = "a".repeat(999) + "\u{1F600}" + "b".repeat(5000);
    const r = await unpackBundle(
      pack(
        encodeGroupHistory([
          msg("3EB0AAAAAAAAAAAA0001", long, { participant: ALICE }),
          msg("3EB0AAAAAAAAAAAA0002", "short", { participant: BOB, ts: T0 + 1 }),
        ]),
        "zlib",
      ),
      GROUP,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(MAX_BUNDLE_TEXT_CHARS).toBe(1000);
    expect(r.rows[0].text).toBe("a".repeat(999));
    expect(r.rows[0].truncated).toBe(true);
    expect(r.rows[1]).toMatchObject({ text: "short", truncated: false });
    expect(r.textCut).toBe(1);
  });
});

// ── Edited messages (production, 2026-10-11) ─────────────────────────
// The first real bundle held three messages that had been edited in
// WhatsApp, and none of them came out as a row. Nobody has seen the shape
// an edit has inside a bundle entry (the log carries no content), so every
// plausible one from the Baileys proto is read here, and an entry that
// still yields no text is tallied by FIELD NAME for the next real run.
describe("an edited message in a bundle", () => {
  const ID = "3EB0AAAAAAAAAAAA0001";
  const EDIT_ID = "3EB0EEEEEEEEEEEE0001";
  const OLD = "training is at 7pm";
  const NEW = "training is at 8pm, not 7";
  const EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;

  function entry(
    id: string,
    message: proto.IMessage,
    extra: { participant?: string; ts?: number; pushName?: string } = {},
  ): proto.IWebMessageInfo {
    return {
      key: { id, fromMe: false, remoteJid: GROUP, participant: extra.participant ?? ALICE },
      message,
      messageTimestamp: extra.ts ?? T0,
      pushName: extra.pushName,
    };
  }
  const protocolEdit = (edited: proto.IMessage, targetId = ID, timestampMs?: number): proto.IMessage => ({
    protocolMessage: { key: { id: targetId, remoteJid: GROUP, fromMe: false }, type: EDIT, editedMessage: edited, timestampMs },
  });
  const read = async (entries: proto.IWebMessageInfo[]) => {
    const r = await unpackBundle(pack(encodeGroupHistory(entries), "zlib"), GROUP);
    if (!r.ok) throw new Error(r.reason);
    return r;
  };
  const BOBS = {
    id: "3EB0AAAAAAAAAAAA0002",
    senderJid: BOB,
    fromBundleSender: false,
    pushName: null,
    text: "I am in",
    truncated: false,
    timestampSec: T0 + 10,
  };
  const EDITED = {
    id: ID,
    senderJid: ALICE,
    fromBundleSender: false,
    pushName: "Alice",
    text: NEW,
    truncated: false,
    timestampSec: T0 + 5,
  };

  it.each<[string, proto.IMessage]>([
    ["the editedMessage wrapper around the new text", { editedMessage: { message: { conversation: NEW } } }],
    [
      "the editedMessage wrapper around an edit protocol message",
      { editedMessage: { message: protocolEdit({ conversation: NEW }) } },
    ],
    ["a top-level edit protocol message", protocolEdit({ conversation: NEW })],
    ["an edit protocol message carrying extended text", protocolEdit({ extendedTextMessage: { text: NEW } })],
    [
      "an edit inside a disappearing-messages wrapper",
      { ephemeralMessage: { message: { editedMessage: { message: protocolEdit({ conversation: NEW }) } } } },
    ],
    [
      "an edit whose new content is itself wrapped",
      protocolEdit({ ephemeralMessage: { message: { extendedTextMessage: { text: NEW } } } }),
    ],
    ["an edited caption", protocolEdit({ imageMessage: { caption: NEW, mimetype: "image/jpeg" } })],
  ])("reads %s, once", async (_name, message) => {
    const r = await read([
      entry(ID, message, { ts: T0 + 5, pushName: "Alice" }),
      msg("3EB0AAAAAAAAAAAA0002", "I am in", { participant: BOB, ts: T0 + 10 }),
    ]);
    expect(r.rows).toEqual([EDITED, BOBS]);
    expect(r.withText).toBe(2);
    expect(r.edited).toBe(1);
    expect(r.noText).toBe(0);
  });

  it("says how many edits it read on the log line, and none of their words", async () => {
    const { enc, bundle } = encryptBundle(
      pack(encodeGroupHistory([entry(ID, protocolEdit({ conversation: NEW }))]), "zlib"),
      { messageCount: 1 },
    );
    const full = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle: servingFetch(enc).fetchBundle });
    const lines = formatBundleReport(full.report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/withText=1 textCut=0 authors=1 kept=1 \(stated messageCount=1\); edited=1$/);
    expect(lines[0]).not.toContain(NEW);
  });

  it.each([
    ["the original first", false],
    ["the edit first", true],
  ] as const)(
    "lets a separate edit entry win over the original, and keeps the message once (%s)",
    async (_name, editFirst) => {
      const original = entry(ID, { conversation: OLD }, { ts: T0 + 5, pushName: "Alice" });
      // Its own id and a later time: it NAMES the message it edits.
      const edit = entry(EDIT_ID, protocolEdit({ conversation: NEW }, ID), { ts: T0 + 500 });
      const other = msg("3EB0AAAAAAAAAAAA0002", "I am in", { participant: BOB, ts: T0 + 10 });
      const r = await read(editFirst ? [edit, original, other] : [original, other, edit]);
      // The message's own place and name, the edit's words.
      expect(r.rows).toEqual([EDITED, BOBS]);
      expect(r.rows.map((x) => x.text).join("|")).not.toContain(OLD);
      expect(r.edited).toBe(1);
    },
  );

  it("keeps the latest of several edits to one message", async () => {
    const r = await read([
      entry(ID, { conversation: OLD }, { ts: T0 }),
      entry("3EB0EEEEEEEEEEEE0002", protocolEdit({ conversation: NEW }, ID, (T0 + 90) * 1000), { ts: T0 + 90 }),
      entry(EDIT_ID, protocolEdit({ conversation: "an earlier edit" }, ID, (T0 + 30) * 1000), { ts: T0 + 30 }),
    ]);
    expect(r.rows.map((x) => [x.id, x.text])).toEqual([[ID, NEW]]);
  });

  it("leaves an unedited message exactly as it was", async () => {
    const r = await read(THREE);
    expect(r.rows.map((x) => x.text)).toEqual(["I am in", SECRET, "me too"]);
    expect(r.edited).toBe(0);
    expect(r.noText).toBe(0);
    expect(r.noTextShapes).toEqual([]);
  });

  it("caps an edited text like any other", async () => {
    const r = await read([entry(ID, protocolEdit({ conversation: "x".repeat(5000) }))]);
    expect(r.rows[0].text.length).toBe(MAX_BUNDLE_TEXT_CHARS);
    expect(r.rows[0].truncated).toBe(true);
  });
});

describe("entries that yield no text are tallied by field name, never by content", () => {
  const LEAK = "zebra-crossing-447700900999";
  const stub = (id: string, n: number): proto.IWebMessageInfo => ({
    key: { id, fromMe: false, remoteJid: GROUP, participant: ALICE },
    messageStubType: n,
    messageStubParameters: [LEAK],
    messageTimestamp: T0,
    pushName: LEAK,
  });
  const holding = (id: string, message: proto.IMessage): proto.IWebMessageInfo => ({
    key: { id, fromMe: false, remoteJid: GROUP, participant: ALICE },
    message,
    messageTimestamp: T0,
    pushName: LEAK,
  });
  const ENTRIES: proto.IWebMessageInfo[] = [
    msg("3EB0AAAAAAAAAAAA0001", "I am in", { participant: BOB }),
    stub("3EB0BBBBBBBBBBBB0001", 20),
    stub("3EB0BBBBBBBBBBBB0002", 20),
    holding("3EB0BBBBBBBBBBBB0003", {
      imageMessage: { mimetype: "image/jpeg", url: `https://example.test/${LEAK}`, mediaKey: Buffer.from(LEAK) },
    }),
    holding("3EB0BBBBBBBBBBBB0004", { reactionMessage: { text: LEAK, key: { id: "3EB0AAAAAAAAAAAA0001" } } }),
    holding("3EB0BBBBBBBBBBBB0005", {
      protocolMessage: { type: 0, key: { id: "3EB0AAAAAAAAAAAA0001", participant: LEAK } },
    }),
    holding("3EB0BBBBBBBBBBBB0006", {
      editedMessage: {
        message: {
          protocolMessage: {
            type: 14,
            editedMessage: { pollCreationMessage: { name: LEAK, options: [{ optionName: LEAK }] } },
          },
        },
      },
    }),
    holding("3EB0BBBBBBBBBBBB0007", {
      ephemeralMessage: { message: { contactMessage: { displayName: LEAK, vcard: LEAK } } },
      messageContextInfo: { messageSecret: Buffer.from(LEAK) },
    }),
    holding("3EB0BBBBBBBBBBBB0008", { secretEncryptedMessage: { secretEncType: 2, encPayload: Buffer.from(LEAK) } }),
    // Decodes, has a key, and no message at all.
    {
      key: { id: "3EB0BBBBBBBBBBBB0009", fromMe: false, remoteJid: GROUP, participant: ALICE },
      reactions: [{ text: LEAK }],
    },
  ];

  it("names the shapes, with counts and enum numbers only", async () => {
    const r = await unpackBundle(pack(encodeGroupHistory(ENTRIES), "zlib"), GROUP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valid).toBe(10);
    expect(r.withText).toBe(1);
    expect(r.noText).toBe(9);
    expect(r.noTextShapes[0]).toEqual({ shape: "stub:20", count: 2 });
    expect(r.noTextShapes.map((s) => s.shape).sort()).toEqual(
      [
        "stub:20",
        "imageMessage",
        "reactionMessage",
        "protocolMessage:0",
        "editedMessage>protocolMessage:14>pollCreationMessage",
        "ephemeralMessage>contactMessage",
        "secretEncryptedMessage:2",
        "noMessage[reactions]",
      ].sort(),
    );
    expect(JSON.stringify(r.noTextShapes)).not.toContain("zebra");
  });

  it("puts the tally on the log line and nothing of the content", async () => {
    const { enc, bundle } = encryptBundle(pack(encodeGroupHistory(ENTRIES), "zlib"), { messageCount: 10 });
    const full = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle: servingFetch(enc).fetchBundle });
    const lines = formatBundleReport(full.report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kept=1 (stated messageCount=10); noText=9 (2 x stub:20, 1 x ");
    expect(lines[0]).toContain("1 x editedMessage>protocolMessage:14>pollCreationMessage");
    const everything = lines.join("\n") + JSON.stringify(full.report);
    for (const secret of [LEAK, "zebra", "447700900999", "example.test", Buffer.from(LEAK).toString("base64")]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("lists at most 8 distinct shapes and keeps the summary short", async () => {
    // 12 distinct shapes (12 stub types), one of them seen twice.
    const many = [
      ...Array.from({ length: 12 }, (_, i) => stub(`3EB0CCCCCCCCCCCC00${10 + i}`, 20 + i)),
      stub("3EB0CCCCCCCCCCCC0099", 31),
    ];
    const r = await unpackBundle(pack(encodeGroupHistory(many), "zlib"), GROUP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(MAX_NO_TEXT_SHAPES).toBe(8);
    expect(r.noText).toBe(13);
    expect(r.noTextShapes).toHaveLength(MAX_NO_TEXT_SHAPES + 1);
    // Read newest first: the 8 newest shapes are listed (one of them twice), the 4 oldest are "other".
    expect(r.noTextShapes[0]).toEqual({ shape: "stub:31", count: 2 });
    expect(r.noTextShapes.at(-1)).toEqual({ shape: "other", count: 4 });
    expect(r.noTextShapes.reduce((n, s) => n + s.count, 0)).toBe(13);

    const long = formatBundleReport({
      stage: "done",
      statedMessages: 1,
      noText: 800,
      noTextShapes: Array.from({ length: 9 }, (_, i) => ({ shape: `${"w".repeat(79)}${i}`, count: 100 - i })),
    });
    const summary = long[0].slice(long[0].indexOf("noText="));
    expect(summary.length).toBeLessThanOrEqual(MAX_NO_TEXT_SUMMARY_CHARS);
    expect(summary).toMatch(/^noText=800 \(100 x w+0, .*\.\.\.\)$/);
  });

  it("never throws on a tally it cannot write", () => {
    expect(() =>
      formatBundleReport({ stage: "done", statedMessages: 1, noText: 1, noTextShapes: null as never }),
    ).not.toThrow();
  });
});
