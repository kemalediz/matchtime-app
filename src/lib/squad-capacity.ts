/**
 * WHO MAY TAKE A FREE PLACE (slice 2b, 2026-10-01).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, section 2.6.
 *
 * Capacity is decided twice: `pipeline/engine.ts:applyClaim` decides
 * CONFIRMED or BENCH for the react (✅ or 🪑), and
 * `attendance.ts:registerAttendance` decides it again for the write. Both
 * call THIS function, so the react can never say ✅ while the row says
 * BENCH.
 *
 *   first-come  a place is free: take it. Today's rule, byte for byte,
 *               and every club's setting until it chooses otherwise
 *               (Sutton FC included).
 *   organiser   MatchTime never fills a place by itself. A free place is
 *               taken only by an admin (an admin's own IN, an admin's
 *               instruction, an admin screen), a RECLAIM (a player who was
 *               in, said OUT and says IN again while the place is still
 *               free: "sorry, wrong group, I'm in" must not cost a regular
 *               his place), or while the fallback offer is running (an
 *               open BenchSlotOffer, section 2.11). Everyone else lands on
 *               the waiting list, and the admins pick.
 *
 * Pure: no database, no clock.
 */

export type BenchPickMode = "first-come" | "organiser";
export type BenchPickFallback = "bench-offer" | "leave-empty";

export function normaliseBenchPickMode(raw: unknown): BenchPickMode {
  return raw === "organiser" ? "organiser" : "first-come";
}

export function normaliseBenchPickFallback(raw: unknown): BenchPickFallback {
  return raw === "leave-empty" ? "leave-empty" : "bench-offer";
}

export interface FreePlaceInput {
  confirmed: number;
  maxPlayers: number;
  pickMode: BenchPickMode;
  /** An OWNER/ADMIN instruction or screen, or an admin's own IN. */
  actorIsAdmin: boolean;
  /** This player's last move on this match was CONFIRMED to DROPPED. */
  isReclaim: boolean;
  /** A BenchSlotOffer is open on this match (the fallback is running). */
  openBenchOffer: boolean;
}

export function canTakeFreePlace(p: FreePlaceInput): boolean {
  const room = p.confirmed < p.maxPlayers;
  if (p.pickMode !== "organiser") return room;
  return room && (p.actorIsAdmin || p.isReclaim || p.openBenchOffer);
}

/** The note on a BENCH row written because the organisers pick. */
export const ORGANISER_PICK_BENCH_NOTE = "organiser picks who plays";
