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

const dm = (over: Record<string, unknown> = {}) =>
  handleConnectDm({
    text: "Connect Riverside FC, code 7KQ2",
    phone: ORGANISER,
    waMessageId: "wa-1",
    now: NOW,
    ...over,
  } as Parameters<typeof handleConnectDm>[0]);

const queued = () => dbMock.platformJob.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation((fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
  dbMock.clubConnect.findUnique.mockResolvedValue(null);
  dbMock.clubConnect.findMany.mockResolvedValue([connectRow()]);
  dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubConnect.count.mockResolvedValue(0);
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "pj-1", ...data }));
  dbMock.user.findFirst.mockResolvedValue({ id: "u-1" });
  dbMock.user.findUnique.mockResolvedValue({ name: "Ali Demir" });
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
