/**
 * A refused ask, asked again once the club has fixed what was missing
 * (Kemal, 2026-10-28): the pure rules. Which refusals are kept at all, how
 * long one is kept, and what a stored ask comes to when the venue is set:
 * asked again, left waiting, or dropped (and why).
 */
import { describe, expect, it } from "vitest";
import {
  ASK_RETRY_MAX_AGE_MS,
  ASK_RETRY_REFUSALS,
  FIXABLE_BY_A_SETTING,
  askRetryDecision,
  askRetryExpiresAt,
  isRetryableRefusal,
  type AskRetryFacts,
} from "../ask-retry-rules";
import type { PoolAskRefusal } from "../round-rules";

const ASKED = new Date("2026-10-28T15:37:00Z");
const KICKOFF = new Date("2026-10-30T19:00:00Z");
const CUTOFF = new Date("2026-10-30T15:00:00Z");
const SAVED = new Date("2026-10-28T15:39:00Z");

const row = { createdAt: ASKED, claimedAt: null as Date | null, refusal: "no-venue" };
const facts: AskRetryFacts = {
  now: SAVED,
  kickoff: KICKOFF,
  cutoff: CUTOFF,
  matchOpen: true,
  placesOpen: 2,
  poolOpen: true,
  askedSince: false,
  stillRefused: false,
};

describe("which refusals are kept for a retry", () => {
  it("only no-venue today: the one with a setting that tells us when it is fixed", () => {
    expect([...ASK_RETRY_REFUSALS]).toEqual(["no-venue"]);
    expect(isRetryableRefusal("no-venue")).toBe(true);
  });

  it("every other pool refusal is never stored", () => {
    const others: Array<PoolAskRefusal | "not-found"> = [
      "pool-closed",
      "not-organiser",
      "match-not-open",
      "no-sport",
      "too-late",
      "no-places",
      "bad-number",
      "round-open",
      "club-week-cap",
      "none-near",
      "not-found",
    ];
    for (const r of others) expect(isRetryableRefusal(r), r).toBe(false);
  });

  it("the list of what a setting could fix names no-sport too, and every kept refusal is in it", () => {
    expect(Object.keys(FIXABLE_BY_A_SETTING).sort()).toEqual(["no-sport", "no-venue"]);
    for (const r of ASK_RETRY_REFUSALS) expect(FIXABLE_BY_A_SETTING).toHaveProperty(r);
  });
});

describe("askRetryExpiresAt: a day at most, and never past the cut-off or kickoff", () => {
  it("a day after the ask when the game is further off", () => {
    expect(askRetryExpiresAt({ createdAt: ASKED, kickoff: KICKOFF, cutoff: CUTOFF }).getTime()).toBe(ASKED.getTime() + ASK_RETRY_MAX_AGE_MS);
    expect(ASK_RETRY_MAX_AGE_MS).toBe(24 * 3600_000);
  });

  it("the cut-off when it comes first", () => {
    const cutoff = new Date(ASKED.getTime() + 3 * 3600_000);
    expect(askRetryExpiresAt({ createdAt: ASKED, kickoff: KICKOFF, cutoff })).toEqual(cutoff);
  });

  it("kickoff when it comes before the cut-off (a cut-off of zero hours)", () => {
    const kickoff = new Date(ASKED.getTime() + 2 * 3600_000);
    expect(askRetryExpiresAt({ createdAt: ASKED, kickoff, cutoff: new Date(kickoff.getTime() + 1) })).toEqual(kickoff);
  });
});

describe("askRetryDecision", () => {
  it("the MT Test case: venue set two minutes later, everything still open: ask again", () => {
    expect(askRetryDecision(row, facts)).toEqual({ kind: "retry" });
  });

  it("asked again already (a claim on the row): dropped, never twice", () => {
    expect(askRetryDecision({ ...row, claimedAt: SAVED }, facts)).toEqual({ kind: "drop", reason: "done" });
  });

  it("the venue is still missing (another save, a club venue the pool does not read): it waits", () => {
    expect(askRetryDecision(row, { ...facts, stillRefused: true })).toEqual({ kind: "wait" });
  });

  it("older than a day, past the cut-off, or past kickoff: dropped as expired", () => {
    expect(askRetryDecision(row, { ...facts, now: new Date(ASKED.getTime() + ASK_RETRY_MAX_AGE_MS) })).toEqual({ kind: "drop", reason: "expired" });
    expect(askRetryDecision(row, { ...facts, now: CUTOFF })).toEqual({ kind: "drop", reason: "expired" });
    const soon = new Date(ASKED.getTime() + 3600_000);
    expect(askRetryDecision(row, { ...facts, kickoff: soon, cutoff: soon, now: soon })).toEqual({ kind: "drop", reason: "expired" });
  });

  it("the match cancelled, finished or historical: dropped", () => {
    expect(askRetryDecision(row, { ...facts, matchOpen: false })).toEqual({ kind: "drop", reason: "match-off" });
  });

  it("every place taken since: dropped, nobody needs asking", () => {
    expect(askRetryDecision(row, { ...facts, placesOpen: 0 })).toEqual({ kind: "drop", reason: "no-places" });
  });

  it("the pool switched off for the club: dropped; the switch unread (a database error): it waits", () => {
    expect(askRetryDecision(row, { ...facts, poolOpen: false })).toEqual({ kind: "drop", reason: "pool-closed" });
    expect(askRetryDecision(row, { ...facts, poolOpen: null })).toEqual({ kind: "wait" });
  });

  it("the pool asked for this match since (the page, a notice, the automatic ask): dropped", () => {
    expect(askRetryDecision(row, { ...facts, askedSince: true })).toEqual({ kind: "drop", reason: "asked-since" });
  });

  it("a refusal that is not kept (an old row, a code renamed): dropped", () => {
    expect(askRetryDecision({ ...row, refusal: "too-late" }, facts)).toEqual({ kind: "drop", reason: "not-retryable" });
  });

  it("expiry is judged before the venue: an expired ask never waits", () => {
    expect(askRetryDecision(row, { ...facts, now: CUTOFF, stillRefused: true })).toEqual({ kind: "drop", reason: "expired" });
  });
});
