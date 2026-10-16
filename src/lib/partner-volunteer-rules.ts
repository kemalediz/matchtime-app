/**
 * WHO MAY VOLUNTEER FOR A PARTNER CLUB'S ASK (cross-club ask, slice S3,
 * 2026-10-16). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, 3.6
 * and 3.7. Code decides, never the model: the engine only said WHICH ask a
 * reply is about (the post it quotes); these are the facts on the
 * database at the moment of the write.
 *
 *   - the ask must still be open (posted, before kickoff);
 *   - the sender must be a known member of the partner club (an unknown
 *     sender is never provisioned through an ask);
 *   - his own club's game at an overlapping time must not have him in it
 *     (CONFIRMED or on the bench);
 *   - a member of the asking club already is simply its player: an
 *     ordinary IN, no guest mark; anybody else becomes a guest.
 *
 * Pure.
 */
import { londonWallClockToUtc } from "./london-time";
import { ROLLING_SEED_HOUR } from "./rolling-squad-rules";

export type VolunteerDecision =
  | { kind: "register"; asGuest: boolean }
  | { kind: "withdraw" }
  | { kind: "refuse"; why: "closed" | "unknown-sender" | "overlap" | "not-on-list" | "game-over" };

export interface VolunteerInput {
  polarity: "in" | "out";
  askOpen: boolean;
  /** The sender is resolved and a live member of the PARTNER club. */
  senderIsPartnerMember: boolean;
  /** His own club's game overlapping the asking club's, with him in it. */
  inOverlappingOwnGame: boolean;
  /** A live, ordinary (not guest) member of the asking club. */
  ordinaryAskerMember: boolean;
  /** He has a row (CONFIRMED or BENCH) on the asking club's match. */
  onAskerMatch: boolean;
  /** The asking club's match is still to play (UPCOMING or teams out). */
  askerMatchLive: boolean;
  /** He is already a past guest there (his match is over). */
  pastGuest: boolean;
}

export function decideVolunteer(i: VolunteerInput): VolunteerDecision {
  if (!i.senderIsPartnerMember) return { kind: "refuse", why: "unknown-sender" };
  if (i.polarity === "out") {
    if (!i.onAskerMatch) return { kind: "refuse", why: "not-on-list" };
    // Review H2: never drop a guest from a game that is over or played.
    if (!i.askerMatchLive || i.pastGuest) return { kind: "refuse", why: "game-over" };
    return { kind: "withdraw" };
  }
  if (!i.askOpen) return { kind: "refuse", why: "closed" };
  if (i.inOverlappingOwnGame) return { kind: "refuse", why: "overlap" };
  return { kind: "register", asGuest: !i.ordinaryAskerMember };
}

/** The morning after kickoff, at the rolling squad's hour (plan 3.10:
 *  "the morning after, the rolling sweep, same run"): when a guest becomes
 *  a past guest (Kemal, 2026-10-16). A wall clock, so the same London
 *  time on either side of a clock change. */
export function pastGuestAt(kickoff: Date): Date {
  return londonWallClockToUtc(new Date(kickoff.getTime() + 24 * 3600_000), ROLLING_SEED_HOUR);
}

/** Is his match over for good: the morning after it, or cancelled? */
export function isPastGuestDue(p: { kickoff: Date; status: string; now: Date }): boolean {
  if (p.status === "CANCELLED") return true;
  return p.now.getTime() >= pastGuestAt(p.kickoff).getTime();
}
