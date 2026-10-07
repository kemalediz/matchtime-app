/**
 * The history WhatsApp shares at a join, through the driver: the sequence
 * measured in production on 2026-10-08 (join notice, bundle, notice),
 * replayed against a synthetic bundle, ending where the server's input is
 * built (`collectHistoryForServer`). No network: the media fetch is a stub.
 *
 * What is pinned here is what matters on a live club's group: a bundle in
 * a group we were NOT just added to is never downloaded, nothing shared
 * reaches the analyzer or the catch-up buffer, no text reaches the log,
 * and every failure ends as "no history", never as a throw.
 */
import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import { FAKE_ME_LID, FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { encodeGroupHistory, encryptBundle, lenField, pack, servingFetch } from "../baileys/group-history-fixture.js";
import type { BundleFetch } from "../baileys/group-history-bundle.js";
import { createHistoryCollector } from "../history-capture.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const ESTABLISHED = "120363111111111111@g.us";
const JOINED = 1_760_000_000;
const SELF_IDS = ["447700900001@c.us", "158000000000001@lid"];

const ADDER_LID = "200000000000001@lid";
const ADDER_PN = "447700900100@s.whatsapp.net";
const ALICE_LID = "200000000000002@lid";
const BOB_PN = "447700900300@s.whatsapp.net";
const CARA_LID = "200000000000004@lid";

const SECRET = "bring the orange bibs on Tuesday";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function opened(fetchMedia: BundleFetch) {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const handed: unknown[] = [];
  let clock = JOINED * 1000;
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: manualScheduler().schedule,
    exit: () => {},
    log: () => {},
    error: () => {},
  });
  const sleeps: number[] = [];
  /** Reader waits that ran to their end, in ms. */
  const waited: number[] = [];
  const driver = makeBaileysDriver({
    connection: connection as never,
    now: () => clock,
    wait: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    // The reader's wait is a cancellable timer. One of 25 s or less fires
    // on the next turn (moving the clock) unless it was cancelled first;
    // the long ones (window sweeps, tallies) never fire here.
    schedule: (fn, ms) => {
      let cancelled = false;
      if (ms <= 25_000) {
        setImmediate(() => {
          if (cancelled) return;
          waited.push(ms);
          clock += ms;
          fn();
        });
      }
      return {
        cancel: () => {
          cancelled = true;
        },
      };
    },
    fetchMedia,
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
  });
  driver.onMessage((m) => {
    handed.push(m);
  });
  await driver.start();
  sockets[0].open();
  await flush();
  const collect = createHistoryCollector({
    driver,
    log: (l) => logs.push(l),
    warn: (l) => logs.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return {
    driver,
    sock: sockets[0],
    logs,
    handed,
    sleeps,
    waited,
    collect,
    advance: (ms: number) => {
      clock += ms;
    },
    join: () => logs.filter((l) => l.startsWith("[baileys][join-history]")),
  };
}

function wa(
  chat: string,
  message: proto.IMessage | null,
  id: string,
  tsSec: number,
  extra: Record<string, unknown> = {},
  key: Record<string, unknown> = {},
): WAMessage {
  return {
    key: { remoteJid: chat, fromMe: false, id, participant: ADDER_LID, participantAlt: ADDER_PN, ...key },
    message: message ? proto.Message.fromObject(message) : undefined,
    messageTimestamp: tsSec,
    ...extra,
  } as WAMessage;
}

const joinNotice = (chat = GROUP, ts = JOINED) => wa(chat, null, "JOIN", ts, { messageStubType: 20 });
const notice = (chat = GROUP) =>
  wa(chat, { messageHistoryNotice: { messageHistoryMetadata: { messageCount: 5 } } }, "AC1D00000000000000N1", JOINED + 1);
const carrier = (bundle: proto.Message.IMessageHistoryBundle, chat = GROUP, id = "AC0F00000000000000B1") =>
  wa(chat, { messageHistoryBundle: bundle, messageContextInfo: { messageSecret: Buffer.alloc(32, 1) } }, id, JOINED + 1);

function old(id: string, text: string, over: { participant?: string; fromMe?: boolean; ts: number; pushName?: string }) {
  const key: proto.IMessageKey = { remoteJid: GROUP, id: `3EB0AAAAAAAAAAAA${id}`, fromMe: over.fromMe ?? false };
  if (over.participant) key.participant = over.participant;
  return { key, message: { conversation: text }, messageTimestamp: over.ts, pushName: over.pushName };
}

/** Five old messages: three people, the sharer herself, and one of our own from an earlier stay. */
const SHARED: proto.IWebMessageInfo[] = [
  old("0001", SECRET, { participant: ALICE_LID, ts: JOINED - 500, pushName: "Alice" }),
  old("0002", "I am in", { participant: BOB_PN, ts: JOINED - 400 }),
  old("0003", "me too", { fromMe: true, ts: JOINED - 300 }),
  old("0004", "count me out", { participant: CARA_LID, ts: JOINED - 200 }),
  old("0005", "see you there", { participant: ALICE_LID, ts: JOINED - 100 }),
  old("0006", "MatchTime here", { participant: FAKE_ME_LID, ts: JOINED - 50 }),
];

function synthetic(messages = SHARED) {
  return encryptBundle(pack(encodeGroupHistory(messages), "zlib"), { messageCount: messages.length });
}

describe("the add of 2026-10-08, replayed: join notice, bundle, notice", () => {
  it("reads the bundle and hands the bot-added flow the messages, with authors resolved", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    // What the roster read (which the bot-added flow does first) would have stored.
    t.sock.storedPnForLid.set(ALICE_LID, "447700900200@s.whatsapp.net");

    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "append" });
    t.sock.emit("messages.upsert", { messages: [carrier(bundle)], type: "notify" });
    t.sock.emit("messages.upsert", { messages: [notice()], type: "notify" });
    await flush();

    const out = await t.collect(GROUP, SELF_IDS);
    expect(out).toEqual([
      { author: "Alice", authorPhone: "447700900200", text: SECRET, timestamp: new Date((JOINED - 500) * 1000).toISOString() },
      { author: "Member 1", authorPhone: "447700900300", text: "I am in", timestamp: new Date((JOINED - 400) * 1000).toISOString() },
      // The sharer's own message carries no author: it is whoever sent the bundle.
      { author: "Member 2", authorPhone: "447700900100", text: "me too", timestamp: new Date((JOINED - 300) * 1000).toISOString() },
      // A LID nobody has told us the phone for: no phone, never a guess.
      { author: "Member 3", authorPhone: null, text: "count me out", timestamp: new Date((JOINED - 200) * 1000).toISOString() },
      // A name seen on one of a person's messages serves the others.
      { author: "Alice", authorPhone: "447700900200", text: "see you there", timestamp: new Date((JOINED - 100) * 1000).toISOString() },
    ]);
    expect(calls).toHaveLength(1);
    // Already there when asked for: no waiting at all.
    expect(t.sleeps).toEqual([]);
    expect(t.waited).toEqual([]);

    const plainBytes = encodeGroupHistory(SHARED).length;
    expect(t.join()).toEqual([
      `[baileys][join-history] ${GROUP}: we were just added (the join notice); a shared history bundle for this group will be read for the next 300s`,
      `[baileys][join-history] ${GROUP}: bundle AC0F00000000000000B1: downloading`,
      `[baileys][join-history] ${GROUP}: bundle AC0F00000000000000B1: downloaded ${enc.length} bytes (http 200); ` +
        `decrypted with "Group History" (candidate 1 of 4, download hash ok, content hash ok) to ` +
        `${pack(encodeGroupHistory(SHARED), "zlib").length} bytes; unpacked as zlib inflate (inflate needed: yes) to ` +
        `${plainBytes} bytes; decoded as GroupHistory: entries=6 read=6 tooLarge=0 valid=6 otherChat=0 withText=6 authors=5 kept=6 ` +
        "(stated messageCount=6)",
      `[baileys][join-history] ${GROUP}: handed to the bot-added flow: 5 message(s) from 4 author(s): 1 with a known name, ` +
        "3 given a stand-in name; 4 message(s) with a phone number; left out: 1 of our own, 0 with no author, 0 with an unusable date",
    ]);

    // PR #216's diagnostic lines are still printed.
    expect(t.logs.some((l) => l.includes("is a group history BUNDLE (messageCount=6"))).toBe(true);
    expect(t.logs.some((l) => l.includes("is a group history NOTICE (messageCount=5"))).toBe(true);
    expect(t.logs.filter((l) => l.includes("skipped: no content type"))).toHaveLength(2);

    // Nothing shared went to the analyzer or the catch-up buffer, and no
    // text, name, path or key went to the log.
    expect(t.handed).toEqual([]);
    t.advance(60_000);
    expect(await t.driver.fetchRecentGroupMessages(GROUP, 50)).toEqual([]);
    const all = t.logs.join("\n");
    for (const secret of [SECRET, "I am in", "Alice", "synthetic.enc", Buffer.from(bundle.mediaKey as Uint8Array).toString("base64")]) {
      expect(all).not.toContain(secret);
    }
  });

  it("is read once: a second read gets the live buffer, and a second bundle is ignored", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toHaveLength(5);

    t.sock.emit("messages.upsert", { messages: [carrier(bundle, GROUP, "AC0F00000000000000B2")], type: "notify" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(t.join().at(-1)).toContain("bundle AC0F00000000000000B2 ignored");
    t.advance(60_000);
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
  });

  it("uses a name the bot already knows for somebody the bundle does not name", async () => {
    const { enc, bundle } = synthetic();
    const t = await opened(servingFetch(enc).fetchBundle);
    t.sock.emit("contacts.upsert", [{ id: BOB_PN, notify: "Bob" }]);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    const out = await t.collect(GROUP, SELF_IDS);
    expect(out.map((m) => m.author)).toEqual(["Alice", "Bob", "Member 1", "Member 2", "Alice"]);
  });
});

describe("the gate", () => {
  it("never downloads a bundle in a group we were not just added to", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [carrier(bundle, ESTABLISHED), notice(ESTABLISHED)], type: "notify" });
    await flush();

    expect(calls).toEqual([]);
    expect(t.join()).toEqual([
      `[baileys][join-history] ${ESTABLISHED}: bundle AC0F00000000000000B1 ignored: this is not a group we were just added to, so it is not downloaded`,
    ]);
    const cap = await t.driver.joinHistory!(ESTABLISHED, SELF_IDS);
    expect(cap).toEqual({ outcome: "none", messages: [] });
    expect(t.waited).toEqual([]);
  });

  it("a join to one group does not open another", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(GROUP), carrier(bundle, ESTABLISHED)], type: "notify" });
    await flush();
    expect(calls).toEqual([]);
  });

  it("an old join notice replayed after time offline does not open it", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(GROUP, JOINED - 86_400), carrier(bundle)], type: "append" });
    await flush();
    expect(calls).toEqual([]);
  });

  it("closes when the window passes", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "notify" });
    await flush();
    t.advance(5 * 60 * 1000);
    t.sock.emit("messages.upsert", { messages: [carrier(bundle)], type: "notify" });
    await flush();
    expect(calls).toEqual([]);
  });

  it("opens for a self-add that arrives as a participants update", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("group-participants.update", {
      id: GROUP,
      author: ADDER_LID,
      participants: [{ id: FAKE_ME_LID }],
      action: "add",
    });
    await flush();
    t.sock.emit("messages.upsert", { messages: [carrier(bundle)], type: "notify" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(t.join()[0]).toContain("we were just added (a participants update)");
  });
});

describe("timing", () => {
  it("with the switch off, gives up after the quiet wait and reads the live buffer once", async () => {
    const t = await opened(servingFetch(null).fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    // Asked the instant we joined, so the whole 10 s: in production the
    // flow asks a few seconds in (after the roster read) and waits less.
    expect(t.waited).toEqual([10_000]);
    // Then ONE read of the live buffer, with no sleeping between attempts.
    expect(t.sleeps.filter((ms) => ms === 4000)).toEqual([]);
    expect(t.join().at(-1)).toBe(
      `[baileys][join-history] ${GROUP}: nothing to hand to the bot-added flow (none): no shared-history notice or bundle was seen for this group`,
    );
    expect(t.logs.filter((l) => l.includes("history fetch attempt"))).toEqual([
      "[bot-added] history fetch attempt 1: got 0 msgs",
    ]);
  });

  it("with a notice seen and a download that never finishes, waits 25s and then falls back", async () => {
    const { bundle } = synthetic();
    const t = await opened(() => new Promise(() => {}));
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle), notice()], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    expect(t.waited).toEqual([25_000]);
    expect(t.join().at(-1)).toContain("(timeout): shared history was announced but was not ready in time");
  });
});

describe("failure paths end as no history, never as a throw", () => {
  it.each([
    ["the media server refuses", () => servingFetch(null, { status: 403 }).fetchBundle, "FAILED at download: the media server answered http 403"],
    [
      "the fetch throws",
      (): BundleFetch => async () => {
        throw new Error(`could not reach https://mmg.whatsapp.net/secret-path`);
      },
      "FAILED at download: the download failed (Error)",
    ],
    [
      "the key is not one we know",
      () => servingFetch(encryptBundle(Buffer.from("x"), { info: "Unknown Keys" }).enc).fetchBundle,
      "FAILED at decrypt: the downloaded bytes do not match the hash on the pointer",
    ],
  ])("when %s", async (_name, makeFetch, expected) => {
    const { bundle } = synthetic();
    const t = await opened(makeFetch());
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    expect(t.join().some((l) => l.includes(expected))).toBe(true);
    expect(t.join().at(-1)).toContain("(failed): the bundle could not be read; see the line above");
    expect(t.logs.join("\n")).not.toContain("secret-path");
    // The reader did not wait: the failure was already known.
    expect(t.waited).toEqual([]);
  });

  it("when the payload is a format we do not know, logs its shape and no values", async () => {
    const odd = encryptBundle(pack(lenField(9, Buffer.from(SECRET)), "zlib"), { messageCount: 1 });
    const t = await opened(servingFetch(odd.enc).fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(odd.bundle)], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    const lines = t.join();
    expect(lines.some((l) => l.includes("FAILED at decode: no protobuf candidate found a message in the payload"))).toBe(true);
    expect(lines.some((l) => l.includes(`plaintext shape, zlib inflate (${SECRET.length + 2} bytes): 9:len x1`))).toBe(true);
    expect(t.logs.join("\n")).not.toContain(SECRET);
  });

  it("a wrong HKDF string is caught by the MAC check, not by garbage", async () => {
    const wrong = encryptBundle(pack(encodeGroupHistory(SHARED), "zlib"), { info: "Unknown Keys" });
    const t = await opened(servingFetch(wrong.enc).fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(wrong.bundle)], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    expect(t.join().some((l) => l.includes("FAILED at decrypt: no key candidate passed the MAC check (4 tried)"))).toBe(true);
  });

  it("a slow download does not hold up the live club's messages", async () => {
    const { bundle } = synthetic();
    const t = await opened(() => new Promise(() => {}));
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    t.sock.emit("messages.upsert", {
      messages: [wa(ESTABLISHED, { conversation: "in" }, "LIVE0000000000000001", JOINED + 2, {}, { participant: BOB_PN })],
      type: "notify",
    });
    await flush();
    expect(t.handed).toHaveLength(1);
  });

  it("a malformed carrier is ignored without a throw", async () => {
    const t = await opened(servingFetch(null).fetchBundle);
    t.sock.emit("messages.upsert", {
      messages: [joinNotice(), carrier({ mimetype: "application/protobuf" })],
      type: "notify",
    });
    await flush();
    expect(t.join().some((l) => l.includes("FAILED at pointer: the pointer carries no usable media key"))).toBe(true);
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
  });
});

describe("a hostile bundle (H1), through the driver", () => {
  it("is refused with one line, hands over nothing, and the live club is still served", async () => {
    const one = lenField(1, Buffer.from(proto.WebMessageInfo.encode({ key: { id: "3EB0AAAAAAAAAAAA" } }).finish()));
    const bomb = Buffer.alloc(one.length * 1_800_000);
    for (let i = 0; i < 1_800_000; i++) one.copy(bomb, i * one.length);
    const hostile = encryptBundle(pack(bomb, "zlib"), { messageCount: 35 });
    expect(hostile.enc.length).toBeLessThan(100_000);
    const t = await opened(servingFetch(hostile.enc).fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(hostile.bundle)], type: "notify" });
    t.sock.emit("messages.upsert", {
      messages: [wa(ESTABLISHED, { conversation: "in" }, "LIVE0000000000000002", JOINED + 2, {}, { participant: BOB_PN })],
      type: "notify",
    });
    await flush();
    // The live message was handed up without waiting for the bundle.
    expect(t.handed).toHaveLength(1);
    // Inflating runs on zlib's own thread; give it real time to refuse.
    for (let i = 0; i < 200 && !t.join().some((l) => l.includes("FAILED")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    expect(t.waited).toEqual([]);
    expect(t.join().filter((l) => l.includes("FAILED"))).toEqual([
      `[baileys][join-history] ${GROUP}: bundle AC0F00000000000000B1: FAILED at decode: the payload inflates (zlib inflate) ` +
        "past the 2097152 bytes this will read; nothing was decoded (stated messageCount=35); before that: " +
        `downloaded ${hostile.enc.length} bytes (http 200); decrypted with "Group History" (candidate 1 of 4, ` +
        `download hash ok, content hash ok) to ${pack(bomb, "zlib").length} bytes`,
    ]);
  });

  it("reads one bundle at a time across groups: a second, in another group we just joined, is refused", async () => {
    const { bundle } = synthetic();
    const { fetchBundle, calls } = (() => {
      const calls: string[] = [];
      const fetchBundle: BundleFetch = (url) => {
        calls.push(url);
        return new Promise(() => {});
      };
      return { fetchBundle, calls };
    })();
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(GROUP), joinNotice(ESTABLISHED)], type: "notify" });
    t.sock.emit("messages.upsert", {
      messages: [carrier(bundle, GROUP), carrier(bundle, ESTABLISHED, "AC0F00000000000000B9")],
      type: "notify",
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(t.join().at(-1)).toBe(
      `[baileys][join-history] ${ESTABLISHED}: bundle AC0F00000000000000B9 refused: another bundle is being read (one at a time); it is not downloaded`,
    );
  });

  it("gives a failed read no second bundle", async () => {
    const { bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(null, { status: 500 });
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    t.sock.emit("messages.upsert", { messages: [carrier(bundle, GROUP, "AC0F00000000000000B2")], type: "notify" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(t.join().at(-1)).toContain("bundle AC0F00000000000000B2 ignored");
  });
});

describe("a removal and re-add inside the window (M1)", () => {
  const removal = { id: GROUP, author: ADDER_LID, participants: [{ id: FAKE_ME_LID }], action: "remove" };

  it("add, history read, remove, re-add: the second join's history is read too, with no wait", async () => {
    const first = synthetic();
    const second = synthetic([old("0101", "new chat after the re-add", { participant: BOB_PN, ts: JOINED + 150 })]);
    let serve = first.enc;
    const calls: string[] = [];
    const t = await opened(async (url) => {
      calls.push(url);
      return new Response(new Uint8Array(serve), { status: 200 });
    });

    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(first.bundle)], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toHaveLength(5);

    t.advance(2 * 60 * 1000);
    t.sock.emit("group-participants.update", removal);
    await flush();

    t.advance(60 * 1000);
    serve = second.enc;
    t.sock.emit("messages.upsert", {
      messages: [joinNotice(GROUP, JOINED + 180), carrier(second.bundle, GROUP, "AC0F00000000000000C1")],
      type: "notify",
    });
    await flush();
    expect(calls).toHaveLength(2);
    const out = await t.collect(GROUP, SELF_IDS);
    expect(out.map((m) => m.text)).toEqual(["new chat after the re-add"]);
    expect(t.waited).toEqual([]);
  });

  it("a removal alone closes the gate", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "notify" });
    await flush();
    t.sock.emit("group-participants.update", removal);
    await flush();
    t.sock.emit("messages.upsert", { messages: [carrier(bundle)], type: "notify" });
    await flush();
    expect(calls).toEqual([]);
  });
});

describe("a bundle that lands after the flow stopped waiting (M2)", () => {
  it("is still read, kept and logged as late, and handed over if the flow asks again", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "notify" });
    await flush();
    expect(await t.collect(GROUP, SELF_IDS)).toEqual([]);
    expect(t.waited).toEqual([10_000]);

    t.sock.emit("messages.upsert", { messages: [carrier(bundle)], type: "notify" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(t.join().at(-1)).toBe(
      `[baileys][join-history] ${GROUP}: bundle AC0F00000000000000B1: read AFTER the bot-added flow had stopped waiting ` +
        "and posted without it. It is kept until this join's window closes and handed over only if the flow asks again; " +
        "it is NOT sent to the server by itself",
    );
    expect(await t.collect(GROUP, SELF_IDS)).toHaveLength(5);
  });
});

describe("a group the bot already serves (L1)", () => {
  it("never has a bundle downloaded, even straight after a re-add", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.driver.ignoreJoinHistoryWhen!((gid) => gid === GROUP);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle), notice()], type: "notify" });
    await flush();
    expect(calls).toEqual([]);
    expect(t.join().at(-1)).toBe(
      `[baileys][join-history] ${GROUP}: bundle AC0F00000000000000B1 ignored: this group is already one of our clubs, so it is not downloaded`,
    );
    // And the notice did not buy a 25 s wait.
    const cap = await t.driver.joinHistory!(GROUP, SELF_IDS);
    expect(cap).toEqual({ outcome: "none", messages: [] });
    expect(t.waited).toEqual([10_000]);
  });

  it("does not download when the check itself throws", async () => {
    const { enc, bundle } = synthetic();
    const { fetchBundle, calls } = servingFetch(enc);
    const t = await opened(fetchBundle);
    t.driver.ignoreJoinHistoryWhen!(() => {
      throw new Error("the club list is not loaded");
    });
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    expect(calls).toEqual([]);
  });
});

describe("one bad row does not cost the capture (L2)", () => {
  it("drops a message whose timestamp is not a date and keeps the rest", async () => {
    const { enc, bundle } = synthetic([
      old("0201", "fine before", { participant: BOB_PN, ts: JOINED - 30 }),
      old("0202", "stamped in the year 300000", { participant: BOB_PN, ts: 9_000_000_000_000 }),
      old("0203", "stamped in 1970", { participant: BOB_PN, ts: 5 }),
      old("0204", "fine after", { participant: BOB_PN, ts: JOINED - 10 }),
    ]);
    const t = await opened(servingFetch(enc).fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    const out = await t.collect(GROUP, SELF_IDS);
    expect(out.map((m) => m.text)).toEqual(["fine before", "fine after"]);
    expect(t.join().at(-1)).toContain("left out: 0 of our own, 0 with no author, 2 with an unusable date");
  });

  it("forgets nothing when the hand-over fails: the next ask still gets it", async () => {
    const { enc, bundle } = synthetic();
    const t = await opened(servingFetch(enc).fetchBundle);
    t.sock.emit("messages.upsert", { messages: [joinNotice(), carrier(bundle)], type: "notify" });
    await flush();
    const selfIdsThatThrow = new Proxy([] as string[], {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) throw new Error("boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(await t.driver.joinHistory!(GROUP, selfIdsThatThrow)).toEqual({ outcome: "failed", messages: [] });
    expect(await t.collect(GROUP, SELF_IDS)).toHaveLength(5);
  });
});
