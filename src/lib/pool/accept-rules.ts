/**
 * THE OFFER PAGE'S STATE AND THE ORGANISERS' RECORD LINE (slice L5a,
 * 2026-10-24). PURE.
 *
 *   offerPageState     what the tap link's page shows, from the offer's
 *                      outcome, his guest place and the game. Opening the
 *                      page changes nothing (WhatsApp previews links).
 *   organiserRecordOf  the record behind "Played 6 MatchTime games, turned
 *                      up to all of them": his CONFIRMED rows on completed
 *                      games anywhere (own club or as a guest) are games he
 *                      played, less the no-shows organisers marked on his
 *                      guest games (L7); no-shows and late cancels are the
 *                      misses (`turn-up.ts`'s meaning). Counts only: never a
 *                      club name, a rating or a number.
 */
import type { AcceptRefusal } from "./round-rules";
import type { TurnUpRecord } from "./turn-up";

export type OfferPageState = "open" | "in" | "bench" | "declined" | "gone" | "expired" | "off" | "withdrawn" | "invalid" | "busy";

export function offerPageState(o: {
  outcome: string | null;
  /** What `acceptRefusal` says now, for an offer with no outcome. */
  refusal: AcceptRefusal | null;
  guestResult: string | null;
  attendanceStatus: string | null;
  matchLive: boolean;
}): OfferPageState {
  switch (o.outcome) {
    case null:
      if (!o.refusal) return "open";
      if (o.refusal === "match-off") return "off";
      if (o.refusal === "gone") return "gone";
      if (o.refusal === "not-sent") return "invalid";
      return "expired";
    case "accepted":
      if (o.guestResult === "withdrawn" || o.guestResult === "late-cancel") return "withdrawn";
      if (!o.matchLive) return "off";
      if (o.attendanceStatus === "CONFIRMED") return "in";
      if (o.attendanceStatus === "BENCH") return "bench";
      return "withdrawn";
    case "declined":
      return "declined";
    case "filled":
      return "gone";
    default:
      return "expired";
  }
}

export function organiserRecordOf(c: { confirmedCompleted: number; noShows: number; lateCancels: number }): TurnUpRecord {
  return { played: Math.max(0, c.confirmedCompleted - c.noShows), missed: c.noShows + c.lateCancels };
}
