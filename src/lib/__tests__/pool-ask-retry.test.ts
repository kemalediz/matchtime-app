/**
 * The retry of a refused pool ask once the venue is set (2026-10-28), with
 * the store and the ask's door mocked: who is asked again, what is posted
 * where, and that a lost claim, a wait or a drop posts nothing. The rules
 * themselves are `pool/__tests__/ask-retry-rules.test.ts`; the whole path
 * against Postgres is `e2e/sim/pool/ask-retry.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  askRetriesAwaiting: vi.fn(),
  claimAskRetry: vi.fn(),
  dropAskRetry: vi.fn(),
  loadAskRetryFacts: vi.fn(),
  recordAskRetryOutcome: vi.fn(),
  rememberRefusedAsk: vi.fn(),
}));
const words = vi.hoisted(() => ({ askPoolFromWords: vi.fn() }));
const dbm = vi.hoisted(() => ({
  db: {
    organisation: { findUnique: vi.fn() },
    botJob: { create: vi.fn() },
  },
}));
vi.mock("../pool/ask-retry", () => store);
vi.mock("../pool-ask-words", () => words);
vi.mock("../db", () => dbm);

import { rememberRefusedPoolAsk, retryAsksAwaitingVenue } from "../pool-ask-retry";

const NOW = new Date("2026-10-28T15:39:00Z");
const ENV = { MT_POOL_OPEN: "1" };
const ROW = {
  id: "r1",
  orgId: "org-mt",
  matchId: "m1",
  askedByUserId: "u-owner",
  askedIn: "group" as const,
  askMessageId: "wa-1",
  places: 2,
  refusal: "no-venue",
  claimedAt: null,
  createdAt: new Date("2026-10-28T15:37:00Z"),
};
const FACTS = {
  now: NOW,
  kickoff: new Date("2026-10-30T19:00:00Z"),
  cutoff: new Date("2026-10-30T15:00:00Z"),
  matchOpen: true,
  placesOpen: 2,
  poolOpen: true,
  askedSince: false,
  stillRefused: false,
};
const ASKED = "🔎 Asking nearby players from the MatchTime player pool for 2 places on Friday 30 October, 19:00. I'll let you know when one takes a place.";

beforeEach(() => {
  vi.clearAllMocks();
  dbm.db.organisation.findUnique.mockResolvedValue({ language: "en" });
  store.askRetriesAwaiting.mockResolvedValue([ROW]);
  store.loadAskRetryFacts.mockResolvedValue(FACTS);
  store.claimAskRetry.mockResolvedValue(true);
  store.dropAskRetry.mockResolvedValue(true);
  words.askPoolFromWords.mockResolvedValue({ outcome: "hq-pool-asked", replyText: ASKED });
});

describe("retryAsksAwaitingVenue", () => {
  it("the MT Test case: claimed once, asked again as the organiser in the same place, one post in the players' group", async () => {
    const out = await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV });
    expect(out).toEqual([{ id: "r1", matchId: "m1", result: "asked" }]);
    expect(store.askRetriesAwaiting).toHaveBeenCalledWith("org-mt", ["no-venue"], NOW);
    expect(store.claimAskRetry).toHaveBeenCalledWith("r1", NOW);
    expect(words.askPoolFromWords).toHaveBeenCalledWith({ orgId: "org-mt", matchId: "m1", userId: "u-owner", via: "words", where: "group", lang: "en", now: NOW, env: ENV });
    // The retry itself never remembers a second refusal.
    expect(words.askPoolFromWords.mock.calls[0][0]).not.toHaveProperty("remember");
    expect(dbm.db.botJob.create).toHaveBeenCalledWith({
      data: { orgId: "org-mt", kind: "group", text: `Your pitch is set, so I've asked the player pool now:\n${ASKED}`, matchId: "m1" },
    });
    expect(store.recordAskRetryOutcome).toHaveBeenCalledWith("r1", "hq-pool-asked");
  });

  it("asked in the admin group: posted there, in the club's language", async () => {
    store.askRetriesAwaiting.mockResolvedValue([{ ...ROW, askedIn: "hq" }]);
    dbm.db.organisation.findUnique.mockResolvedValue({ language: "tr" });
    words.askPoolFromWords.mockResolvedValue({ outcome: "hq-pool-asked", replyText: "x" });
    await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV });
    expect(words.askPoolFromWords).toHaveBeenCalledWith(expect.objectContaining({ where: "hq", lang: "tr" }));
    expect(dbm.db.botJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "admin-group", text: "Sahanız kaydedildi, oyuncu havuzuna şimdi sordum:\nx" }) });
  });

  it("refused again: the reason is posted under its own line, and nothing more is stored", async () => {
    words.askPoolFromWords.mockResolvedValue({ outcome: "hq-pool-not-asked", replyText: "No pool players near enough." });
    const out = await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV });
    expect(out[0].result).toBe("refused");
    expect(dbm.db.botJob.create.mock.calls[0][0].data.text).toBe("Your pitch is set, so I tried the player pool again:\nNo pool players near enough.");
    expect(store.rememberRefusedAsk).not.toHaveBeenCalled();
    expect(store.recordAskRetryOutcome).toHaveBeenCalledWith("r1", "hq-pool-not-asked");
  });

  it("another save won the claim: nothing asked, nothing posted", async () => {
    store.claimAskRetry.mockResolvedValue(false);
    expect(await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV })).toEqual([{ id: "r1", matchId: "m1", result: "lost" }]);
    expect(words.askPoolFromWords).not.toHaveBeenCalled();
    expect(dbm.db.botJob.create).not.toHaveBeenCalled();
  });

  it("the venue still missing: it waits, unclaimed, nothing posted", async () => {
    store.loadAskRetryFacts.mockResolvedValue({ ...FACTS, stillRefused: true });
    expect(await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV })).toEqual([{ id: "r1", matchId: "m1", result: "wait" }]);
    expect(store.claimAskRetry).not.toHaveBeenCalled();
    expect(store.dropAskRetry).not.toHaveBeenCalled();
    expect(dbm.db.botJob.create).not.toHaveBeenCalled();
  });

  it("no longer makes sense (asked since, the match gone): closed silently", async () => {
    store.loadAskRetryFacts.mockResolvedValueOnce({ ...FACTS, askedSince: true });
    expect((await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV }))[0].result).toBe("drop:asked-since");
    expect(store.dropAskRetry).toHaveBeenCalledWith("r1", "asked-since", NOW);
    store.loadAskRetryFacts.mockResolvedValueOnce(null);
    expect((await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV }))[0].result).toBe("drop:match-off");
    expect(words.askPoolFromWords).not.toHaveBeenCalled();
    expect(dbm.db.botJob.create).not.toHaveBeenCalled();
  });

  it("nothing waiting: nothing read beyond the one query", async () => {
    store.askRetriesAwaiting.mockResolvedValue([]);
    expect(await retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV })).toEqual([]);
    expect(store.loadAskRetryFacts).not.toHaveBeenCalled();
    expect(dbm.db.organisation.findUnique).not.toHaveBeenCalled();
  });

  it("never throws: the store failing (the table not applied yet) is logged, nothing else", async () => {
    store.askRetriesAwaiting.mockRejectedValue(new Error('relation "PoolAskRetry" does not exist'));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(retryAsksAwaitingVenue("org-mt", { now: NOW, env: ENV })).resolves.toEqual([]);
    err.mockRestore();
  });
});

describe("rememberRefusedPoolAsk", () => {
  it("hands the ask to the store and never throws", async () => {
    store.rememberRefusedAsk.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = { orgId: "org-mt", matchId: "m1", askedByUserId: "u-owner", askedIn: "group" as const, askMessageId: "wa-1", places: 2, refusal: "no-venue", now: NOW };
    await expect(rememberRefusedPoolAsk(a)).resolves.toBeUndefined();
    expect(store.rememberRefusedAsk).toHaveBeenCalledWith(a);
    err.mockRestore();
  });
});
