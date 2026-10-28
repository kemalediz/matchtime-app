/**
 * A REFUSED ASK, ASKED AGAIN ONCE THE CLUB HAS FIXED WHAT WAS MISSING
 * (Kemal, 2026-10-28). PURE: no database, no clock of its own. The store
 * is `ask-retry.ts`; the retry itself is `../pool-ask-retry.ts`.
 *
 * The real case: MT Test's organiser asked the pool for players at 15:37,
 * the pool refused "no-venue", he set the game's venue on the web at 15:39
 * and then had to come back and say so, and got "I can't change that by
 * message". Now the refusal is remembered, and the venue being set asks
 * again on its own, in the group it was asked in.
 *
 * WHICH REFUSALS ARE KEPT. Every refusal of the pool ask (`round-rules.ts`
 * `PoolAskRefusal`) and of the partner ask (`partner-ask-rules.ts`
 * `AskRefusal`) was looked at. Two are fixed by a club setting:
 *
 *   no-venue   the game's venue has no position (the pool measures from
 *              it). Fixed when a place is linked to the game; every writer
 *              of that link calls `retryAsksAwaitingVenue`.
 *   no-sport   the club's sport is not one the pool has. Fixed by changing
 *              the club's sport, which no hook watches yet: NOT kept.
 *
 * Everything else is about the moment (too-late, no-places, round-open,
 * club-week-cap, none-near, match-not-open), who asked (not-organiser), a
 * typo (bad-number) or the platform (pool-closed). The partner ask has no
 * refusal a venue fixes; its settings refusals (partnership-inactive,
 * asking-off) and the partner club's own state are another club's or a
 * deliberate choice, so the partner part is never stored. A pool ask asked
 * again joins a partner round still open on the match (`poolAutoRound`).
 *
 * HOW LONG ONE IS KEPT: a day at most, and never past the club's cut-off
 * (nothing may be asked after it) or kickoff. A day, because an organiser
 * who fixed the venue days later has moved on, and an ask out of nowhere
 * would read as a mistake; the cut-off, because a retry then could only be
 * refused "too late".
 */
import type { PoolAskRefusal } from "./round-rules";

/** The refusals a club setting fixes, and what fixes each. */
export const FIXABLE_BY_A_SETTING = {
  "no-venue": "the game's venue linked to a place (the web's venue line, a new game, the WhatsApp venue setter)",
  "no-sport": "the club's sport changed to one the pool has (not watched yet, so not kept)",
} as const satisfies Partial<Record<PoolAskRefusal, string>>;

/** The refusals stored and asked again, each with a hook that fires when it is fixed. */
export const ASK_RETRY_REFUSALS = ["no-venue"] as const satisfies ReadonlyArray<keyof typeof FIXABLE_BY_A_SETTING>;
export type AskRetryRefusal = (typeof ASK_RETRY_REFUSALS)[number];

export function isRetryableRefusal(refusal: string): refusal is AskRetryRefusal {
  return (ASK_RETRY_REFUSALS as readonly string[]).includes(refusal);
}

/** The longest a refused ask waits for its fix (see the header). */
export const ASK_RETRY_MAX_AGE_MS = 24 * 3600_000;

export function askRetryExpiresAt(a: { createdAt: Date; kickoff: Date; cutoff: Date }): Date {
  return new Date(Math.min(a.createdAt.getTime() + ASK_RETRY_MAX_AGE_MS, a.cutoff.getTime(), a.kickoff.getTime()));
}

export interface AskRetryFacts {
  now: Date;
  kickoff: Date;
  /** The club's cut-off for this match. */
  cutoff: Date;
  /** Live, not historical, not cancelled or played. */
  matchOpen: boolean;
  placesOpen: number;
  /** The platform switch and the club's flag; null when the switch could not be read. */
  poolOpen: boolean | null;
  /** A pool ask for this match was opened after the refused one. */
  askedSince: boolean;
  /** The pool's gate still says the stored refusal (nothing fixed yet). */
  stillRefused: boolean;
}

export type AskRetryDropReason = "done" | "not-retryable" | "expired" | "match-off" | "no-places" | "pool-closed" | "asked-since";
export type AskRetryDecision = { kind: "retry" } | { kind: "wait" } | { kind: "drop"; reason: AskRetryDropReason };

/**
 * What a stored refused ask comes to now. "retry": ask again (after
 * claiming it, once). "wait": not yet fixed, or the switch unread; keep
 * it. "drop": it no longer makes sense; it is closed, and nothing is said.
 */
export function askRetryDecision(row: { createdAt: Date; claimedAt: Date | null; refusal: string }, f: AskRetryFacts): AskRetryDecision {
  const drop = (reason: AskRetryDropReason): AskRetryDecision => ({ kind: "drop", reason });
  if (row.claimedAt) return drop("done");
  if (!isRetryableRefusal(row.refusal)) return drop("not-retryable");
  if (f.now.getTime() >= askRetryExpiresAt({ createdAt: row.createdAt, kickoff: f.kickoff, cutoff: f.cutoff }).getTime()) return drop("expired");
  if (!f.matchOpen) return drop("match-off");
  if (f.poolOpen === false) return drop("pool-closed");
  if (f.askedSince) return drop("asked-since");
  if (f.placesOpen <= 0) return drop("no-places");
  if (f.poolOpen === null || f.stillRefused) return { kind: "wait" };
  return { kind: "retry" };
}
