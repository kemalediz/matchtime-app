/**
 * THE ADMIN GROUP'S DOOR TO THE MATCHTIME PLAYER POOL (local player pool
 * L10). The pool's own functions are mocked at their boundary: what is
 * under test is that HQ asks through L5a's `requestPoolAsk` (every rule of
 * the match page's tick), joins an open partner round, and says the right
 * line; and which pool notices are still waiting for a YES.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ match: { findUnique: vi.fn() }, organisation: { findUnique: vi.fn() } }));
vi.mock("../db", () => ({ db: dbMock }));
const log = vi.hoisted(() => ({ hqQuestionsSince: vi.fn() }));
vi.mock("../admin-group-log", () => log);
const squad = vi.hoisted(() => ({ loadSquadState: vi.fn() }));
vi.mock("../pipeline/load-state", () => squad);
const round = vi.hoisted(() => ({ requestPoolAsk: vi.fn(), placesOpenOf: vi.fn() }));
vi.mock("../pool/round", () => round);
const autoAsk = vi.hoisted(() => ({ openPartnerRoundOf: vi.fn() }));
vi.mock("../pool/auto-ask", () => autoAsk);
const panel = vi.hoisted(() => ({ poolNoticeBand: vi.fn() }));
vi.mock("../pool/panel", () => panel);
const invite = vi.hoisted(() => ({ invitationsAwaitingClub: vi.fn(), answerAsClub: vi.fn() }));
vi.mock("../pool/club-invitation", () => invite);

import { answerJoinRequestInHq, askPoolFromWords, joinRequestsAwaiting, poolNoticesAwaiting } from "../pool-ask-words";
import { joinRequestRef, latestPoolNoticeAsks, poolAskRef } from "../admin-group-pool-refs";

const NOW = new Date("2026-10-27T12:00:00Z");
const KICKOFF = new Date("2026-10-27T20:00:00Z");
const ENV = { MT_POOL_OPEN: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findUnique.mockResolvedValue({ id: "m1", date: KICKOFF });
  dbMock.organisation.findUnique.mockResolvedValue({ name: "MT Test", featurePlayerPool: true, partnerAskCutoffHours: null });
  squad.loadSquadState.mockResolvedValue({ matchId: "m1" });
  round.placesOpenOf.mockResolvedValue(2);
  autoAsk.openPartnerRoundOf.mockResolvedValue(null);
  round.requestPoolAsk.mockResolvedValue({ ok: true, askId: "a1", waveSent: true });
  panel.poolNoticeBand.mockResolvedValue("few");
  log.hqQuestionsSince.mockResolvedValue([]);
});

describe("asking the pool from HQ", () => {
  it("in words: the club's next match, every open place, the organiser's approval, via words; one line back", async () => {
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV });
    expect(round.requestPoolAsk).toHaveBeenCalledWith({ orgId: "o1", matchId: "m1", places: 2, roundId: null, approvedByUserId: "u-owner", via: "words", now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "hq-pool-asked", replyText: expect.stringMatching(/^🔎 Asking nearby players from the MatchTime player pool for 2 places on Tue 27 Oct, 20:00\./) });
  });

  it("a YES to the notice: that notice's match, via notice", async () => {
    await askPoolFromWords({ orgId: "o1", matchId: "m1", userId: "u-owner", via: "notice", lang: "en", now: NOW, env: ENV });
    expect(squad.loadSquadState).not.toHaveBeenCalled();
    expect(round.requestPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ matchId: "m1", via: "notice" }));
  });

  it("partner clubs already asked for this game: the pool joins their round, for their number, and waits its hour", async () => {
    autoAsk.openPartnerRoundOf.mockResolvedValue({ roundId: "r1", places: 1 });
    round.requestPoolAsk.mockResolvedValue({ ok: true, askId: "a1", waveSent: false });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV });
    expect(round.requestPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ roundId: "r1", places: 1 }));
    expect(r.replyText).toMatch(/if your partner clubs have not filled it within the hour/);
  });

  it("refused (the pool closed for the club): the helpful line, nothing asked, no tick outcome", async () => {
    round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "pool-closed" });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "tr", now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "hq-pool-not-asked", replyText: expect.stringMatching(/^\*Oyuncu havuzu:\* MatchTime oyuncu havuzu kulübünüz için henüz açık değil\./) });
  });

  it("refused, no venue (Kemal, 2026-10-28): what, why, and the weekly game's link", async () => {
    round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "no-venue" });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", where: "group", lang: "en", now: NOW, env: ENV });
    expect(r.outcome).toBe("hq-pool-not-asked");
    expect(r.replyText).toMatch(
      /^\*Player pool:\* I couldn't ask nearby players yet: MatchTime doesn't know where MT Test plays, and pool players are found by how close they live to the pitch\. Set the venue on your weekly game, then ask me again: \S+\/admin\/activities$/,
    );
  });

  it("refused, no venue, asked in words (kept for the retry): it says the pool is asked as soon as the venue is set", async () => {
    round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "no-venue" });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV, remember: { askMessageId: "wa-1" } });
    expect(r.replyText).toMatch(/Set the venue on your weekly game here and I'll ask the pool straight away: \S+\/admin\/activities$/);
  });

  it("refused, nobody new near the venue: the reply says why from the ask's exclusion counts", async () => {
    dbMock.match.findUnique.mockResolvedValue({ id: "m1", date: KICKOFF, activity: { venueRef: { name: "Goals Sutton" } } });
    round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "none-near", excluded: { "club-member": 1 } });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV });
    expect(r.replyText).toBe(
      "*Player pool:* nobody new to ask. Of the pool players near Goals Sutton, 1 is already in MT Test. The pool only reaches players outside your club.",
    );
  });

  it("refused, the club's own switch off while the pool is open: the Player pool card's link", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ name: "MT Test", featurePlayerPool: false, partnerAskCutoffHours: null });
    round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "pool-closed" });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV });
    expect(r.replyText).toMatch(/switched off for your club.+\/admin\/settings#player-pool$/);
  });

  it("refused, too late: the club's own cut-off and the setting's link", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ name: "MT Test", featurePlayerPool: true, partnerAskCutoffHours: 6 });
    round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "too-late" });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV });
    expect(r.replyText).toMatch(/goes out 6 hours before kickoff.+\/admin\/settings#partner-clubs$/);
  });

  it("no upcoming match: the recruit line, the pool never asked", async () => {
    squad.loadSquadState.mockResolvedValue({ matchId: null });
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV });
    expect(round.requestPoolAsk).not.toHaveBeenCalled();
    expect(r.outcome).toBe("hq-pool-no-match");
  });
});

describe("which pool notices still wait for a YES", () => {
  it("only the latest notice per match; parsed from the log's ask refs", () => {
    const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
    expect(
      latestPoolNoticeAsks([
        { askRef: poolAskRef("m1"), createdAt: at(-90) },
        { askRef: poolAskRef("m2"), createdAt: at(-60) },
        { askRef: poolAskRef("m1"), createdAt: at(-30) },
        { askRef: "teams:m1", createdAt: at(-10) },
      ]),
    ).toEqual([
      { matchId: "m2", askedAt: at(-60) },
      { matchId: "m1", askedAt: at(-30) },
    ]);
  });

  it("none logged (every club today): nothing read beyond the one query", async () => {
    expect(await poolNoticesAwaiting("o1", NOW, "en", ENV)).toEqual([]);
    expect(panel.poolNoticeBand).not.toHaveBeenCalled();
  });

  it("a notice whose pool can still be asked waits, with the game's day and kickoff (two games a day are told apart)", async () => {
    log.hqQuestionsSince.mockResolvedValue([{ askRef: poolAskRef("m1"), createdAt: NOW }]);
    expect(await poolNoticesAwaiting("o1", NOW, "en", ENV)).toEqual([{ ref: poolAskRef("m1"), kind: "pool-ask", day: "Tue 27 Oct, 20:00", askedAt: NOW }]);
    expect(panel.poolNoticeBand).toHaveBeenCalledWith("o1", { id: "m1", date: KICKOFF }, NOW, ENV);
  });

  it("no longer waits once the pool was asked, it is too late, nobody is near (no band) or the squad is full", async () => {
    log.hqQuestionsSince.mockResolvedValue([{ askRef: poolAskRef("m1"), createdAt: NOW }]);
    panel.poolNoticeBand.mockResolvedValue(null);
    expect(await poolNoticesAwaiting("o1", NOW, "en", ENV)).toEqual([]);
    panel.poolNoticeBand.mockResolvedValue("5+");
    round.placesOpenOf.mockResolvedValue(0);
    expect(await poolNoticesAwaiting("o1", NOW, "en", ENV)).toEqual([]);
  });
});

describe("a guest who wants to join, waiting for the organisers' YES (L8's notice)", () => {
  const SAM = { id: "inv1", userId: "u-sam", name: "Sam K" };
  beforeEach(() => {
    invite.invitationsAwaitingClub.mockResolvedValue([SAM]);
    invite.answerAsClub.mockResolvedValue({ ok: true, state: "link-sent" });
  });

  it("waits only while his notice was posted in HQ in the last day and he is still waiting for the club", async () => {
    expect(await joinRequestsAwaiting("o1", NOW)).toEqual([]);
    expect(invite.invitationsAwaitingClub).not.toHaveBeenCalled();
    log.hqQuestionsSince.mockResolvedValue([{ askRef: joinRequestRef("inv1"), createdAt: NOW }, { askRef: joinRequestRef("gone"), createdAt: NOW }]);
    expect(await joinRequestsAwaiting("o1", NOW)).toEqual([{ ref: joinRequestRef("inv1"), kind: "join-request", day: null, names: "Sam K", askedAt: NOW }]);
    expect(invite.invitationsAwaitingClub).toHaveBeenCalledWith("o1", ["inv1", "gone"]);
  });

  it("a YES: the card's own Send the invite link (answerAsClub, the organiser as actor); one line back", async () => {
    const r = await answerJoinRequestInHq({ orgId: "o1", invitationId: "inv1", actorId: "u-owner", lang: "en", now: NOW, env: ENV });
    expect(invite.answerAsClub).toHaveBeenCalledWith({ orgId: "o1", userId: "u-sam", actorId: "u-owner", answer: "yes", now: NOW, env: ENV });
    expect(r).toEqual({ outcome: "hq-join-link-sent", replyText: "✅ Sending Sam K the players' group's invite link." });
  });

  it("approved but the club has no link yet: said so, with where to add it", async () => {
    invite.answerAsClub.mockResolvedValue({ ok: true, state: "approved" });
    expect((await answerJoinRequestInHq({ orgId: "o1", invitationId: "inv1", actorId: "u-owner", lang: "en", now: NOW, env: ENV }))?.outcome).toBe("hq-join-approved");
  });

  it("refused (no link source, already sent, closed): no tick outcome and a plain line, never the link", async () => {
    for (const reason of ["no-link", "already-invited", "not-eligible", "failed"]) {
      invite.answerAsClub.mockResolvedValue({ ok: false, reason });
      const r = await answerJoinRequestInHq({ orgId: "o1", invitationId: "inv1", actorId: "u-owner", lang: "tr", now: NOW, env: ENV });
      expect(r?.outcome).toBe("hq-join-not-done");
      expect(r?.replyText).not.toMatch(/chat\.whatsapp\.com/);
    }
  });

  it("no longer waiting (answered on the card meanwhile): nothing waiting", async () => {
    invite.invitationsAwaitingClub.mockResolvedValue([]);
    expect(await answerJoinRequestInHq({ orgId: "o1", invitationId: "inv1", actorId: "u-owner", lang: "en", now: NOW, env: ENV })).toBeNull();
    expect(invite.answerAsClub).not.toHaveBeenCalled();
  });
});
