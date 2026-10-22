/**
 * VOLUNTEERING BY DM (cross-club ask, Kemal 2026-10-21).
 *
 * The ask in the partner group carries a tap-to-DM link with the ask's
 * code. Here, the DM side of it in `partner-guest-dm.ts`:
 *
 *   - `findAskByRef`: the code is a lookup among recently posted asks,
 *     never a guess (two asks sharing a code: no ask);
 *   - `handleCodedPartnerAskDm`: IN or OUT is the DM resolver's decision on
 *     his text with the code taken out; the volunteer writer does the rest
 *     and answers him by DM; an unreadable DM gets the link again;
 *   - `askAboutOpenPartnerAsk`: a private IN WITHOUT a code while an ask to
 *     his club is open gets ONE plain question with the link, and nothing
 *     is written, on the same state rule as D5b in the group;
 *   - `askPartnerWhichByDm`: D5b's question, by DM instead of in the group.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  attendance: { findUnique: vi.fn(), findFirst: vi.fn() },
  match: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  partnerAsk: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findUnique: vi.fn(), updateMany: vi.fn() },
  sentNotification: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const resolver = vi.hoisted(() => ({ resolveDmSelfAttendance: vi.fn() }));
vi.mock("../dm-self-attendance", () => resolver);
vi.mock("../dm-registration-target", () => ({ findDmRegistrationTarget: vi.fn() }));
vi.mock("../out-of-band-self-attendance", () => ({ applyOutOfBandSelfAttendance: vi.fn() }));
const guest = vi.hoisted(() => ({ withdrawGuest: vi.fn(), handlePartnerVolunteer: vi.fn() }));
vi.mock("../partner-guest", () => guest);
vi.mock("../ai-budget", () => ({ withOrgAiBudget: (_o: string, f: () => unknown) => f() }));
vi.mock("../match-availability-context", () => ({ loadMatchAvailabilityFacts: vi.fn() }));
vi.mock("../club-connect", () => ({ matchtimeWaNumber: () => "447700900555" }));
const nameReader = vi.hoisted(() => ({ readVolunteerNameReply: vi.fn() }));
vi.mock("../volunteer-name-reply", async (orig) => ({ ...(await orig<typeof import("../volunteer-name-reply")>()), ...nameReader }));

import {
  askAboutOpenPartnerAsk,
  askPartnerWhichByDm,
  findAskByRef,
  handleCodedPartnerAskDm,
  handleVolunteerNameReply,
  volunteerNameFromReply,
  VOLUNTEER_NAME_TTL_MS,
} from "../partner-guest-dm";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";
import { dayCommaTimeLabel } from "../i18n/dates";
import { askRefCode } from "../partner-ask-ref";

const NOW = new Date("2026-10-30T15:00:00Z");
const KICKOFF = new Date("2026-10-30T20:30:00Z");
const ASK = {
  id: "ask1",
  askerOrgId: "fnf",
  partnerOrgId: "sutton",
  matchId: "m-fnf",
  postedAt: new Date(NOW.getTime() - 20 * 60_000),
  match: { date: KICKOFF },
};
const REF = askRefCode("ask1");
const LINK = `https://wa.me/447700900555?text=${encodeURIComponent(`IN (ref ${REF})`)}`;

const dms = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data).filter((d) => d.kind === "dm");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.partnerAsk.findMany.mockResolvedValue([ASK]);
  dbMock.partnerAsk.findUnique.mockResolvedValue(ASK);
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : { id: "sutton", name: "Sutton FC", language: "en" }),
  );
  dbMock.membership.findMany.mockResolvedValue([{ orgId: "sutton" }]);
  dbMock.attendance.findFirst.mockResolvedValue(null);
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900111" });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.botJob.create.mockResolvedValue({ id: "j" });
  resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "in", via: "fast-path" });
  guest.handlePartnerVolunteer.mockResolvedValue({ ok: true, outcome: "registered-bench", dmText: "Thanks", dmQueued: true });
  dbMock.attendance.findUnique.mockResolvedValue(null);
  nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "other", why: "default" });
});

describe("findAskByRef", () => {
  it("the code of an ask posted in the last fortnight finds it", async () => {
    expect(await findAskByRef(`IN (ref ${REF})`, NOW)).toEqual({ askId: "ask1" });
    expect(dbMock.partnerAsk.findMany).toHaveBeenCalledWith({
      where: { postedAt: { gte: new Date(NOW.getTime() - 14 * 24 * 3600_000) } },
      select: { id: true },
    });
  });

  it("no code: no query at all", async () => {
    expect(await findAskByRef("IN", NOW)).toBeNull();
    expect(dbMock.partnerAsk.findMany).not.toHaveBeenCalled();
  });

  it("a code nobody issued, or two asks sharing it: no ask, never a guess", async () => {
    const other = REF === "ABCD" ? "BCDE" : "ABCD";
    expect(await findAskByRef(`IN (ref ${other})`, NOW)).toBeNull();
    dbMock.partnerAsk.findMany.mockResolvedValue([ASK, { ...ASK, id: "ask1" }]);
    expect(await findAskByRef(`IN (ref ${REF})`, NOW)).toBeNull();
  });
});

describe("handleCodedPartnerAskDm", () => {
  const call = (text: string) =>
    handleCodedPartnerAskDm({ askId: "ask1", userId: "ali", userName: "Ali Kaya", text, replyPhone: "447700900111", waMessageId: "wa-dm-1", now: NOW });

  it("IN with the code: the resolver reads his words WITHOUT the code, then the volunteer writer, answering him on this number", async () => {
    const r = await call(`IN (ref ${REF})`);
    expect(resolver.resolveDmSelfAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ text: "IN", hasPendingPrompt: false, context: expect.objectContaining({ clubName: "FNF", playerName: "Ali Kaya" }) }),
    );
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(
      { askId: "ask1", userId: "ali", name: "Ali Kaya", polarity: "in", sourceMessageId: "wa-dm-1", replyPhone: "447700900111" },
      NOW,
    );
    expect(r).toEqual({ handled: "xask-dm-volunteer", outcome: "registered-bench" });
  });

  it("OUT is whatever the resolver says, never a word match here", async () => {
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "out", via: "llm" });
    await call(`sorry can't make it now (ref ${REF})`);
    expect(resolver.resolveDmSelfAttendance).toHaveBeenCalledWith(expect.objectContaining({ text: "sorry can't make it now" }));
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(expect.objectContaining({ polarity: "out" }), NOW);
  });

  it("unreadable: nothing written, one DM with the link again, in his club's language", async () => {
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: null, via: "llm" });
    const r = await call(`hmm (ref ${REF})`);
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(r).toEqual({ handled: "xask-dm-unclear", outcome: "unclear" });
    expect(dms()).toEqual([expect.objectContaining({ orgId: "sutton", phone: "447700900111", text: expect.stringContaining(LINK), priority: 1 })]);
  });
});

describe("askAboutOpenPartnerAsk (a private IN with no code)", () => {
  const OWN = { matchId: "m-own", clubName: "Sutton FC" };

  it("an open ask to his club and no place in his own game: ONE question with the link, claimed once, nothing written", async () => {
    const asked = await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "in", now: NOW });
    expect(asked).toBe(true);
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:which:ali", kind: "xask-which" } });
    const [dm] = dms();
    expect(dm).toMatchObject({ orgId: "sutton", phone: "447700900111", priority: 1 });
    expect(dm.text).toContain("FNF");
    expect(dm.text).toContain(LINK);
    expect(dm.text).toContain("If it's for Sutton FC's game, send IN again.");
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
  });

  it("only asks about asks to clubs he is a live, ordinary member of, still open, that he has not answered", async () => {
    await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "in", now: NOW });
    expect(dbMock.membership.findMany).toHaveBeenCalledWith({ where: { userId: "ali", leftAt: null, guestFromOrgId: null }, select: { orgId: true } });
    expect(dbMock.partnerAsk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { partnerOrgId: { in: ["sutton"] }, status: "posted", closesAt: { gt: NOW }, NOT: { volunteerUserIds: { has: "ali" } } },
      }),
    );
  });

  it("asked once already (the claim is taken): his next IN is his own game's, as D5b", async () => {
    dbMock.sentNotification.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "in", now: NOW })).toBe(false);
    expect(dms()).toEqual([]);
  });

  it("a place in his own game already: his IN is about that game, no question", async () => {
    dbMock.attendance.findFirst.mockResolvedValue({ id: "row" });
    expect(await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "in", now: NOW })).toBe(false);
  });

  it("an ask posted over an hour ago, with a game of his own: his IN is his own game's (D5b's window)", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ ...ASK, postedAt: new Date(NOW.getTime() - 2 * 3600_000) }]);
    expect(await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "in", now: NOW })).toBe(false);
  });

  it("an OUT, or no ask open: nothing", async () => {
    expect(await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "out", now: NOW })).toBe(false);
    dbMock.partnerAsk.findMany.mockResolvedValue([]);
    expect(await askAboutOpenPartnerAsk({ userId: "ali", replyPhone: "447700900111", own: OWN, decision: "in", now: NOW })).toBe(false);
    expect(dms()).toEqual([]);
  });

  it("no game of his own: the resolver reads his DM against the ask's game; an IN gets the question, without 'send IN again'", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ ...ASK, postedAt: new Date(NOW.getTime() - 3 * 3600_000) }]);
    const asked = await askAboutOpenPartnerAsk({ userId: "ali", userName: "Ali", text: "I'm in", replyPhone: "447700900111", own: null, now: NOW });
    expect(asked).toBe(true);
    expect(resolver.resolveDmSelfAttendance).toHaveBeenCalledWith(expect.objectContaining({ text: "I'm in", context: expect.objectContaining({ clubName: "FNF" }) }));
    expect(dms()[0].text).not.toContain("send IN again");
  });

  it("no game of his own and the resolver says it is not an IN: nothing, no question", async () => {
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: null, via: "llm" });
    expect(await askAboutOpenPartnerAsk({ userId: "ali", userName: "Ali", text: "what time?", replyPhone: "447700900111", own: null, now: NOW })).toBe(false);
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });
});

describe("askPartnerWhichByDm (D5b's question, by DM)", () => {
  it("claims the one question and sends it to him privately, in his club's language, with the link", async () => {
    expect(await askPartnerWhichByDm({ askId: "ask1", userId: "ali" })).toBe("dm");
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:which:ali", kind: "xask-which" } });
    const [dm] = dms();
    expect(dm).toMatchObject({ orgId: "sutton", phone: "447700900111" });
    expect(dm.text).toContain(LINK);
    expect(dm.text).toContain("just say IN in the group again");
  });

  it("asked already: false, nothing sent", async () => {
    dbMock.sentNotification.create.mockRejectedValue(new Error("dup"));
    expect(await askPartnerWhichByDm({ askId: "ask1", userId: "ali" })).toBe(false);
    expect(dms()).toEqual([]);
  });

  it("no number on file: 'group', so the batch asks in the group as before", async () => {
    dbMock.user.findUnique.mockResolvedValue({ phoneNumber: null });
    expect(await askPartnerWhichByDm({ askId: "ask1", userId: "ali" })).toBe("group");
    expect(dms()).toEqual([]);
  });
});

// ── A volunteer MatchTime has no name for (2026-10-22) ─────────────────────
//
// Prod, MT Test: C2 (Friday MT Community) volunteered by the DM code with an
// EMPTY User.name, and MT Test's squad listed him as "(unnamed)". Now an IN
// from a nameless volunteer gets ONE question first ("what name should I
// list you under?") and nothing is written. His next DM is READ by the model
// (lib/volunteer-name-reply.ts), never taken as typed: a name fills an empty
// User.name only and the ordinary volunteer writer runs; a withdrawal saves
// nothing and puts him nowhere; anything else asks the question again.
describe("a nameless volunteer is asked for his name first", () => {
  const coded = (userName: string | null, text = `IN (ref ${REF})`) =>
    handleCodedPartnerAskDm({ askId: "ask1", userId: "c2", userName, text, replyPhone: "447700900111", waMessageId: "wa-dm-1", now: NOW });
  const reply = (text: string, at = NOW) =>
    handleVolunteerNameReply({ userId: "c2", text, replyPhone: "447700900111", waMessageId: "wa-dm-2", now: at });
  const pending = { key: "xask:name:c2:ask1", createdAt: new Date(NOW.getTime() - 60_000) };

  it("an IN with no name on file: one question, in his club's language, and nothing written", async () => {
    const r = await coded(null);
    expect(r).toEqual({ handled: "xask-dm-name-ask", outcome: "asked-name" });
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: { startsWith: "xask:name:c2:" } } });
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:name:c2:ask1", kind: "xask-dm-name", targetUser: "c2" } });
    const [dm] = dms();
    expect(dm).toMatchObject({ orgId: "sutton", phone: "447700900111", priority: 1 });
    expect(dm.text).toBe(en.xask_dm_name_ask({ asker: "FNF", day: dayCommaTimeLabel("en", KICKOFF) }));
  });

  it("a Turkish club asks in Turkish", async () => {
    dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : { id: "sutton", name: "Sutton FC", language: "tr" }),
    );
    await coded("");
    expect(dms()[0].text).toBe(tr.xask_dm_name_ask({ asker: "FNF", day: dayCommaTimeLabel("tr", KICKOFF) }));
  });

  it("a blank or phone-number name counts as no name", async () => {
    await coded("  ");
    await coded("+447893944985");
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
  });

  it("a volunteer with a name on file is not asked", async () => {
    await coded("Ali Kaya");
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(expect.objectContaining({ name: "Ali Kaya", polarity: "in" }), NOW);
    expect(dbMock.sentNotification.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "xask-dm-name" }) }));
  });

  it("an OUT from a nameless volunteer is not held up by the question", async () => {
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "out", via: "llm" });
    await coded(null);
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(expect.objectContaining({ polarity: "out" }), NOW);
  });

  it("his reply is read by the model, with the question we asked, the club and the day as context", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "name", name: "Ben" });
    await reply("Ben here, still in");
    const day = dayCommaTimeLabel("en", KICKOFF);
    expect(nameReader.readVolunteerNameReply).toHaveBeenCalledWith("Ben here, still in", {
      askerName: "FNF",
      day,
      question: en.xask_dm_name_ask({ asker: "FNF", day }),
      userId: "c2",
    });
  });

  it("his reply gives his name: saved to an EMPTY User.name only, then he is volunteered IN under it", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "name", name: "Cem  Yilmaz" });
    const r = await reply("it's Cem Yilmaz");
    expect(dbMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: "c2", OR: [{ name: null }, { name: "" }] },
      data: { name: "Cem Yilmaz" },
    });
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "xask:name:c2:ask1" } });
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(
      { askId: "ask1", userId: "c2", name: "Cem Yilmaz", polarity: "in", sourceMessageId: "wa-dm-2", replyPhone: "447700900111" },
      NOW,
    );
    expect(r).toEqual({ handled: "xask-dm-volunteer", outcome: "registered-bench" });
  });

  it("the question is only open for its window, and only for him", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(null);
    expect(await reply("Cem")).toBeNull();
    expect(dbMock.sentNotification.findFirst).toHaveBeenCalledWith({
      where: { kind: "xask-dm-name", key: { startsWith: "xask:name:c2:" }, createdAt: { gte: new Date(NOW.getTime() - VOLUNTEER_NAME_TTL_MS) } },
      orderBy: { createdAt: "desc" },
      select: { key: true },
    });
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(nameReader.readVolunteerNameReply).not.toHaveBeenCalled();
  });

  // The bug (2026-10-22): "OUT", "actually can't make it", "yok gelemiyorum"
  // were saved as his name and he was put IN.
  it("he withdraws instead: no name saved, the question closed, nothing IN, a short ack in his club's language", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    dbMock.attendance.findUnique.mockResolvedValue(null);
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "out" });
    const r = await reply("actually can't make it");
    expect(r).toEqual({ handled: "xask-dm-name-withdrawn", outcome: "withdrew" });
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "xask:name:c2:ask1" } });
    expect(dbMock.attendance.findUnique).toHaveBeenCalledWith({ where: { matchId_userId: { matchId: "m-fnf", userId: "c2" } }, select: { status: true } });
    expect(dms()).toEqual([
      expect.objectContaining({ orgId: "sutton", phone: "447700900111", text: en.xask_dm_name_withdrawn({ asker: "FNF", day: dayCommaTimeLabel("en", KICKOFF) }) }),
    ]);
  });

  it("he withdraws in a Turkish club: the ack is Turkish", async () => {
    dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : { id: "sutton", name: "Sutton FC", language: "tr" }),
    );
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    dbMock.attendance.findUnique.mockResolvedValue(null);
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "out" });
    await reply("yok gelemiyorum");
    expect(dms()[0].text).toBe(tr.xask_dm_name_withdrawn({ asker: "FNF", day: dayCommaTimeLabel("tr", KICKOFF) }));
  });

  it("he withdraws but is somehow on the asking club's list already: the volunteer writer's own OUT path takes him off", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    dbMock.attendance.findUnique.mockResolvedValue({ status: "BENCH" });
    dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900111", name: null });
    guest.handlePartnerVolunteer.mockResolvedValue({ ok: true, outcome: "withdrawn", dmText: "OK", dmQueued: true });
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "out" });
    const r = await reply("OUT");
    expect(guest.handlePartnerVolunteer).toHaveBeenCalledWith(
      { askId: "ask1", userId: "c2", name: "", polarity: "out", sourceMessageId: "wa-dm-2", replyPhone: "447700900111" },
      NOW,
    );
    expect(r).toEqual({ handled: "xask-dm-volunteer", outcome: "withdrawn" });
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    // The writer answers him itself; no second ack from here.
    expect(dms()).toEqual([]);
  });

  it("a question or anything unclear: nothing written, the question asked once more, still open", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "other", why: "a question" });
    const r = await reply("which match?");
    expect(r).toEqual({ handled: "xask-dm-name-ask", outcome: "asked-name-again" });
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.deleteMany).not.toHaveBeenCalled();
    expect(dms()).toEqual([expect.objectContaining({ text: en.xask_dm_name_ask({ asker: "FNF", day: dayCommaTimeLabel("en", KICKOFF) }) })]);
  });

  it("the model call fails: fail safe, no name, nothing IN, asked again", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    nameReader.readVolunteerNameReply.mockRejectedValue(new Error("AI budget reached"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await reply("Ali");
    err.mockRestore();
    expect(r).toEqual({ handled: "xask-dm-name-ask", outcome: "asked-name-again" });
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(dms()).toHaveLength(1);
  });

  it("a 'name' that cannot be one (a number) never becomes User.name, whatever the model said", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue(pending);
    nameReader.readVolunteerNameReply.mockResolvedValue({ kind: "name", name: "07893 944985" });
    const r = await reply("07893 944985");
    expect(r).toEqual({ handled: "xask-dm-name-ask", outcome: "asked-name-again" });
    expect(dbMock.user.updateMany).not.toHaveBeenCalled();
    expect(guest.handlePartnerVolunteer).not.toHaveBeenCalled();
    expect(dms()).toHaveLength(1);
  });

  it("volunteerNameFromReply is still exported from here: trimmed, capped, never a number", () => {
    expect(volunteerNameFromReply("  Cem\n Yilmaz ")).toBe("Cem Yilmaz");
    expect(volunteerNameFromReply("+447893944985")).toBeNull();
  });
});
