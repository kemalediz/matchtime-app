/**
 * A POOL ROUND'S RULES (slice L5a, 2026-10-24). PURE: no database, no
 * clock of its own. The runner is `round.ts`.
 *
 * Approved decision (brief): partners first, the pool after 1 hour, or at
 * once when no partner club is being asked; the organiser approves the
 * round with one tap; the club's automatic ask (`poolAutoAsk`) is L9.
 * Superseded for organiser asks (Kemal, 2026-10-29, decisions log L5a.11):
 * MatchTime asks exactly the places the organiser names, now; only the
 * automatic ask still gives the partners their hour (`POOL_WAITS_FOR_PARTNERS_VIA`).
 *
 *   poolAskRefusal     may this organiser ask the pool for this match now.
 *                      The match gate is L4's `matchGate`; the club caps
 *                      are L4's `clubRoundRefusal`; nobody near is refused
 *                      too (an ask that can reach nobody is noise).
 *   wave1DueAt         the first offers go at once for an organiser's ask;
 *                      for the automatic ask, an hour after it while a
 *                      partner ask of the SAME round is still open, at
 *                      once otherwise (none asked, or all closed unfilled).
 *   poolAskCloseReason when an open ask closes: the switch went off, the
 *                      game is off, the ROUND has its number (partner and
 *                      pool guests counted together, `partner-ask-round.ts`)
 *                      or no place is open, the club's cut-off.
 *   offerOutcomeOnClose / ownTimeRanOut   decision log #8: "ignored" only
 *                      when the offer's own time ran out with no answer;
 *                      closed first by others or the cut-off: "expired";
 *                      never sent: "cancelled".
 *   offerNeverReachedHim   unsent and cancelled: not "already offered".
 *   acceptRefusal      who may still say yes.
 *   pullOutResult      a guest giving the place back: in time, or late.
 */
import { clubRoundRefusal } from "./caps";
import type { MatchGateRefusal } from "./matching-rules";
import type { GuestResult, PoolAskStatus, PoolAskVia, PoolOfferOutcome } from "./vocab";

const MIN_MS = 60_000;

/** Partners first: the pool is asked this long after them (only for the
 *  asks in `POOL_WAITS_FOR_PARTNERS_VIA`). */
export const POOL_AFTER_PARTNERS_MINS = 60;

/**
 * THE ONE SWITCH: which asks give an open partner ask of their round its
 * hour first. Kemal, 2026-10-29: when an organiser asks for the pool and
 * partner clubs, both are asked at once; the pool never waits ("page",
 * "words", "notice"). The automatic ask keeps D-2's partners first, the
 * pool an hour later (Kemal, 2026-10-29, final).
 */
export const POOL_WAITS_FOR_PARTNERS_VIA: ReadonlySet<PoolAskVia> = new Set<PoolAskVia>(["auto"]);

/** Does this ask's first wave wait for the partner clubs right now? */
export function poolWaitsForPartners(a: { via: PoolAskVia | string; partnerAsksOpen: number }): boolean {
  return a.partnerAsksOpen > 0 && POOL_WAITS_FOR_PARTNERS_VIA.has(a.via as PoolAskVia);
}

export type PoolAskRefusal =
  | "pool-closed"
  | "not-organiser"
  | "match-not-open"
  | "no-venue"
  | "no-sport"
  | "too-late"
  | "no-places"
  | "bad-number"
  | "round-open"
  | "club-week-cap"
  | "none-near";

export function poolAskRefusal(i: {
  /** The global switch AND the club's flag. */
  poolOpen: boolean;
  organiser: boolean;
  gate: MatchGateRefusal | null;
  now: Date;
  cutoff: Date;
  placesOpen: number;
  places: number;
  clubAsks: ReadonlyArray<{ matchId: string; status: string; createdAt: Date }>;
  matchId: string;
  /** Pool players who pass every filter and cap now. */
  eligible: number;
}): PoolAskRefusal | null {
  if (!i.poolOpen || i.gate === "pool-closed") return "pool-closed";
  if (!i.organiser) return "not-organiser";
  if (i.gate) return i.gate;
  if (i.now.getTime() >= i.cutoff.getTime()) return "too-late";
  if (i.placesOpen <= 0) return "no-places";
  if (!Number.isInteger(i.places) || i.places < 1 || i.places > i.placesOpen) return "bad-number";
  const club = clubRoundRefusal(i.clubAsks, i.matchId, i.now);
  if (club) return club;
  if (i.eligible <= 0) return "none-near";
  return null;
}

export function wave1DueAt(a: { createdAt: Date; partnerAsksOpen: number; via: PoolAskVia | string }): Date {
  return poolWaitsForPartners(a) ? new Date(a.createdAt.getTime() + POOL_AFTER_PARTNERS_MINS * MIN_MS) : a.createdAt;
}

export type PoolAskCloseReason = "switched-off" | "match-off" | "filled" | "cut-off" | "organiser-cancelled";

export function poolAskCloseReason(i: {
  now: Date;
  cutoff: Date;
  matchLive: boolean;
  poolOpen: boolean;
  roundPlaced: number;
  roundWanted: number;
  placesOpen: number;
}): PoolAskCloseReason | null {
  if (!i.poolOpen) return "switched-off";
  if (!i.matchLive) return "match-off";
  if (i.roundPlaced >= i.roundWanted || i.placesOpen <= 0) return "filled";
  if (i.now.getTime() >= i.cutoff.getTime()) return "cut-off";
  return null;
}

export function askStatusFor(reason: PoolAskCloseReason): Exclude<PoolAskStatus, "open"> {
  if (reason === "filled") return "filled";
  if (reason === "organiser-cancelled") return "cancelled";
  return "closed";
}

/**
 * An offer that never reached him: its DM never went and it ended
 * "cancelled" (the round closed first, dispatch refused it, or the send
 * failed). It is no offer for "one per match": he may be offered this
 * match again. One with a sentAt counts, whatever its outcome.
 */
export function offerNeverReachedHim(o: { sentAt: Date | null; outcome: string | null }): boolean {
  return !o.sentAt && o.outcome === "cancelled";
}

/** An open offer when its ask closes. */
export function offerOutcomeOnClose(o: { sentAt: Date | null }): Extract<PoolOfferOutcome, "cancelled" | "expired"> {
  return o.sentAt ? "expired" : "cancelled";
}

/** Did this open offer's OWN time run out (it counts as ignored)? Its
 *  expiry is its six hours or the cut-off, whichever came first: only the
 *  six hours make it his doing. */
export function ownTimeRanOut(o: { sentAt: Date | null; expiresAt: Date; cutoff: Date; now: Date }): boolean {
  return !!o.sentAt && o.expiresAt.getTime() < o.cutoff.getTime() && o.now.getTime() >= o.expiresAt.getTime();
}

export type AcceptRefusal = "answered" | "not-sent" | "pool-closed" | "match-off" | "gone" | "expired" | "profile-off";

export function acceptRefusal(o: {
  outcome: string | null;
  sentAt: Date | null;
  expiresAt: Date;
  askStatus: string;
  matchLive: boolean;
  kickoff: Date;
  profileActive: boolean;
  /** The global switch AND the club's flag, at tap time (review minor 2). */
  poolOpen: boolean;
  now: Date;
}): AcceptRefusal | null {
  if (o.outcome) return "answered";
  if (!o.sentAt) return "not-sent";
  if (!o.poolOpen) return "pool-closed";
  if (!o.matchLive || o.now.getTime() >= o.kickoff.getTime()) return "match-off";
  if (o.askStatus !== "open") return "gone";
  if (o.now.getTime() >= o.expiresAt.getTime()) return "expired";
  if (!o.profileActive) return "profile-off";
  return null;
}

export function pullOutResult(a: { now: Date; cutoff: Date }): Extract<GuestResult, "withdrawn" | "late-cancel"> {
  return a.now.getTime() < a.cutoff.getTime() ? "withdrawn" : "late-cancel";
}
