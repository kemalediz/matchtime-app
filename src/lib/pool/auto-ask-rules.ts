/**
 * THE AUTOMATIC ASK INCLUDES THE POOL (slice L9, 2026-10-24). PURE: no
 * database, no clock of its own. The adapter is `auto-ask.ts`, called from
 * the automatic partner ask (`partner-ask.ts` `sweepAutoPartnerAsks`).
 *
 * Approved decision 1: the organiser approves a pool round with one tap,
 * and a club can switch on automatic asking (`Organisation.poolAutoAsk`,
 * off by default). Switched on, the club's automatic ask approves the round
 * instead of the tap, and everything after it is the tap's own path
 * (`round.ts` `requestPoolAsk`): every cap, quiet hours, the cut-off, the
 * switches, partners first.
 *
 *   poolAutoAskApplies  the club level: the pool is open for the club, its
 *                       automatic pool ask is on, and, when it has partner
 *                       clubs, it asks them automatically too (with
 *                       partners on When we ask, the organisers decide
 *                       every round themselves, the pool included).
 *   poolAutoAskDue      the match level: the automatic partner ask's own
 *                       rule (`autoAskDue`: match day from the club's time
 *                       until the cut-off, a place open, the club's own
 *                       bench empty), once per match for the pool.
 *   poolAutoRound       the round it joins: the partners asked in this same
 *                       pass, else a partner round still open on the match
 *                       (so the pool still waits for the partners' hour),
 *                       else a round of its own (offers at once).
 */
import { autoAskDue } from "../partner-ask-rules";

export interface PoolAutoClub {
  /** The global switch AND the club's flag (`poolOffersOpenForClub`). */
  poolOpen: boolean;
  /** `Organisation.poolAutoAsk`. */
  poolAutoAsk: boolean;
  /** Any active partnership where this club asks. */
  hasPartners: boolean;
  /** `Organisation.partnerAskWhen`. */
  partnersWhen: string;
}

export function poolAutoAskApplies(c: PoolAutoClub): boolean {
  if (!c.poolOpen || !c.poolAutoAsk) return false;
  return !c.hasPartners || c.partnersWhen === "auto";
}

export interface PoolAutoAskInput extends PoolAutoClub {
  now: Date;
  /** `autoAskAt(kickoff, the club's time)`. */
  askAt: Date;
  /** The club's cut-off (`askWindows(...).postBy`). */
  postBy: Date;
  placesOpen: number;
  /** BENCH rows of the club's match: its own bench. */
  waitingCount: number;
  /** Any pool ask for this match by this club, open or closed. */
  poolAskedBefore: boolean;
}

export function poolAutoAskDue(i: PoolAutoAskInput): boolean {
  if (!poolAutoAskApplies(i)) return false;
  return autoAskDue({
    now: i.now,
    askAt: i.askAt,
    postBy: i.postBy,
    placesOpen: i.placesOpen,
    waitingCount: i.waitingCount,
    askedBefore: i.poolAskedBefore,
    partnerOwnGameShort: false,
  });
}

export function poolAutoRound(i: {
  /** The round id this pass's partner asks share, when any was made. */
  askedNowRoundId: string | null;
  /** The newest partner round still open on the match, with its number. */
  openRound: { roundId: string; places: number } | null;
  placesOpen: number;
}): { roundId: string | null; places: number } {
  if (i.askedNowRoundId) return { roundId: i.askedNowRoundId, places: i.placesOpen };
  if (i.openRound) return { roundId: i.openRound.roundId, places: Math.min(i.openRound.places, i.placesOpen) };
  return { roundId: null, places: i.placesOpen };
}

// ── The setting on /admin/settings ──────────────────────────────────────

/** Shown, and saved, only while the club may ask the pool: the same rule
 *  as Style of play (`play-style.ts`), one definition. */
export { playStyleShown as poolAutoAskShown } from "./play-style";

export function parsePoolAutoAsk(v: unknown): { ok: true; value: boolean } | { ok: false } {
  return typeof v === "boolean" ? { ok: true, value: v } : { ok: false };
}
