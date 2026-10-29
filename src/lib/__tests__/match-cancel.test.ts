/**
 * The one path that cancels a match and puts it back on (2026-10-22),
 * shared by the web page and HQ. The database is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMatchCancelledAnnouncement } from "../group-copy";
import { dayTimeLabel } from "../i18n/dates";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  botJob: { create: vi.fn(), deleteMany: vi.fn() },
  guestPlace: { updateMany: vi.fn() },
  organisation: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  clubInvitation: { findMany: vi.fn(), updateMany: vi.fn() },
  sentNotification: { count: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
  attendance: { findMany: vi.fn() },
  paymentCredit: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const platformJobs = vi.hoisted(() => ({ cancelQueuedPlatformDms: vi.fn() }));
vi.mock("@/lib/platform-jobs", () => platformJobs);
const adminChannel = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("@/lib/admin-channel", () => adminChannel);
const monthClose = vi.hoisted(() => ({ afterMatchesCancelled: vi.fn() }));
vi.mock("@/lib/month-close", () => monthClose);

import { cancelMatchById, hqCancelOrRestore, notPlayedGameLabel, notPlayedReply, playersGroupCancelOrRestore, ratingsClosedLine, restoreMatchById } from "../match-cancel";

const NOW = new Date("2026-10-22T14:00:00Z");
const FRI = new Date("2026-10-23T19:30:00Z");
const row = (status: string, lang = "en", squadMode = "weekly") => ({
  id: "m1",
  status,
  date: FRI,
  activity: { orgId: "org1", name: "Friday Night Football", org: { language: lang, squadMode } },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.updateMany.mockResolvedValue({ count: 1 });
  dbMock.botJob.create.mockResolvedValue({});
  dbMock.botJob.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.clubInvitation.findMany.mockResolvedValue([]);
  dbMock.sentNotification.count.mockResolvedValue(0);
  dbMock.sentNotification.upsert.mockResolvedValue({});
  dbMock.sentNotification.findUnique.mockResolvedValue(null);
  dbMock.sentNotification.findMany.mockResolvedValue([]);
  dbMock.sentNotification.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
  adminChannel.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  dbMock.attendance.findMany.mockResolvedValue([]);
  dbMock.paymentCredit.findMany.mockResolvedValue([]);
  platformJobs.cancelQueuedPlatformDms.mockResolvedValue({ cancelled: 0, alreadyClaimed: 0, byPurpose: {} });
  monthClose.afterMatchesCancelled.mockResolvedValue({ creditedGames: 0 });
});

describe("cancelMatchById", () => {
  it("a weekly club: CANCELLED from the status read, and the players' group told", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("TEAMS_GENERATED"));
    expect(await cancelMatchById("m1", { now: NOW })).toEqual({ kind: "cancelled", activityName: "Friday Night Football", date: FRI });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "TEAMS_GENERATED" }, data: { status: "CANCELLED" } });
    expect(dbMock.botJob.create).toHaveBeenCalledWith({
      data: {
        orgId: "org1",
        kind: "group",
        text: buildMatchCancelledAnnouncement({ activityName: "Friday Night Football", whenLabel: dayTimeLabel("en", FRI), lang: "en" }),
      },
    });
    expect(monthClose.afterMatchesCancelled).not.toHaveBeenCalled();
  });

  it("completed or already cancelled: nothing written", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("COMPLETED"));
    expect((await cancelMatchById("m1", { now: NOW })).kind).toBe("completed");
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect((await cancelMatchById("m1", { now: NOW })).kind).toBe("already");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("another door cancelled it first: announced once", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING"));
    dbMock.match.updateMany.mockResolvedValue({ count: 0 });
    expect((await cancelMatchById("m1", { now: NOW })).kind).toBe("already");
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});

describe("restoreMatchById", () => {
  it("a monthly club's game back on: its cancelled-week credits are taken back at once (the sweep's one reconcile)", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED", "en", "monthly"));
    expect((await restoreMatchById("m1", NOW)).kind).toBe("restored");
    expect(monthClose.afterMatchesCancelled).toHaveBeenCalledWith("org1", [], NOW);
  });

  it("a weekly club's game back on: no month is touched", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    await restoreMatchById("m1", NOW);
    expect(monthClose.afterMatchesCancelled).not.toHaveBeenCalled();
  });

  it("a cancelled match still to come: UPCOMING again, and the players' group told", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect((await restoreMatchById("m1", NOW)).kind).toBe("restored");
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "CANCELLED" }, data: { status: "UPCOMING" } });
    expect(dbMock.botJob.create.mock.calls[0][0].data.text).toBe(
      `✅ *Match back on*: Friday Night Football on ${dayTimeLabel("en", FRI)}. It goes ahead as planned.`,
    );
  });

  it("slice L7 (review of #404, 2): its guests' places are not left settled, so the game is marked and played as any other", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    await restoreMatchById("m1", NOW);
    expect(dbMock.guestPlace.updateMany).toHaveBeenCalledWith({ where: { matchId: "m1", settledAt: { not: null } }, data: { settledAt: null } });
  });

  it("its kickoff is more than 7 days gone: not restored", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect((await restoreMatchById("m1", new Date("2026-10-31T00:00:00Z"))).kind).toBe("past");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("hqCancelOrRestore", () => {
  it("cancels the next match and words HQ's reply, EN and TR", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING"));
    const en = await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "cancel", dayPhrase: null, addressed: false, now: NOW });
    expect(en).toEqual({
      outcome: "hq-match-cancelled",
      replyText: `Done: Friday Night Football, ${dayTimeLabel("en", FRI)} is cancelled. I've told the players' group.`,
    });
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING", "tr"));
    const tr = await hqCancelOrRestore({ orgId: "org1", lang: "tr", mode: "cancel", dayPhrase: null, addressed: false, now: NOW });
    expect(tr?.replyText).toBe(`Tamam: Friday Night Football, ${dayTimeLabel("tr", FRI)} iptal edildi. Oyuncu grubuna haber verdim.`);
  });

  it("no match on the day named: says so, cancels nothing", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    const r = await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "cancel", dayPhrase: "Tuesday", addressed: true, now: NOW });
    expect(r).toEqual({ outcome: "hq-cancel-none", replyText: `I can't find an upcoming match for "Tuesday".` });
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });

  it("put back on with nothing cancelled: a line when asked, silent when not", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    expect(await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "restore", dayPhrase: null, addressed: false, now: NOW })).toBeNull();
    expect((await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "restore", dayPhrase: null, addressed: true, now: NOW }))?.replyText).toBe(
      "There's no cancelled match still to come to put back on.",
    );
  });
});

describe("playersGroupCancelOrRestore (2026-10-23)", () => {
  const go = (over: Partial<Parameters<typeof playersGroupCancelOrRestore>[0]> = {}) =>
    playersGroupCancelOrRestore({ orgId: "org1", lang: "en", mode: "cancel", dayPhrase: null, organiser: true, now: NOW, ...over });

  it("a club with no admin group: an organiser cancels through the one core; the cancel post is the announcement, so only a tick", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null, squadMode: "weekly" });
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING"));
    expect(await go()).toEqual({ outcome: "match_cancelled", replyText: null, react: "✅" });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "UPCOMING" }, data: { status: "CANCELLED" } });
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(1);
    expect(dbMock.botJob.create.mock.calls[0][0].data.kind).toBe("group");
  });

  it("and puts it back on", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null, squadMode: "weekly" });
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "CANCELLED" }]);
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect(await go({ mode: "restore" })).toEqual({ outcome: "match_restored", replyText: null, react: "✅" });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "CANCELLED" }, data: { status: "UPCOMING" } });
  });

  it("nothing to put back on: says so", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null, squadMode: "weekly" });
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    expect(await go({ mode: "restore" })).toEqual({
      outcome: "match_cancel_none",
      replyText: "There's no cancelled match still to come to put back on.",
      react: null,
    });
  });

  it("a club WITH an admin group: pointed there, EN and TR, nothing cancelled", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: "hq@g.us", squadMode: "weekly" });
    expect(await go()).toEqual({
      outcome: "match_cancel_use_admin_group",
      replyText: "Cancelling a match or putting it back on is done in your admin group. Tag me there and I'll do it.",
      react: null,
    });
    expect((await go({ lang: "tr", mode: "restore" })).replyText).toBe(
      "Maçı iptal etmek ya da yeniden açmak yönetici grubunuzdan yapılıyor. Orada beni etiketleyin, ben yaparım.",
    );
    expect(dbMock.match.findMany).not.toHaveBeenCalled();
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("a monthly club: cancelled through the same core as a weekly one (Kemal: every admin feature by tagging)", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null, squadMode: "monthly" });
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING"));
    expect(await go()).toEqual({ outcome: "match_cancelled", replyText: null, react: "✅" });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "UPCOMING" }, data: { status: "CANCELLED" } });
  });

  it("not an owner or admin: the organisers-only line, nothing read or written", async () => {
    dbMock.membership.findMany.mockResolvedValue([{ user: { name: "Kemal" } }]);
    expect(await go({ organiser: false })).toEqual({ outcome: "match_cancel_organisers_only", replyText: "Only Kemal can change that.", react: null });
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });
});

// ── A game that did not happen (2026-10-28, Kemal) ─────────────────────
// Sutton FC's Tuesday 5-a-side, 27 Oct 21:15, COMPLETED by the cron, no
// score, 8 confirmed. Marked as not played on Wednesday morning.
describe("a past game marked as not played", () => {
  const TUE = new Date("2026-10-27T21:15:00Z");
  const WED = new Date("2026-10-28T10:00:00Z");
  const past = (status = "COMPLETED", over: Record<string, unknown> = {}, lang = "en", squadMode = "weekly") => ({
    id: "tue",
    status,
    date: TUE,
    redScore: null,
    yellowScore: null,
    activity: { orgId: "sutton", name: "Tuesday 5-a-side", org: { language: lang, squadMode } },
    ...over,
  });

  it("CANCELLED from the status read; no 'match cancelled' post, no DM; queued jobs for it dropped", async () => {
    dbMock.match.findUnique.mockResolvedValue(past());
    dbMock.botJob.deleteMany.mockResolvedValue({ count: 2 });
    const r = await cancelMatchById("tue", { now: WED });
    expect(r).toEqual({ kind: "not-played", activityName: "Tuesday 5-a-side", date: TUE, paidCount: 0, ratingLinksSent: false, creditedGames: 0, droppedJobs: 2 });
    // Review of #437, 4: only while it still has no score, so a score
    // landing at the same moment is never wiped out by the cancel.
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "tue", status: "COMPLETED", redScore: null, yellowScore: null }, data: { status: "CANCELLED" } });
    // Review of #437, 7: recorded as NOT PLAYED, in the same transaction.
    expect(dbMock.sentNotification.upsert).toHaveBeenCalledWith({ where: { key: "tue:not-played" }, create: { key: "tue:not-played", kind: "not-played", matchId: "tue" }, update: {} });
    expect(dbMock.botJob.deleteMany).toHaveBeenCalledWith({ where: { matchId: "tue", sentAt: null } });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("rating links had gone out: ONE line in the players' group, EN and TR", async () => {
    dbMock.match.findUnique.mockResolvedValue(past());
    dbMock.sentNotification.count.mockResolvedValue(8);
    await cancelMatchById("tue", { now: WED });
    expect(dbMock.sentNotification.count).toHaveBeenCalledWith({
      where: { matchId: "tue", OR: [{ key: { startsWith: "tue:rate-dm:" } }, { key: "tue:rate-promo" }] },
    });
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(1);
    expect(dbMock.botJob.create).toHaveBeenCalledWith({
      data: { orgId: "sutton", kind: "group", text: "Tuesday's game on 27 Oct didn't happen, so its rating links are closed." },
    });
    expect(ratingsClosedLine("tr", TUE)).toBe("27 Ekim Salı günkü maç oynanmadı, bu yüzden puanlama linkleri kapatıldı.");
  });

  it("the players' group door puts that line in its own reply instead of a second post", async () => {
    dbMock.match.findUnique.mockResolvedValue(past());
    dbMock.sentNotification.count.mockResolvedValue(8);
    await cancelMatchById("tue", { now: WED, ratingsLineInReply: true });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("players who paid are counted for the reply, never refunded: paid rows (not a monthly regular's) and bulk-paid places", async () => {
    dbMock.match.findUnique.mockResolvedValue(past());
    dbMock.attendance.findMany.mockResolvedValue([{ paymentMethod: "card" }, { paymentMethod: null }, { paymentMethod: "monthly" }]);
    dbMock.paymentCredit.findMany.mockResolvedValue([{ count: 2 }]);
    const r = await cancelMatchById("tue", { now: WED });
    expect(r.kind === "not-played" && r.paidCount).toBe(4);
    expect(dbMock.attendance.findMany).toHaveBeenCalledWith({ where: { matchId: "tue", paidAt: { not: null } }, select: { paymentMethod: true } });
  });

  it("the after-game 'join the club?' questions not yet answered are withdrawn and their queued DMs cancelled; guests' results LEFT AS THEY ARE (review of #437, 2)", async () => {
    dbMock.match.findUnique.mockResolvedValue(past());
    dbMock.clubInvitation.findMany.mockResolvedValue([{ id: "inv1" }]);
    await cancelMatchById("tue", { now: WED });
    expect(platformJobs.cancelQueuedPlatformDms).toHaveBeenCalledWith({ purposes: ["club-invite-ask"], refIds: ["inv1"], reason: "the game did not happen", now: WED });
    expect(dbMock.clubInvitation.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["inv1"] }, status: "open" }, data: { status: "withdrawn", closedAt: WED } });
    expect(dbMock.guestPlace.updateMany).not.toHaveBeenCalled();
  });

  it("review of #437, 4: a score landed in between: the cancel writes nothing and says it was played", async () => {
    dbMock.match.findUnique.mockResolvedValueOnce(past()).mockResolvedValueOnce(past("COMPLETED", { redScore: 4, yellowScore: 2 }));
    dbMock.match.updateMany.mockResolvedValue({ count: 0 });
    expect((await cancelMatchById("tue", { now: WED })).kind).toBe("scored");
    expect(dbMock.sentNotification.upsert).not.toHaveBeenCalled();
    expect(dbMock.botJob.deleteMany).not.toHaveBeenCalled();
  });

  it("review of #437, 10: said again of a game already marked as not played, the after-game steps run again (a failure part way is retried); nothing posted twice", async () => {
    dbMock.match.findUnique.mockResolvedValue(past("CANCELLED"));
    dbMock.sentNotification.findUnique.mockResolvedValue({ id: "marker" });
    dbMock.sentNotification.count.mockResolvedValue(8);
    expect(await cancelMatchById("tue", { now: WED })).toEqual({ kind: "already", activityName: "Tuesday 5-a-side", date: TUE, notPlayed: true });
    expect(dbMock.botJob.deleteMany).toHaveBeenCalledWith({ where: { matchId: "tue", sentAt: null } });
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("already cancelled before kickoff (announced): 'already', and nothing is re-run", async () => {
    dbMock.match.findUnique.mockResolvedValue(past("CANCELLED"));
    expect((await cancelMatchById("tue", { now: WED })).kind).toBe("already");
    expect(dbMock.botJob.deleteMany).not.toHaveBeenCalled();
  });

  it("a monthly club gets its credits, as for a game still to come", async () => {
    dbMock.match.findUnique.mockResolvedValue(past("COMPLETED", {}, "en", "monthly"));
    monthClose.afterMatchesCancelled.mockResolvedValue({ creditedGames: 1 });
    const r = await cancelMatchById("tue", { now: WED });
    expect(monthClose.afterMatchesCancelled).toHaveBeenCalledWith("sutton", ["tue"]);
    expect(r.kind === "not-played" && r.creditedGames).toBe(1);
  });

  it("a game with a score was played: left alone", async () => {
    dbMock.match.findUnique.mockResolvedValue(past("COMPLETED", { redScore: 5, yellowScore: 3 }));
    expect((await cancelMatchById("tue", { now: WED })).kind).toBe("scored");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });

  it("more than 7 days after kickoff: too old, nothing written", async () => {
    dbMock.match.findUnique.mockResolvedValue(past());
    expect((await cancelMatchById("tue", { now: new Date("2026-11-04T00:00:00Z") })).kind).toBe("too-old");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });

  it("not yet completed by the cron (kicked off, still TEAMS_PUBLISHED): marked as not played too", async () => {
    dbMock.match.findUnique.mockResolvedValue(past("TEAMS_PUBLISHED"));
    expect((await cancelMatchById("tue", { now: WED })).kind).toBe("not-played");
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "tue", status: "TEAMS_PUBLISHED", redScore: null, yellowScore: null }, data: { status: "CANCELLED" } });
  });

  it("the reply copy, EN and TR, with who paid", () => {
    const r = { kind: "not-played" as const, activityName: "Tuesday 5-a-side", date: TUE, paidCount: 0, ratingLinksSent: false, creditedGames: 0 };
    expect(notPlayedReply("en", r)).toBe("Done. Tuesday 5-a-side on 27 Oct is marked as not played: no score, ratings or Man of the Match for it.");
    expect(notPlayedReply("tr", r)).toBe("Tamam. Tuesday 5-a-side (27 Ekim Salı) oynanmadı olarak işaretlendi: skor, puanlama ya da maçın adamı yok.");
    expect(notPlayedGameLabel("en", "5-a-side", TUE)).toBe("Tuesday's 5-a-side on 27 Oct");
    expect(notPlayedReply("en", { ...r, paidCount: 1 })).toBe(
      "Done. Tuesday 5-a-side on 27 Oct is marked as not played: no score, ratings or Man of the Match for it.\n1 player had already paid for it. MatchTime refunds nobody by itself, so please refund or credit them.",
    );
    expect(notPlayedReply("en", { ...r, paidCount: 3 }).split("\n")[1]).toBe("3 players had already paid for it. MatchTime refunds nobody by itself, so please refund or credit them.");
    expect(notPlayedReply("tr", { ...r, paidCount: 3 }).split("\n")[1]).toBe(
      "3 oyuncu bu maç için ödeme yapmıştı. MatchTime kendiliğinden iade yapmaz, lütfen onlara iade edin ya da bir sonraki maça sayın.",
    );
  });
});

describe("a past game put back as played", () => {
  const TUE = new Date("2026-10-27T21:15:00Z");
  const WED = new Date("2026-10-28T10:00:00Z");
  const c = { id: "tue", status: "CANCELLED", date: TUE, activity: { orgId: "sutton", name: "Tuesday 5-a-side", org: { language: "en" } } };

  it("COMPLETED, not UPCOMING; nothing posted, so nothing already sent goes again; the not-played record removed", async () => {
    dbMock.match.findUnique.mockResolvedValue(c);
    dbMock.sentNotification.findUnique.mockResolvedValue({ id: "marker" });
    expect(await restoreMatchById("tue", WED)).toEqual({ kind: "restored", activityName: "Tuesday 5-a-side", date: TUE, past: true });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "tue", status: "CANCELLED" }, data: { status: "COMPLETED" } });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({ where: { key: "tue:not-played" } });
  });

  it("review of #437, 7: a game called off BEFORE kickoff is never put back as played", async () => {
    dbMock.match.findUnique.mockResolvedValue(c);
    expect((await restoreMatchById("tue", WED)).kind).toBe("past");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("the doors, for a past game", () => {
  const TUE = new Date("2026-10-27T21:15:00Z");
  const WED = new Date("2026-10-28T10:00:00Z");
  const NEXT = new Date("2026-11-03T21:15:00Z");
  const past = { id: "tue", status: "COMPLETED", date: TUE, redScore: null, yellowScore: null, activity: { orgId: "sutton", name: "Tuesday 5-a-side", org: { language: "en", squadMode: "weekly" } } };

  it("HQ: 'Tuesday's game didn't happen' marks the past Tuesday, replies to the organiser, posts the ratings line", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "tue", date: TUE, status: "COMPLETED" }, { id: "next", date: NEXT, status: "UPCOMING" }]);
    dbMock.match.findUnique.mockResolvedValue(past);
    dbMock.sentNotification.count.mockResolvedValue(8);
    const r = await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "Tuesday", pastGame: true, addressed: true, now: WED });
    expect(r).toEqual({ outcome: "hq-match-not-played", replyText: "Done. Tuesday 5-a-side on 27 Oct is marked as not played: no score, ratings or Man of the Match for it." });
    expect(dbMock.match.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "tue" } }));
    // The club's matches of the last 7 days are loaded too.
    expect(dbMock.match.findMany.mock.calls[0][0].where.date).toEqual({ gt: new Date("2026-10-21T10:00:00Z") });
    expect(dbMock.botJob.create.mock.calls[0][0].data.text).toBe("Tuesday's game on 27 Oct didn't happen, so its rating links are closed.");
  });

  it("HQ: the same words without the past, after a PLAYED Tuesday, never touch it: the coming Tuesday is cancelled", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "tue", date: TUE, status: "COMPLETED", redScore: 5, yellowScore: 4 }, { id: "next", date: NEXT, status: "UPCOMING" }]);
    dbMock.match.findUnique.mockResolvedValue({ ...past, id: "next", status: "UPCOMING", date: NEXT });
    const r = await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "Tuesday", addressed: true, now: WED });
    expect(r?.outcome).toBe("hq-match-cancelled");
    expect(dbMock.match.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "next" } }));
  });

  it("HQ: no past game that day, or a scored one: one line, nothing done (no tick)", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "tue", date: TUE, status: "COMPLETED" }]);
    expect(await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "Monday", pastGame: true, addressed: true, now: WED })).toEqual({
      outcome: "hq-cancel-none",
      replyText: `I can't find a match in the last 7 days for "Monday".`,
    });
    dbMock.match.findUnique.mockResolvedValue({ ...past, redScore: 4, yellowScore: 2 });
    expect(await hqCancelOrRestore({ orgId: "sutton", lang: "tr", mode: "cancel", dayPhrase: null, pastGame: true, addressed: true, now: WED })).toEqual({
      outcome: "hq-cancel-none",
      replyText: "Tuesday 5-a-side (27 Ekim Salı) için kayıtlı bir skor var, bu yüzden oynanmış olarak bıraktım.",
    });
  });

  it("HQ: 'it did happen after all' puts it back as played, EN and TR", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "tue", date: TUE, status: "CANCELLED" }]);
    dbMock.match.findUnique.mockResolvedValue({ ...past, status: "CANCELLED" });
    dbMock.sentNotification.findMany.mockResolvedValue([{ matchId: "tue" }]);
    dbMock.sentNotification.findUnique.mockResolvedValue({ id: "marker" });
    expect(await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "restore", dayPhrase: "Tuesday", pastGame: true, addressed: true, now: WED })).toEqual({
      outcome: "hq-match-played-restored",
      replyText: "Done. Tuesday 5-a-side on 27 Oct is back on the record as played.",
    });
    expect((await hqCancelOrRestore({ orgId: "sutton", lang: "tr", mode: "restore", dayPhrase: null, pastGame: true, addressed: true, now: WED }))?.replyText).toBe(
      "Tamam. Tuesday 5-a-side (27 Ekim Salı) yeniden oynanmış olarak kaydedildi.",
    );
  });

  it("the players' group (no HQ): the reply to the organiser carries the ratings line, and a tick; no second post", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null, squadMode: "weekly" });
    dbMock.match.findMany.mockResolvedValue([{ id: "tue", date: TUE, status: "COMPLETED" }]);
    dbMock.match.findUnique.mockResolvedValue(past);
    dbMock.sentNotification.count.mockResolvedValue(8);
    const r = await playersGroupCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "Tuesday", pastGame: true, organiser: true, now: WED });
    expect(r).toEqual({
      outcome: "match_not_played",
      replyText:
        "Done. Tuesday 5-a-side on 27 Oct is marked as not played: no score, ratings or Man of the Match for it.\nTuesday's game on 27 Oct didn't happen, so its rating links are closed.",
      react: "✅",
    });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});

describe("review of #437: the doors, again", () => {
  const TUE = new Date("2026-10-27T21:15:00Z");
  const WED = new Date("2026-10-28T10:00:00Z");
  const NEXT = new Date("2026-11-03T21:15:00Z");
  const past = { id: "tue", status: "COMPLETED", date: TUE, redScore: null, yellowScore: null, activity: { orgId: "sutton", name: "Tuesday 5-a-side", org: { language: "en", squadMode: "weekly" } } };
  const list = [{ id: "tue", date: TUE, status: "COMPLETED", redScore: null, yellowScore: null }, { id: "next", date: NEXT, status: "UPCOMING", redScore: null, yellowScore: null }];

  it("1: 'the last match didn't happen' said twice: the second says 'already', the game before is never touched", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "old", date: new Date("2026-10-23T19:00:00Z"), status: "COMPLETED" }, { id: "tue", date: TUE, status: "CANCELLED" }]);
    dbMock.match.findUnique.mockResolvedValue({ ...past, status: "CANCELLED" });
    dbMock.sentNotification.findUnique.mockResolvedValue({ id: "marker" });
    const r = await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: null, pastGame: true, addressed: true, now: WED });
    expect(r).toEqual({ outcome: "hq-cancel-none", replyText: "Tuesday 5-a-side on 27 Oct is already marked as not played." });
    expect(dbMock.match.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "tue" } }));
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });

  it("3: 'cancel Tuesday' (no pastGame) the day after an unscored Tuesday: one question naming both games, EN and TR; nothing done", async () => {
    dbMock.match.findMany.mockResolvedValue(list);
    expect(await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "Tuesday", addressed: true, now: WED })).toEqual({
      outcome: "hq-cancel-none",
      replyText: `Which Tuesday: last Tuesday's game on 27 Oct, or next Tuesday's on 3 Nov? Say "last Tuesday" or "next Tuesday".`,
    });
    expect((await hqCancelOrRestore({ orgId: "sutton", lang: "tr", mode: "cancel", dayPhrase: "salı", addressed: true, now: WED }))?.replyText).toBe(
      `Hangi salı: 27 Ekim günkü geçen maç mı, 3 Kasım günkü gelecek maç mı? "geçen salı" ya da "gelecek salı" yazın.`,
    );
    dbMock.match.findMany.mockResolvedValue([list[0]]);
    expect((await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "Tuesday", addressed: true, now: WED }))?.replyText).toBe(
      `Do you mean last Tuesday's game on 27 Oct? Say "last Tuesday" and I'll mark it as not played.`,
    );
    expect((await hqCancelOrRestore({ orgId: "sutton", lang: "tr", mode: "cancel", dayPhrase: "salı", addressed: true, now: WED }))?.replyText).toBe(
      `27 Ekim günkü geçen maçı mı kastediyorsunuz? "geçen salı" yazın, oynanmadı olarak işaretleyeyim.`,
    );
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("3: 'next Tuesday' still cancels the coming one", async () => {
    dbMock.match.findMany.mockResolvedValue(list);
    dbMock.match.findUnique.mockResolvedValue({ ...past, id: "next", status: "UPCOMING", date: NEXT });
    expect((await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: "next Tuesday", addressed: true, now: WED }))?.outcome).toBe("hq-match-cancelled");
  });

  it("8: the players' group: who paid goes privately to the organisers (admin notice), not in the group reply", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ adminGroupId: null, squadMode: "weekly" });
    dbMock.match.findMany.mockResolvedValue([list[0]]);
    dbMock.match.findUnique.mockResolvedValue(past);
    dbMock.attendance.findMany.mockResolvedValue([{ paymentMethod: "card" }, { paymentMethod: "card" }]);
    const r = await playersGroupCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: null, pastGame: true, organiser: true, now: WED });
    expect(r.replyText).toBe("Done. Tuesday 5-a-side on 27 Oct is marked as not played: no score, ratings or Man of the Match for it.");
    expect(adminChannel.sendAdminNotice).toHaveBeenCalledWith({
      orgId: "sutton",
      now: WED,
      text: "Tuesday 5-a-side on 27 Oct: 2 players had already paid for it. MatchTime refunds nobody by itself, so please refund or credit them.",
    });
  });

  it("8: HQ keeps the money line in its own reply (it is the organisers' group); no extra notice", async () => {
    dbMock.match.findMany.mockResolvedValue([list[0]]);
    dbMock.match.findUnique.mockResolvedValue(past);
    dbMock.attendance.findMany.mockResolvedValue([{ paymentMethod: "card" }]);
    const r = await hqCancelOrRestore({ orgId: "sutton", lang: "en", mode: "cancel", dayPhrase: null, pastGame: true, addressed: true, now: WED });
    expect(r?.replyText).toContain("1 player had already paid for it.");
    expect(adminChannel.sendAdminNotice).not.toHaveBeenCalled();
  });
});
