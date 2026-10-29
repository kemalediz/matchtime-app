/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG: THE PURE RULES
 * (Vets MNF, 2026-10-26).
 *
 * "Alright, so it's off gents, enjoy your evenings at home" from an
 * organiser, untagged, left the game live, so MatchTime would have gone on
 * posting reminders, teams and payment chases for a game nobody was
 * playing. The players' group stays silent (MatchTime speaks there only
 * when tagged); the organiser is asked ONCE by DM whether to cancel it.
 *
 * Code gates only on FACTS: who sent it (a known owner or admin), how (no
 * tag, on time, the club under its AI cap) and whether a game is coming.
 * Whether the words call the game off is the model's call
 * (`calloff-reader.ts`), read against the group's recent chat.
 */

/** The SentNotification kind of an open offer, and of one answered. */
export const CALLOFF_OFFER_KIND = "calloff-offer";
export const CALLOFF_OFFER_CLOSED_KIND = "calloff-offer-closed";

/** How far ahead "the next game" is looked for. */
export const CALLOFF_LOOKAHEAD_DAYS = 7;
/** "It's off" said just after kickoff is still about that game. */
export const CALLOFF_AFTER_KICKOFF_HOURS = 6;
/** How long the organiser's "cancel" is read as the answer to the DM. */
export const CALLOFF_OFFER_OPEN_HOURS = 24;

/** The statuses of a game that is still on. */
export const CALLOFF_GAME_STATUSES = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

/** One key per organiser per game: the DM goes once. */
export function calloffOfferKey(matchId: string, userId: string): string {
  return `${matchId}:calloff-offer:${userId}`;
}

export interface CalloffCandidateInput {
  /** Any tag at all, a reply to MatchTime included: the tagged path owns it. */
  tagged: boolean;
  senderKnown: boolean;
  /** An owner or admin of the club. */
  organiser: boolean;
  late: boolean;
  capped: boolean;
}

/** Is this message one the call-off reader may be asked about? (pure) */
export function isCalloffCandidate(i: CalloffCandidateInput): boolean {
  return !i.tagged && i.senderKnown && i.organiser && !i.late && !i.capped;
}

/** The soonest game still on, from 6 hours ago to 7 days ahead. (pure) */
export function nextGameForCalloff<T extends { id: string; date: Date; status: string }>(matches: T[], now: Date): T | null {
  const from = now.getTime() - CALLOFF_AFTER_KICKOFF_HOURS * 3600_000;
  const to = now.getTime() + CALLOFF_LOOKAHEAD_DAYS * 24 * 3600_000;
  const on = matches
    .filter((m) => (CALLOFF_GAME_STATUSES as readonly string[]).includes(m.status))
    .filter((m) => m.date.getTime() >= from && m.date.getTime() <= to)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  return on[0] ?? null;
}

/** Is the organiser's DM still the answer to the offer? (pure) */
export function calloffOfferOpen(i: { offeredAt: Date; matchStatus: string; now: Date }): boolean {
  if (!(CALLOFF_GAME_STATUSES as readonly string[]).includes(i.matchStatus)) return false;
  return i.now.getTime() - i.offeredAt.getTime() <= CALLOFF_OFFER_OPEN_HOURS * 3600_000;
}
