/**
 * A GUEST'S GAME, AS THE DM ANSWER IS SHOWN IT (2026-11-17). Pure.
 *
 * A guest an organiser added is not in the club's WhatsApp group, so every
 * question he has comes by DM, to the scoped answer (`unified-dm.ts`). The
 * club's UPCOMING MATCH line names the venue only; a guest also needs what
 * his welcome DM gave him: the address, the map link, the format, the fee
 * and his place. This block is those facts, read from the club's data and
 * nothing else, so "where is it?", "is there parking?" and "how much?" are
 * answered from the CONTEXT (or honestly not, when the club has not set
 * it). Facts only, no rules: the answer's prompt is unchanged.
 */
import { longDayTimeLabel } from "../i18n/dates";
import type { GuestGameFacts } from "./copy";

export function formatGuestGameBlock(f: GuestGameFacts, status: "CONFIRMED" | "BENCH" | string | null): string {
  const venue = [f.venue?.trim() || null, f.address?.trim() && f.address.trim() !== f.venue?.trim() ? f.address.trim() : null].filter(Boolean).join(", ");
  const lines = [
    "THE ASKER IS A GUEST of the club, booked for this one game. He is not in the club's WhatsApp group, so he asks MatchTime here. His game:",
    `- When: ${longDayTimeLabel("en", f.kickoff)} (London)`,
    f.format?.trim() ? `- Format: ${f.format.trim()}` : null,
    `- Venue: ${venue || "not set"}`,
    f.mapUrl ? `- Map: ${f.mapUrl}` : null,
    f.fee?.kind === "amount" ? `- Fee: ${f.fee.amount}${f.monthly ? ", pay as you go" : " a player"}` : f.fee?.kind === "free" ? "- Fee: none" : null,
    `- His place: ${status === "CONFIRMED" ? "in the squad" : "on the bench"}`,
    "- To drop out he replies OUT here.",
  ];
  return lines.filter((l): l is string => !!l).join("\n");
}
