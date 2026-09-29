import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import {
  createUndecryptableTracker,
  isCiphertextStub,
  UNDECRYPTABLE_GRACE_MS,
  withStubAuthor,
  type UndecryptableEntry,
} from "./undecryptable.js";
import { manualScheduler } from "./fake-socket.js";

const GROUP = "447525334985-1607872139@g.us";

function stub(id: string, reason = "No session found to decrypt message"): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id, participant: "89485761081551:59@lid" },
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    messageStubParameters: [reason],
    messageTimestamp: 1_790_000_000,
  } as WAMessage;
}

function setup() {
  let clock = 1_000_000;
  const scheduler = manualScheduler();
  const lost: Array<{ id: string; reason: string; sender: string | null }> = [];
  const tracker = createUndecryptableTracker({
    now: () => clock,
    schedule: scheduler.schedule,
    onUnrecovered: (e) => lost.push({ id: e.id, reason: e.reason, sender: e.sender }),
  });
  return { tracker, scheduler, lost, advance: (ms: number) => (clock += ms) };
}

describe("isCiphertextStub", () => {
  it("is true for Baileys' failed-decrypt placeholder (stub type 2, no content)", () => {
    expect(isCiphertextStub(stub("A"))).toBe(true);
  });

  it("is false for a real message, and for other system notices", () => {
    const text = { key: { remoteJid: GROUP, id: "B" }, message: { conversation: "in" } } as WAMessage;
    const add = {
      key: { remoteJid: GROUP, id: "C" },
      messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
    } as WAMessage;
    expect(isCiphertextStub(text)).toBe(false);
    expect(isCiphertextStub(add)).toBe(false);
    expect(isCiphertextStub(null as unknown as WAMessage)).toBe(false);
  });
});

describe("the undecryptable tracker", () => {
  it("holds a stub as pending, with the reason Baileys gave, and arms one timer", () => {
    const t = setup();
    const entry = t.tracker.noteStub(stub("A"), "notify");
    expect(entry).toMatchObject({ id: "A", chat: GROUP, reason: "No session found to decrypt message" });
    expect(entry?.sender).toBe("89485761081551:59@lid");
    expect(t.tracker.pendingCount()).toBe(1);
    expect(t.scheduler.delays()).toEqual([UNDECRYPTABLE_GRACE_MS]);
  });

  it("a decrypted copy resolves it, says how long it waited, and disarms the timer", async () => {
    const t = setup();
    t.tracker.noteStub(stub("A"), "notify");
    t.advance(4_000);
    const r = t.tracker.resolve("A");
    expect(r).toMatchObject({ late: false, waitedMs: 4_000 });
    expect(t.tracker.pendingCount()).toBe(0);
    await t.scheduler.runAll();
    expect(t.lost).toEqual([]);
  });

  it("an id that was never a stub resolves to null (an ordinary message)", () => {
    const t = setup();
    expect(t.tracker.resolve("NEVER")).toBeNull();
  });

  it("a stub never recovered is reported once, after the grace period", async () => {
    const t = setup();
    t.tracker.noteStub(stub("A"), "notify");
    await t.scheduler.runAll();
    expect(t.lost).toEqual([
      { id: "A", reason: "No session found to decrypt message", sender: "89485761081551:59@lid" },
    ]);
    expect(t.tracker.pendingCount()).toBe(0);
  });

  it("a copy that arrives after the alert still resolves, marked late", async () => {
    const t = setup();
    t.tracker.noteStub(stub("A"), "notify");
    await t.scheduler.runAll();
    const r = t.tracker.resolve("A");
    expect(r?.late).toBe(true);
    // And only once.
    expect(t.tracker.resolve("A")).toBeNull();
  });

  it("a repeated stub for the same id keeps the first sighting and does not arm a second timer", () => {
    const t = setup();
    t.tracker.noteStub(stub("A"), "notify");
    t.advance(1_000);
    const again = t.tracker.noteStub(stub("A"), "append");
    expect(again?.repeat).toBe(true);
    expect(t.scheduler.delays()).toHaveLength(1);
  });

  it("a stub for an id already delivered is ignored: a failed retry copy is not a loss", async () => {
    const t = setup();
    t.tracker.delivered("A");
    expect(t.tracker.noteStub(stub("A"), "notify")).toBeNull();
    await t.scheduler.runAll();
    expect(t.lost).toEqual([]);
  });

  it("is bounded: the oldest pending entry is dropped (and its timer cancelled) past the cap", async () => {
    let clock = 0;
    const scheduler = manualScheduler();
    const lost: string[] = [];
    const tracker = createUndecryptableTracker({
      now: () => clock++,
      schedule: scheduler.schedule,
      onUnrecovered: (e) => lost.push(e.id),
      max: 2,
    });
    tracker.noteStub(stub("A"), "notify");
    tracker.noteStub(stub("B"), "notify");
    tracker.noteStub(stub("C"), "notify");
    expect(tracker.pendingCount()).toBe(2);
    await scheduler.runAll();
    expect(lost).toEqual(["B", "C"]);
  });
});

describe("withStubAuthor: a recovered copy's author, from its stub", () => {
  const entry: UndecryptableEntry = {
    id: "A",
    chat: GROUP,
    sender: "89485761081551:59@lid",
    senderAlt: "447525334985@s.whatsapp.net",
    pushName: "Kaan",
    reason: "No session found to decrypt message",
    firstSeenAt: 0,
    upsertType: "notify",
  };
  const copy = (key: Record<string, unknown>, pushName?: string): WAMessage =>
    ({ key: { remoteJid: GROUP, fromMe: false, id: "A", ...key }, message: { conversation: "x" }, pushName }) as WAMessage;

  it("fills a missing participant, participantAlt and pushName from the stub", () => {
    const out = withStubAuthor(copy({}), entry);
    expect(out.key.participant).toBe("89485761081551:59@lid");
    expect(out.key.participantAlt).toBe("447525334985@s.whatsapp.net");
    expect(out.pushName).toBe("Kaan");
  });

  it("never overrides what the copy itself says", () => {
    const own = copy({ participant: "447700900123@s.whatsapp.net" }, "Zed");
    const out = withStubAuthor(own, entry);
    expect(out.key.participant).toBe("447700900123@s.whatsapp.net");
    expect(out.pushName).toBe("Zed");
  });

  it("is a no-op outside a group, and for a stub from another chat", () => {
    const dm = { ...copy({}), key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false, id: "A" } } as WAMessage;
    expect(withStubAuthor(dm, entry)).toBe(dm);
    const elsewhere = { ...copy({}), key: { remoteJid: "999-1@g.us", fromMe: false, id: "A" } } as WAMessage;
    expect(withStubAuthor(elsewhere, entry)).toBe(elsewhere);
  });

  it("the tracker records the stub's alt address and pushName", () => {
    const t = setup();
    const m = stub("Z");
    (m.key as Record<string, unknown>).participantAlt = "447525334985@s.whatsapp.net";
    (m as { pushName?: string }).pushName = "Kaan";
    const e = t.tracker.noteStub(m, "notify");
    expect(e).toMatchObject({ senderAlt: "447525334985@s.whatsapp.net", pushName: "Kaan" });
  });
});
