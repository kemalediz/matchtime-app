/**
 * MatchTime's numbered list of places, logged as its question (2026-10-28),
 * so the organiser's pick ("@Match Time 2") is found by position and looked
 * up again for the same words (`venue-from-words-rules.ts`
 * `venuePickAskRef`, `group-admin-followups.ts`; in HQ,
 * `admin-group-understand.ts`). Never throws.
 */
import { recordGroupQuestion, recordMatchTimeQuestion } from "./admin-group-log";
import { venuePickAskRef } from "./venue-from-words-rules";

/** In the players' group. */
export async function recordVenueList(a: { orgId: string; words: string; text: string; now: Date }): Promise<void> {
  await recordGroupQuestion({ orgId: a.orgId, askRef: venuePickAskRef(a.words), text: a.text, now: a.now });
}

/** In the organisers' group (HQ). */
export async function recordHqVenueList(a: { orgId: string; words: string; text: string; now: Date }): Promise<void> {
  try {
    await recordMatchTimeQuestion({ orgId: a.orgId, askRef: venuePickAskRef(a.words), text: a.text, now: a.now });
  } catch (err) {
    console.error(`[venue-words] org=${a.orgId}: the list was not logged:`, err instanceof Error ? err.message : "failed");
  }
}
