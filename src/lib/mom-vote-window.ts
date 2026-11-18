/**
 * WHEN A MAN OF THE MATCH VOTE IS OPEN (review of #608, round 3). PURE.
 *
 * Kickoff plus the activity's `ratingWindowHours` (1 to 168, 120 by
 * default), the closing instant included. One rule for the web vote
 * (`actions/ratings.ts`), the WhatsApp poll vote (`api/whatsapp/poll-vote`)
 * and the answer's loader (`mom-records.ts`): once the window is over no
 * path adds, changes or clears a vote, so the result is final everywhere.
 */
const HOUR_MS = 60 * 60 * 1000;

export function momVoteClosesAt(kickoff: Date, ratingWindowHours: number): Date {
  return new Date(kickoff.getTime() + ratingWindowHours * HOUR_MS);
}

export function momVoteOpen(kickoff: Date, ratingWindowHours: number, now: Date): boolean {
  return now.getTime() <= momVoteClosesAt(kickoff, ratingWindowHours).getTime();
}
