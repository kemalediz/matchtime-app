/**
 * Organisers asking partner clubs in their own words (slice S6), the one
 * entry point the players' group, the organisers' group and a DM share:
 * `askPartnersFromWords` in `src/lib/partner-ask-words.ts`.
 *
 * It reads the club's ACTIVE partners and its asking setting, resolves the
 * club the admin extractor reported, then calls the existing
 * `requestPartnerAsk` ONCE PER PARTNER (every rule of the match page
 * button applies) and composes ONE reply from what each call said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  clubPartnership: { findMany: vi.fn() },
  membership: { findMany: vi.fn() },
  match: { findUnique: vi.fn() },
  partnerAsk: { findFirst: vi.fn() },
  organisation: { findUnique: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const settingsMock = vi.hoisted(() => ({ loadPartnerAskSettings: vi.fn() }));
vi.mock("../club-partnership", () => settingsMock);
const askMock = vi.hoisted(() => ({ requestPartnerAsk: vi.fn() }));
vi.mock("../partner-ask", () => askMock);
const stateMock = vi.hoisted(() => ({ loadSquadState: vi.fn() }));
vi.mock("../pipeline/load-state", () => stateMock);

import { askPartnersFromDmText, askPartnersFromWords, partnerClubsForRouter } from "../partner-ask-words";
import type { PipelineModel } from "../pipeline/llm";

const NOW = new Date("2026-10-16T12:00:00Z");
const ROWS = [
  { id: "p-sutton", partnerOrgId: "sutton", partnerOrg: { name: "Sutton FC" } },
  { id: "p-friday", partnerOrgId: "friday", partnerOrg: { name: "Friday MT Community" } },
];
const base = { orgId: "fnf", requestedByUserId: "u-raihan", via: "hq" as const, lang: "en", now: NOW };

beforeEach(() => {
  vi.resetAllMocks();
  dbMock.clubPartnership.findMany.mockResolvedValue(ROWS);
  settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "on-request", time: null, cutoffHours: 4 });
  stateMock.loadSquadState.mockResolvedValue({ matchId: "m1" });
  askMock.requestPartnerAsk.mockImplementation(async (a: { partnershipId: string }) =>
    a.partnershipId === "p-sutton"
      ? { ok: true, askId: "x1", status: "awaiting-approval", partnerName: "Sutton FC" }
      : { ok: true, askId: "x2", status: "posted", partnerName: "Friday MT Community" },
  );
});

describe("askPartnersFromWords", () => {
  it("no club named: asks EVERY active partner, once each, and replies once", async () => {
    const r = await askPartnersFromWords({ ...base, clubRef: null });
    expect(askMock.requestPartnerAsk).toHaveBeenCalledTimes(2);
    expect(askMock.requestPartnerAsk.mock.calls.map((c) => c[0].partnershipId)).toEqual(["p-sutton", "p-friday"]);
    for (const [a] of askMock.requestPartnerAsk.mock.calls) {
      expect(a).toMatchObject({ askerOrgId: "fnf", matchId: "m1", requestedByUserId: "u-raihan", via: "hq", now: NOW });
    }
    expect(r.outcome).toBe("xask-words-asked");
    expect(r.asked).toBe(2);
    expect(r.replyText).toContain("*Sutton FC*: waiting for their organisers to say yes.");
    expect(r.replyText).toContain("*Friday MT Community*: posted in their group.");
  });

  it("a named club: that partner only", async () => {
    const r = await askPartnersFromWords({ ...base, clubRef: "Sutton'a" });
    expect(askMock.requestPartnerAsk).toHaveBeenCalledTimes(1);
    expect(askMock.requestPartnerAsk.mock.calls[0][0].partnershipId).toBe("p-sutton");
    expect(r.replyText).toBe(
      "I've asked *Sutton FC*'s organisers. Once they say yes, I'll post in their group. The first to reply IN get the open places.",
    );
  });

  it("an organiser-pick club: the reply says volunteers go on the bench to pick", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ benchPickMode: "organiser" });
    const r = await askPartnersFromWords({ ...base, clubRef: "Sutton" });
    expect(r.replyText).toBe(
      "I've asked *Sutton FC*'s organisers. Once they say yes, I'll post in their group. Anyone who replies IN goes on your bench for you to pick.",
    );
  });

  it("only ACTIVE partnerships asking from this club are read", async () => {
    await askPartnersFromWords({ ...base, clubRef: null });
    expect(dbMock.clubPartnership.findMany.mock.calls[0][0].where).toEqual({ askerOrgId: "fnf", status: "active" });
  });

  it("the match the players' group already knows is used as is", async () => {
    await askPartnersFromWords({ ...base, via: "group", clubRef: null, matchId: "m9" });
    expect(stateMock.loadSquadState).not.toHaveBeenCalled();
    expect(askMock.requestPartnerAsk.mock.calls[0][0]).toMatchObject({ matchId: "m9", via: "group" });
  });

  it("no partner: one plain reply, nothing asked", async () => {
    dbMock.clubPartnership.findMany.mockResolvedValue([]);
    const r = await askPartnersFromWords({ ...base, clubRef: "Sutton" });
    expect(askMock.requestPartnerAsk).not.toHaveBeenCalled();
    expect(r.outcome).toBe("xask-words-no-partner");
    expect(r.replyText).toMatch(/you have no partner clubs\. .+\/admin\/settings#partner-clubs$/);
  });

  it("asking switched off: one plain reply, nothing asked", async () => {
    settingsMock.loadPartnerAskSettings.mockResolvedValue({ when: "off", time: null, cutoffHours: 4 });
    const r = await askPartnersFromWords({ ...base, clubRef: null });
    expect(askMock.requestPartnerAsk).not.toHaveBeenCalled();
    expect(r.outcome).toBe("xask-words-asking-off");
    expect(r.replyText).toMatch(/turn it on here: .+\/admin\/settings#partner-clubs$/);
  });

  it("a club that is not a partner: one plain reply naming the partners", async () => {
    const r = await askPartnersFromWords({ ...base, clubRef: "Croydon" });
    expect(askMock.requestPartnerAsk).not.toHaveBeenCalled();
    expect(r.outcome).toBe("xask-words-no-match");
    expect(r.replyText).toBe('I don\'t know a partner club called "Croydon". Your partner clubs: Sutton FC and Friday MT Community.');
  });

  it("no upcoming game: one plain reply, nothing asked", async () => {
    stateMock.loadSquadState.mockResolvedValue({ matchId: null });
    const r = await askPartnersFromWords({ ...base, clubRef: null });
    expect(askMock.requestPartnerAsk).not.toHaveBeenCalled();
    expect(r.outcome).toBe("xask-words-no-game");
  });

  it("a refusal for one partner is said beside the others", async () => {
    askMock.requestPartnerAsk.mockImplementation(async (a: { partnershipId: string }) =>
      a.partnershipId === "p-sutton"
        ? { ok: false, refusal: "already-open", partnerName: "Sutton FC" }
        : { ok: true, askId: "x2", status: "awaiting-approval", partnerName: "Friday MT Community" },
    );
    dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-10-17T19:00:00Z") });
    dbMock.partnerAsk.findFirst.mockResolvedValue({ createdAt: new Date("2026-10-10T09:00:00Z"), status: "posted" });
    const r = await askPartnersFromWords({ ...base, clubRef: null });
    expect(r.asked).toBe(1);
    expect(r.replyText).toContain("*Sutton FC*: already asked on 10 Oct and that ask is still open, so not asked again.");
    expect(dbMock.partnerAsk.findFirst.mock.calls[0][0].where).toEqual({ matchId: "m1", partnershipId: "p-sutton", status: { in: ["awaiting-approval", "posted"] } });
  });

  it("one partner already asked: when, for which game, and that it is still open (Kemal, 2026-10-28)", async () => {
    askMock.requestPartnerAsk.mockResolvedValue({ ok: false, refusal: "already-open", partnerName: "Friday MT Community" });
    dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-10-28T20:30:00Z") });
    dbMock.partnerAsk.findFirst.mockResolvedValue({ createdAt: new Date("2026-10-22T11:00:00Z"), status: "posted" });
    const r = await askPartnersFromWords({ ...base, clubRef: "Friday" });
    expect(r.outcome).toBe("xask-words-not-asked");
    expect(r.replyText).toMatch(/^\*Partner clubs:\* Friday MT Community were already asked on 22 Oct for the game on .+, and that ask is still open, so I haven't asked them again\./);
  });

  it("the open ask cannot be read: the reply still says it, without the date", async () => {
    askMock.requestPartnerAsk.mockResolvedValue({ ok: false, refusal: "already-open", partnerName: "Friday MT Community" });
    dbMock.match.findUnique.mockRejectedValue(new Error("db down"));
    const r = await askPartnersFromWords({ ...base, clubRef: "Friday" });
    expect(r.replyText).toMatch(/^\*Partner clubs:\* Friday MT Community were already asked for this game, and that ask is still open/);
  });

  it("one partner's call throwing never loses the others' answer", async () => {
    askMock.requestPartnerAsk.mockImplementation(async (a: { partnershipId: string }) => {
      if (a.partnershipId === "p-sutton") throw new Error("db down");
      return { ok: true, askId: "x2", status: "posted", partnerName: "Friday MT Community" };
    });
    const r = await askPartnersFromWords({ ...base, clubRef: null });
    expect(r.asked).toBe(1);
    expect(r.replyText).toContain("*Sutton FC*: couldn't be asked just now. Try again in a minute.");
  });

  it("Turkish club: the reply is Turkish", async () => {
    const r = await askPartnersFromWords({ ...base, lang: "tr", clubRef: "Sutton" });
    expect(r.replyText).toContain("organizatörlerine sordum");
  });
});

describe("partnerClubsForRouter: the players' group router's partner line", () => {
  it("a club with no active partner: null, and no second read (its turn is unchanged)", async () => {
    dbMock.clubPartnership.findMany.mockResolvedValue([]);
    expect(await partnerClubsForRouter("fnf", ["u-raihan"])).toBeNull();
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
  });

  it("the partners' names for the senders who are owners or admins only", async () => {
    dbMock.membership.findMany.mockResolvedValue([{ userId: "u-raihan" }]);
    const r = await partnerClubsForRouter("fnf", ["u-raihan", "u-player", null]);
    expect(r).toEqual({ names: ["Sutton FC", "Friday MT Community"], organiserIds: new Set(["u-raihan"]) });
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toEqual({
      orgId: "fnf",
      userId: { in: ["u-raihan", "u-player"] },
      leftAt: null,
      role: { in: ["OWNER", "ADMIN"] }, guestMatchId: null,
    });
  });

  it("no known sender: null without reading memberships", async () => {
    expect(await partnerClubsForRouter("fnf", [null])).toBeNull();
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
  });
});

describe("askPartnersFromDmText: a DM the classifier called partner_ask", () => {
  const extractor = (facts: Record<string, unknown>): PipelineModel => ({
    name: "stub",
    async complete() {
      return {
        text: JSON.stringify({ action: "other", payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, playersFrom: "", clubRef: "", ...facts }),
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 0,
      };
    },
  });
  const dm = { orgId: "fnf", userId: "u-raihan", text: "ask Sutton if anyone can play", senderName: "Raihan", lang: "en", now: NOW };

  it("the shared admin extractor reads the club; the shared door asks, via dm", async () => {
    const reply = await askPartnersFromDmText({ ...dm, model: extractor({ action: "recruit", playersFrom: "partners", clubRef: "Sutton" }) });
    expect(askMock.requestPartnerAsk).toHaveBeenCalledTimes(1);
    expect(askMock.requestPartnerAsk.mock.calls[0][0]).toMatchObject({ partnershipId: "p-sutton", via: "dm", requestedByUserId: "u-raihan" });
    expect(reply).toContain("Sutton FC");
  });

  it("no club named: every partner", async () => {
    await askPartnersFromDmText({ ...dm, model: extractor({ action: "recruit", playersFrom: "partners" }) });
    expect(askMock.requestPartnerAsk).toHaveBeenCalledTimes(2);
  });

  it("the extractor does not confirm it: nothing asked, one plain line", async () => {
    const reply = await askPartnersFromDmText({ ...dm, model: extractor({ action: "other" }) });
    expect(askMock.requestPartnerAsk).not.toHaveBeenCalled();
    expect(reply).toMatch(/wasn't sure/);
  });
});
