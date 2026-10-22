/**
 * D5b, REVISED 2026-10-22 (Kemal): the own game is the default.
 *
 * MT Test, 08:40 UTC: Sait wrote a plain "In" in his own players' group
 * shortly after MatchTime had posted FNF's ask there. The engine recorded
 * nothing and DMed him "Was your IN in the MT Test group for FNF's game?";
 * he never acted, so his IN for MT Test's own game was lost.
 *
 * Now his IN counts for his own game (the engine and the batch), and then,
 * here in `partner-guest-dm.ts`:
 *
 *   - `askPartnerAfterOwnInByDm`: ONE DM, once per person per ask (the same
 *     claim as every other "which game?"), saying he is IN for his own game
 *     and asking whether he meant the partner club's instead, with the
 *     ask's tap-to-DM link. It leaves a marker naming his own match.
 *   - `handleCodedPartnerAskDm`: when he taps and is registered for the
 *     partner club's game, the marker's own-game IN is undone automatically
 *     through the shared out-of-band path (his ack, the group's line), and
 *     that own IN never counts as an overlap against the partner's game.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  attendance: { findUnique: vi.fn(), findFirst: vi.fn() },
  match: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  partnerAsk: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  sentNotification: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const resolver = vi.hoisted(() => ({ resolveDmSelfAttendance: vi.fn() }));
vi.mock("../dm-self-attendance", () => resolver);
vi.mock("../dm-registration-target", () => ({ findDmRegistrationTarget: vi.fn() }));
const oob = vi.hoisted(() => ({ applyOutOfBandSelfAttendance: vi.fn() }));
vi.mock("../out-of-band-self-attendance", () => oob);
const guest = vi.hoisted(() => ({ withdrawGuest: vi.fn(), handlePartnerVolunteer: vi.fn() }));
vi.mock("../partner-guest", () => guest);
vi.mock("../ai-budget", () => ({ withOrgAiBudget: (_o: string, f: () => unknown) => f() }));
vi.mock("../match-availability-context", () => ({ loadMatchAvailabilityFacts: vi.fn() }));
vi.mock("../club-connect", () => ({ matchtimeWaNumber: () => "447700900555" }));

import { askPartnerAfterOwnInByDm, handleCodedPartnerAskDm } from "../partner-guest-dm";
import { askRefCode } from "../partner-ask-ref";

const NOW = new Date("2026-10-22T09:00:00Z");
// FNF's game, Fri 23 Oct 20:30 London (19:30Z, BST).
const FNF_KICKOFF = new Date("2026-10-23T19:30:00Z");
// MT Test's own game, Wed 28 Oct 20:30 London (20:30Z, GMT).
const OWN_KICKOFF = new Date("2026-10-28T20:30:00Z");
const ASK = { id: "ask1", askerOrgId: "fnf", partnerOrgId: "mt", matchId: "m-fnf", postedAt: new Date(NOW.getTime() - 20 * 60_000), match: { date: FNF_KICKOFF } };
const REF = askRefCode("ask1");
const LINK = `https://wa.me/447700900555?text=${encodeURIComponent(`IN (ref ${REF})`)}`;
const OWN_MATCH = { id: "m-own", date: OWN_KICKOFF, activity: { name: "Wednesday 7s", orgId: "mt" } };

const dms = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data).filter((d) => d.kind === "dm");
let lang = "en";

beforeEach(() => {
  vi.clearAllMocks();
  lang = "en";
  dbMock.partnerAsk.findUnique.mockResolvedValue(ASK);
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : { id: "mt", name: "MT Test", language: lang }),
  );
  dbMock.match.findUnique.mockResolvedValue(OWN_MATCH);
  dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900111" });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.sentNotification.findFirst.mockResolvedValue(null);
  dbMock.sentNotification.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.botJob.create.mockResolvedValue({ id: "j" });
  resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "in", via: "fast-path" });
  guest.handlePartnerVolunteer.mockResolvedValue({ ok: true, outcome: "registered-in", dmText: "Thanks", dmQueued: true });
  oob.applyOutOfBandSelfAttendance.mockResolvedValue({ status: "DROPPED", before: "CONFIRMED", failed: false, ack: "", announced: true });
});

describe("askPartnerAfterOwnInByDm: after his own IN landed, one DM about the partner's game", () => {
  const call = () => askPartnerAfterOwnInByDm({ askId: "ask1", userId: "sait", matchId: "m-own" });

  it("says he is IN for his own game, asks about FNF's, with the link; claimed once, marker left", async () => {
    expect(await call()).toBe(true);
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:which:sait", kind: "xask-which" } });
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:ownin:sait", kind: "xask-ownin", matchId: "m-own", targetUser: "sait" } });
    const [dm] = dms();
    expect(dm).toMatchObject({ orgId: "mt", phone: "447700900111", priority: 1 });
    expect(dm.text).toBe(
      `I've put you IN for *MT Test*'s game, Wed 28 Oct, 20:30. Did you mean *FNF*'s game, Fri 23 Oct, 20:30, instead? Then tap here and I'll move you over: ${LINK}.`,
    );
    expect(dm.text).not.toMatch(/—|–/);
  });

  it("on his own club's bench: says bench, never IN", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "BENCH" });
    await call();
    expect(dms()[0].text).toContain("I've put you on the bench for *MT Test*'s game");
    expect(dms()[0].text).not.toMatch(/waiting list/i);
  });

  it("in Turkish, his club's language", async () => {
    lang = "tr";
    await call();
    const text = dms()[0].text;
    expect(text).toContain("Seni *MT Test* maçının kadrosuna yazdım");
    expect(text).toContain("*FNF*");
    expect(text).toContain("buraya dokun, seni o maça geçireyim: https://wa.me/447700900555?text=");
    expect(text).toContain("28 Ekim Çarşamba 20:30");
    expect(text).not.toMatch(/—|–/);
  });

  it("at most once per player per ask: claim taken, nothing sent, no marker", async () => {
    dbMock.sentNotification.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await call()).toBe(false);
    expect(dms()).toEqual([]);
    expect(dbMock.sentNotification.create).toHaveBeenCalledTimes(1);
  });

  it("no number to DM him: nothing claimed, nothing said; his IN stands", async () => {
    dbMock.user.findUnique.mockResolvedValue({ phoneNumber: null });
    expect(await call()).toBe(false);
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
    expect(dms()).toEqual([]);
  });

  it("no longer on his own game (dropped since): no DM claiming he is IN", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "DROPPED" });
    expect(await call()).toBe(false);
    expect(dms()).toEqual([]);
  });
});

describe("handleCodedPartnerAskDm: tapping the link moves him over", () => {
  const call = (text = `IN (ref ${REF})`) =>
    handleCodedPartnerAskDm({ askId: "ask1", userId: "sait", userName: "Sait", text, replyPhone: "447700900111", waMessageId: "wa-dm-1", now: NOW });
  const marker = { key: "xask:ask1:ownin:sait", matchId: "m-own" };

  it("registered for FNF: his own-game IN is undone automatically, through the shared out-of-band path", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(marker);
    await call();
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(expect.objectContaining({ askId: "ask1", userId: "sait", polarity: "in", exceptOwnMatchId: "m-own" }), NOW);
    expect(oob.applyOutOfBandSelfAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "sait", matchId: "m-own", orgId: "mt", decision: "out", source: "dm", replyPhone: "447700900111", matchName: "Wednesday 7s", matchWhen: "Wed 28 Oct, 20:30", lang: "en" }),
    );
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "xask:ask1:ownin:sait" } });
  });

  it("not registered for FNF (closed, full, refused): his own IN stands", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(marker);
    guest.handlePartnerVolunteer.mockResolvedValue({ ok: true, outcome: "closed", dmText: "closed", dmQueued: true });
    await call();
    expect(oob.applyOutOfBandSelfAttendance).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.deleteMany).not.toHaveBeenCalled();
  });

  it("no longer on his own game by then: nothing to undo", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(marker);
    dbMock.attendance.findUnique.mockResolvedValue({ status: "DROPPED" });
    await call();
    expect(oob.applyOutOfBandSelfAttendance).not.toHaveBeenCalled();
  });

  it("an OUT by code never touches his own game", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(marker);
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "out", via: "llm" });
    guest.handlePartnerVolunteer.mockResolvedValue({ ok: true, outcome: "withdrawn", dmText: "x", dmQueued: true });
    await call(`OUT (ref ${REF})`);
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(expect.not.objectContaining({ exceptOwnMatchId: expect.anything() }), NOW);
    expect(oob.applyOutOfBandSelfAttendance).not.toHaveBeenCalled();
  });

  it("no marker (he was never defaulted): the coded path is unchanged", async () => {
    await call();
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(
      { askId: "ask1", userId: "sait", name: "Sait", polarity: "in", sourceMessageId: "wa-dm-1", replyPhone: "447700900111" },
      NOW,
    );
    expect(oob.applyOutOfBandSelfAttendance).not.toHaveBeenCalled();
  });
});
