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

export type VolunteerDecision =
  | { kind: "register"; asGuest: boolean }
  | { kind: "withdraw" }
  | { kind: "refuse"; why: "closed" | "unknown-sender" | "overlap" | "not-on-list" };

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
}

export function decideVolunteer(i: VolunteerInput): VolunteerDecision {
  if (!i.senderIsPartnerMember) return { kind: "refuse", why: "unknown-sender" };
  if (i.polarity === "out") return i.onAskerMatch ? { kind: "withdraw" } : { kind: "refuse", why: "not-on-list" };
  if (!i.askOpen) return { kind: "refuse", why: "closed" };
  if (i.inOverlappingOwnGame) return { kind: "refuse", why: "overlap" };
  return { kind: "register", asGuest: !i.ordinaryAskerMember };
}
