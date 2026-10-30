/**
 * Self-join slice 5: the connect DM handler against a mocked database
 * (plan 5.3, 5.4 and cap 6). Deterministic: no model is reachable from
 * here, and the global unit-model guard would fail the run if one were.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const m = {
    $executeRaw: vi.fn(),
    clubConnect: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    platformJob: { findFirst: vi.fn(), create: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation((fn: (tx: typeof m) => unknown) => fn(m));
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { handleConnectDm } from "../connect-dm";
import { MAX_GROUP_LINKS_PER_DAY, ADD_WINDOW_MS } from "../connect-dm-rules";

const NOW = new Date("2026-09-29T12:00:00Z");
const MIN = 60_000;
const ORGANISER = "447700900123";

interface Row {
  id: string;
  code: string;
  status: string;
  phone: string;
  issuedAt: Date;
  expiresAt: Date;
  addWindowEndsAt: Date | null;
  dmLid: string | null;
  lastMismatchAt: Date | null;
  userId: string;
  org: { name: string; language: string; approvalStatus: string };
}

const connectRow = (over: Partial<Row> = {}): Row => ({
  id: "cc-1",
  code: "7KQ2",
  status: "issued",
  phone: ORGANISER,
  issuedAt: new Date(NOW.getTime() - 5 * MIN),
  expiresAt: new Date(NOW.getTime() + 55 * MIN),
  addWindowEndsAt: null,
  dmLid: null,
  lastMismatchAt: null,
  userId: "u-organiser",
  org: { name: "Riverside FC", language: "en", approvalStatus: "draft" },
  ...over,
});

/** The one DM reader (dm-reader.ts), stubbed: what the model said the DM
 *  asks. Consulted only for a code that names no request. */
const read = vi.fn(async (_userId: string) => ({ intent: "connect_club", confidence: 0.95 }));

const dm = (over: Record<string, unknown> = {}) =>
  handleConnectDm({
    text: "Connect Riverside FC, code 7KQ2",
    phone: ORGANISER,
    waMessageId: "wa-1",
    now: NOW,
    read,
    ...over,
  } as Parameters<typeof handleConnectDm>[0]);

const queued = () => dbMock.platformJob.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation((fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
  dbMock.clubConnect.findUnique.mockResolvedValue(null);
  dbMock.clubConnect.findMany.mockResolvedValue([connectRow()]);
  dbMock.clubConnect.findFirst.mockResolvedValue(null);
  dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubConnect.count.mockResolvedValue(0);
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "pj-1", ...data }));
  dbMock.user.findFirst.mockResolvedValue({ id: "u-1" });
  dbMock.user.findUnique.mockResolvedValue({ name: "Ali Demir" });
  read.mockImplementation(async () => ({ intent: "connect_club", confidence: 0.95 }));
});

describe("falls through (returns null) without touching the database", () => {
  it("no code in the message", async () => {
    expect(await dm({ text: "IN" })).toBeNull();
    expect(await dm({ text: "Paid" })).toBeNull();
    expect(dbMock.clubConnect.findMany).not.toHaveBeenCalled();
    expect(dbMock.clubConnect.findUnique).not.toHaveBeenCalled();
  });

  it("a code that names no connect request (unknown code): silence, the existing DM handling runs", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    expect(await dm({ text: "what's the code then" })).toBeNull();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    // No open request for this phone: the model is never asked.
    expect(read).not.toHaveBeenCalled();
  });
});

describe("a connect message whose code names no request (the wrong-code reply)", () => {
  const WRONG = "Connect Riverside FC, code 7KQ3";
  const openRequest = (over: Record<string, unknown> = {}) => ({
    id: "cc-1",
    phone: ORGANISER,
    status: "issued",
    expiresAt: new Date(NOW.getTime() + 55 * MIN),
    addWindowEndsAt: null,
    userId: "u-organiser",
    org: { name: "Riverside FC", language: "en" },
    ...over,
  });
  beforeEach(() => {
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.clubConnect.findFirst.mockResolvedValue(openRequest());
  });

  it("the organiser with an open request is told once, on their sign-up phone, and the DM stops here", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dm({ text: WRONG });
    expect(out).toEqual({ handled: "connect-dm", result: "wrong-code", replied: true });

    // Only an open request on a draft club, for one of the sender's phones.
    expect(dbMock.clubConnect.findFirst.mock.calls[0][0].where).toEqual({
      phone: { in: [ORGANISER] },
      status: "issued",
      expiresAt: { gt: NOW },
      org: { approvalStatus: "draft" },
    });
    expect(queued()).toEqual([
      expect.objectContaining({
        kind: "dm",
        phone: ORGANISER,
        purpose: "connect-reply",
        refId: `cc-1:wrong-code:${NOW.getTime()}`,
        status: "queued",
      }),
    ]);
    expect(queued()[0].text).toBe(
      "The code in your message doesn't match the one for Riverside FC. Go back to your club page on matchtime.ai, press Add MatchTime to WhatsApp again, and send the message exactly as it opens.",
    );
    // The DM reader was asked once, about the organiser of that request.
    expect(read.mock.calls).toEqual([["u-organiser"]]);
    // Nothing is written to the request, and no code is ever sent back.
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(queued()[0].text).not.toContain("7KQ");

    // The log line: ids and the result, never text, names or numbers.
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[connect-dm]"));
    expect(lines).toEqual(["[connect-dm] cc-1 result=wrong-code replied=true"]);
    log.mockRestore();
  });

  it("in Turkish for a Turkish club", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(openRequest({ org: { name: "Kartallar", language: "tr" } }));
    await dm({ text: "Kartallar kulübünü bağla, kod 7KQ3" });
    expect(queued()[0].text).toBe(
      "Mesajınızdaki kod Kartallar için verilen kodla eşleşmiyor. matchtime.ai'de kulüp sayfanıza dönün, MatchTime'ı WhatsApp'a ekle düğmesine tekrar dokunun ve açılan mesajı hiç değiştirmeden gönderin.",
    );
    expect(queued()[0].text).not.toMatch(/[–—]/);
  });

  it("matches the envelope's alt phone, and replies to the request's phone", async () => {
    const out = await dm({ text: WRONG, phone: "", senderAltPhone: "+44 7700 900123" });
    expect(out).toMatchObject({ result: "wrong-code", replied: true });
    expect(queued()[0].phone).toBe(ORGANISER);
  });

  it("a second wrong code inside ten minutes: handled, nothing queued", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj-earlier" });
    const out = await dm({ text: "Connect Riverside FC, code 8KQ3", waMessageId: "wa-2" });
    expect(out).toEqual({ handled: "connect-dm", result: "wrong-code-throttled", replied: false });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.findFirst).toHaveBeenCalledWith({
      where: {
        purpose: "connect-reply",
        refId: { startsWith: "cc-1:wrong-code:" },
        createdAt: { gt: new Date(NOW.getTime() - 10 * MIN) },
      },
      select: { id: true },
    });
  });

  it("a stranger (no open request for the number): null, nothing queued, the DM falls through", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    expect(await dm({ text: WRONG, phone: "447700900999" })).toBeNull();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.findFirst).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("the sender's phone is hidden (LID only): null, and nobody is looked up", async () => {
    expect(await dm({ text: WRONG, phone: "", senderLid: "123456789012345@lid" })).toBeNull();
    expect(await dm({ text: WRONG, phone: null, senderAltPhone: "not a phone" })).toBeNull();
    expect(dbMock.clubConnect.findFirst).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("a request that has run out, whatever the query returned: null", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(openRequest({ expiresAt: new Date(NOW.getTime() - MIN) }));
    expect(await dm({ text: WRONG })).toBeNull();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("ordinary chat with a code-shaped word, from an organiser with an open request: the reader says it is not the connect message, null", async () => {
    for (const intent of ["question", "other", "go_live"]) {
      read.mockResolvedValueOnce({ intent, confidence: 0.95 });
      expect(await dm({ text: "what's the code then" }), intent).toBeNull();
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("no word list decides it: the connect message in any words is answered when the reader says so, and nothing is answered without a reader", async () => {
    // No "connect" or "bağla" in it: the old verb gate would have stayed silent.
    expect(await dm({ text: "hi, here's my code 7KQ3, can you link my group?" })).toMatchObject({ result: "wrong-code", replied: true });
    vi.clearAllMocks();
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.clubConnect.findFirst.mockResolvedValue(openRequest());
    // The verb is there, but there is no reader to ask: silence, fail closed.
    expect(await dm({ text: WRONG, read: undefined })).toBeNull();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("a refused platform DM (rule 12) is logged, never thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    dbMock.user.findFirst.mockResolvedValue(null);
    expect(await dm({ text: WRONG })).toMatchObject({ handled: "connect-dm", result: "wrong-code", replied: false });
    err.mockRestore();
  });

  it("the correct code never reaches this branch", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow()]);
    expect(await dm()).toMatchObject({ result: "verified", replied: true });
    expect(dbMock.clubConnect.findFirst).not.toHaveBeenCalled();
    expect(queued().map((q) => q.refId)).toEqual(["cc-1:connected"]);
  });
});

describe("the organiser's connect DM, from the number they signed up with", () => {
  it("binds the request to this chat and records dmAt, dmPhone, dmLid, dmPhoneMatched", async () => {
    const out = await dm({ senderLid: "123456789012345@lid" });
    expect(out).toMatchObject({ handled: "connect-dm", result: "verified", replied: true });

    const verify = dbMock.clubConnect.updateMany.mock.calls.find((c) => c[0].data.status === "dm_verified");
    expect(verify?.[0]).toEqual({
      where: { id: "cc-1", status: "issued" },
      data: {
        status: "dm_verified",
        dmAt: NOW,
        dmPhone: ORGANISER,
        // The LID-to-phone pair, kept for slice 6 to resolve the adder.
        dmLid: "123456789012345",
        dmPhoneMatched: true,
        dmWaMessageId: "wa-1",
        addWindowEndsAt: new Date(NOW.getTime() + ADD_WINDOW_MS),
        siteCapAt: null,
      },
    });
  });

  it("replies once, through the platform channel, to the sign-up phone, in the club's language", async () => {
    await dm();
    expect(queued()).toEqual([
      expect.objectContaining({
        kind: "dm",
        phone: ORGANISER,
        purpose: "connect-reply",
        refId: "cc-1:connected",
        status: "queued",
      }),
    ]);
    const text = queued()[0].text as string;
    expect(text).toContain("Hi Ali, got it: Riverside FC is connected to this chat.");
    expect(text).toContain("Save this number as a contact called MatchTime");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("in Turkish for a Turkish club", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([
      connectRow({ org: { name: "Kartallar", language: "tr", approvalStatus: "draft" } }),
    ]);
    await dm({ text: "Kartallar kulübünü bağla, kod 7KQ2" });
    expect(queued()[0].text).toContain("Merhaba Ali, tamamdır: Kartallar bu sohbete bağlandı.");
    expect(queued()[0].text).toContain("MatchTime adıyla rehberinize kaydedin");
  });

  it("matches a phone given in any spelling, and the envelope's alt phone", async () => {
    expect(await dm({ phone: "+44 7700 900123" })).toMatchObject({ result: "verified" });
    vi.clearAllMocks();
    dbMock.$transaction.mockImplementation((fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow()]);
    dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
    dbMock.clubConnect.count.mockResolvedValue(0);
    dbMock.platformJob.findFirst.mockResolvedValue(null);
    dbMock.platformJob.create.mockResolvedValue({ id: "pj" });
    dbMock.user.findFirst.mockResolvedValue({ id: "u-1" });
    expect(await dm({ phone: "", senderAltPhone: ORGANISER, senderLid: "999999999" })).toMatchObject({
      result: "verified",
    });
  });

  it("phone hidden, LID present: verified, bound to the LID, flagged as not confirmed", async () => {
    const out = await dm({ phone: "", senderLid: "123456789012345@lid" });
    expect(out).toMatchObject({ result: "verified" });
    const verify = dbMock.clubConnect.updateMany.mock.calls.find((c) => c[0].data.status === "dm_verified");
    expect(verify?.[0].data).toMatchObject({ dmPhone: null, dmLid: "123456789012345", dmPhoneMatched: null });
    // The reply goes to the verified sign-up phone, never a guessed one.
    expect(queued()[0].phone).toBe(ORGANISER);
  });

  it("the same WhatsApp message forwarded twice is handled once", async () => {
    dbMock.clubConnect.findUnique.mockResolvedValue({ id: "cc-1" });
    expect(await dm()).toMatchObject({ handled: "connect-dm", result: "duplicate", replied: false });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("a lost race (someone else verified it first) sends nothing", async () => {
    dbMock.clubConnect.updateMany.mockResolvedValue({ count: 0 });
    expect(await dm()).toMatchObject({ result: "race-lost", replied: false });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("picks the live request when an old expired one shares the code", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([
      connectRow({ id: "cc-old", status: "expired", issuedAt: new Date(NOW.getTime() - 3 * 24 * 60 * MIN) }),
      connectRow({ id: "cc-new" }),
    ]);
    await dm();
    expect(dbMock.clubConnect.updateMany.mock.calls.some((c) => c[0].where.id === "cc-new")).toBe(true);
  });

  it("a club named 'Kod Team' still resolves to the real code", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow()]);
    await dm({ text: "Kod Team kulübünü bağla, kod 7KQ2" });
    expect(dbMock.clubConnect.findMany.mock.calls[0][0].where).toEqual({ code: { in: ["7KQ2", "TEAM"] } });
  });
});

describe("cap 6: five new groups a day across the site", () => {
  it("the sixth organiser's code stays issued, the card is told, and they get one line", async () => {
    dbMock.clubConnect.count.mockResolvedValue(MAX_GROUP_LINKS_PER_DAY);
    const out = await dm();
    expect(out).toMatchObject({ result: "site-cap", replied: true });
    const calls = dbMock.clubConnect.updateMany.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.data.status === "dm_verified")).toBe(false);
    expect(calls).toContainEqual({ where: { id: "cc-1", status: "issued" }, data: { siteCapAt: NOW } });
    expect(queued()[0]).toMatchObject({ refId: "cc-1:site-cap", phone: ORGANISER });
    expect(queued()[0].text).toBe("We're taking on a few new groups each day. Please try again tomorrow.");
  });

  it("counts today's connect DMs under a lock, from London midnight", async () => {
    await dm();
    expect(dbMock.$executeRaw).toHaveBeenCalled();
    const where = dbMock.clubConnect.count.mock.calls[0][0].where;
    expect(where.dmAt.gte).toEqual(new Date("2026-09-28T23:00:00Z"));
  });
});

describe("the other cases (plan 5.3)", () => {
  it("wrong phone: no reply; the masked number is recorded for the organiser's card", async () => {
    const out = await dm({ phone: "447700900999" });
    expect(out).toMatchObject({ result: "mismatch", replied: false });
    expect(dbMock.clubConnect.updateMany).toHaveBeenCalledWith({
      where: { id: "cc-1", status: "issued" },
      data: { lastMismatchAt: NOW, lastMismatchPhoneMasked: "+44 77** ***999" },
    });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("wrong phone again within the minute: throttled, nothing written", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow({ lastMismatchAt: new Date(NOW.getTime() - 10_000) })]);
    const out = await dm({ phone: "447700900999" });
    expect(out).toMatchObject({ result: "mismatch-throttled", replied: false });
    expect(dbMock.clubConnect.updateMany).not.toHaveBeenCalled();
  });

  it("expired code from the organiser: one 'expired' reply, and the row is marked expired", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow({ expiresAt: new Date(NOW.getTime() - MIN) })]);
    const out = await dm();
    expect(out).toMatchObject({ result: "expired", replied: true });
    expect(dbMock.clubConnect.updateMany).toHaveBeenCalledWith({
      where: { id: "cc-1", status: "issued" },
      data: { status: "expired" },
    });
    expect(queued()[0]).toMatchObject({ refId: "cc-1:expired" });
    expect(queued()[0].text).toBe(
      "That code has expired. Open your club on matchtime.ai and tap Add MatchTime to WhatsApp again.",
    );
  });

  it("the 'expired' reply goes once, however many times they resend", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow({ status: "superseded" })]);
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj-earlier" });
    const out = await dm();
    expect(out).toMatchObject({ result: "expired", replied: false });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.findFirst).toHaveBeenCalledWith({
      where: { purpose: "connect-reply", refId: "cc-1:expired" },
      select: { id: true },
    });
  });

  it("already verified, same sender: 'You're already connected. Now just add me to your group.'", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([
      connectRow({ status: "dm_verified", addWindowEndsAt: new Date(NOW.getTime() + 60 * MIN) }),
    ]);
    const out = await dm({ waMessageId: "wa-2" });
    expect(out).toMatchObject({ result: "already-connected", replied: true });
    expect(queued()[0].text).toBe("You're already connected. Now just add me to your group.");
  });

  it("a used code (group linked): handled, silent", async () => {
    dbMock.clubConnect.findMany.mockResolvedValue([connectRow({ status: "group_linked" })]);
    expect(await dm()).toMatchObject({ handled: "connect-dm", result: "code-group_linked", replied: false });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("a refused platform DM (rule 12) is logged, never thrown", async () => {
    dbMock.user.findFirst.mockResolvedValue(null);
    const out = await dm();
    expect(out).toMatchObject({ result: "verified", replied: false });
  });
});
