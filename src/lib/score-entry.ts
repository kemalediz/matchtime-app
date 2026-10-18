/**
 * When the dashboard offers to enter a match's score (FNF, 2026-10-18).
 *
 * Pure, so the match page (server), the teams page (client, reading the
 * match from JSON) and the result lists all ask the same question.
 *
 * A match can take a score once it has been PLAYED and was not
 * cancelled. "Played" is: already COMPLETED, or kickoff has passed. The
 * second half matters because a club that posts its teams in WhatsApp
 * never presses "Publish teams", so its match goes UPCOMING or
 * TEAMS_GENERATED straight to COMPLETED (`match-completion.ts`) and the
 * score box must not wait on TEAMS_PUBLISHED. Until 2026-10-18 the match
 * page linked to the box only for a match still to be played, and a
 * COMPLETED match without a score had no way in at all.
 */
export type ScoreEntryMatch = {
  status: string;
  date: Date | string;
};

export type ScoredMatch = {
  redScore: number | null;
  yellowScore: number | null;
};

export function canEnterScore(m: ScoreEntryMatch, now: Date = new Date()): boolean {
  if (m.status === "CANCELLED") return false;
  if (m.status === "COMPLETED") return true;
  return new Date(m.date).getTime() <= now.getTime();
}

export function hasScore(m: ScoredMatch): boolean {
  return m.redScore !== null && m.yellowScore !== null;
}

/** "enter" for a played match without a score, "edit" once it has one,
 *  null when the match cannot take a score. */
export function scoreEntryAction(
  m: ScoreEntryMatch & ScoredMatch,
  now: Date = new Date(),
): "enter" | "edit" | null {
  if (!canEnterScore(m, now)) return null;
  return hasScore(m) ? "edit" : "enter";
}
