/**
 * The guest card's sentences (pool slice L5b), shared by the card (client)
 * and the Guest players lists (server). No "use client": both sides call it.
 */
import type { Strings } from "@/lib/i18n/t";
import type { GuestCard } from "@/lib/pool/guest-report";
import type { TurnUpRecord } from "@/lib/pool/turn-up";

/** "Turned up to 5 of 6 games", or "New to MatchTime". */
export function turnUpText(s: Strings, r: TurnUpRecord): string {
  const games = r.played + r.missed;
  return games === 0 ? s.gst_record_new : s.gst_record({ played: r.played, games });
}

/** "MatchTime player pool", or "From <partner club>". */
export function guestSourceText(s: Strings, c: Pick<GuestCard, "source" | "fromClub">): string {
  if (c.source === "pool") return s.gst_source_pool;
  return c.fromClub ? s.gst_source_partner({ club: c.fromClub }) : s.gst_source_partner_unknown;
}

export const guestName = (s: Strings, c: Pick<GuestCard, "name">): string => c.name ?? s.gst_nameless;
