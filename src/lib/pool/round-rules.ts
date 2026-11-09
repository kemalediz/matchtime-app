/**
 * A POOL ROUND'S RULES (slice L5a, 2026-10-24). PURE: no database, no
 * clock of its own. The runner is `round.ts`.
 *
 * Approved decision (brief): the organiser approves the round with one
 * tap. Kemal, 2026-10-29 (decisions log L5a.11): MatchTime asks exactly the
 * places the organiser names, now, at the same time as any partner clubs
 * of the round. Kemal, 2026-11-08: nothing asks by itself; the automatic
 * ask (L9) and the hour it gave the partners first were removed.
 *
 *   poolAskRefusal     may this organiser ask the pool for this match now.
 *                      The match gate is L4's `matchGate`; the club caps
 *                      are L4's `clubRoundRefusal`; nobody near is refused
 *                      too (an ask that can reach nobody is noise).
 *   poolRoundToJoin    the round a pool ask joins: a partner round still
 *                      open on the match, for its number, or one of its own.
 *   poolAskCloseReason when an open ask closes: the switch went off, the
 *                      game is off, the ROUND has its number (partner and
 *                      pool guests counted together, `partner-ask-round.ts`)
 *                      or no place is open, or KICKOFF. Not the club's
 *                      cut-off (Kemal, 2026-11-09): offers already sent stay
 *                      open until the game starts; the cut-off only stops
 *                      new asks and waves (`poolAskRefusal`, `waves.ts`).
 *   offerOutcomeOnClose decision log #8, how each open offer ends with its
 *                      ask: sent and still unanswered at kickoff, "ignored"
 *                      (it was his to answer, and it counts toward the
 *                      pause); closed first by anything else (filled, called
 *                      off, cancelled, switched off): "expired", never his
 *                      doing; never sent: "cancelled".
 *   offerNeverReachedHim   unsent and cancelled: not "already offered".
 *   acceptRefusal      who may still say yes.
 *   pullOutResult      a guest giving the place back: in time, or late.
 */
import { clubRoundRefusal } from "./caps";
import { offerEndsAt } from "./waves";
import type { MatchGateRefusal } from "./matching-rules";
import type { GuestResult, PoolAskStatus, PoolOfferOutcome } from "./vocab";

/** The round a pool ask joins: the newest partner round still open on the
 *  match, for its number (never more than the places open now), or a round
 *  of its own for every open place. Its offers go at once either way. */
export function poolRoundToJoin(i: { openRound: { roundId: string; places: number } | null; placesOpen: number }): { roundId: string | null; places: number } {
  if (i.openRound) return { roundId: i.openRound.roundId, places: Math.min(i.openRound.places, i.placesOpen) };
  return { roundId: null, places: i.placesOpen };
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

/** "cut-off" is only on old rows: since 2026-11-09 an ask stays open past
 *  the club's cut-off and closes at "kickoff". */
export type PoolAskCloseReason = "switched-off" | "match-off" | "filled" | "kickoff" | "organiser-cancelled";

export function poolAskCloseReason(i: {
  now: Date;
  kickoff: Date;
  /** The match is on (an open status, not historical); kickoff is separate. */
  matchLive: boolean;
  poolOpen: boolean;
  roundPlaced: number;
  roundWanted: number;
  placesOpen: number;
}): PoolAskCloseReason | null {
  if (!i.poolOpen) return "switched-off";
  if (!i.matchLive) return "match-off";
  if (i.roundPlaced >= i.roundWanted || i.placesOpen <= 0) return "filled";
  if (i.now.getTime() >= offerEndsAt(i.kickoff).getTime()) return "kickoff";
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

/** An open offer when its ask closes for `reason`. Only kickoff makes an
 *  unanswered offer his doing ("ignored"); anything that ended the round
 *  first is not ("expired"). One that never reached him: "cancelled". */
export function offerOutcomeOnClose(
  o: { sentAt: Date | null },
  reason: PoolAskCloseReason,
): Extract<PoolOfferOutcome, "cancelled" | "expired" | "ignored"> {
  if (!o.sentAt) return "cancelled";
  return reason === "kickoff" ? "ignored" : "expired";
}

export type AcceptRefusal = "answered" | "not-sent" | "pool-closed" | "match-off" | "gone" | "expired" | "profile-off";

export function acceptRefusal(o: {
  outcome: string | null;
  sentAt: Date | null;
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
  if (!o.matchLive) return "match-off";
  if (o.askStatus !== "open") return "gone";
  // Open until kickoff (Kemal, 2026-11-09), however long ago it was sent.
  if (o.now.getTime() >= offerEndsAt(o.kickoff).getTime()) return "expired";
  if (!o.profileActive) return "profile-off";
  return null;
}

export function pullOutResult(a: { now: Date; cutoff: Date }): Extract<GuestResult, "withdrawn" | "late-cancel"> {
  return a.now.getTime() < a.cutoff.getTime() ? "withdrawn" : "late-cancel";
}
