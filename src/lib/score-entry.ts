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

// ── The score panel on the match page (Kemal, 2026-10-18) ──────────────
// "Enter score" / "Edit score" open a panel on the match page itself
// (src/components/match/score-entry-panel.tsx). The teams page, where the
// box used to live, shows no match date. The result lists' "Add score"
// links open the match page with the panel already open.

/** A score box's text as a whole number of goals, 0 or more; null when
 *  it is anything else (empty, negative, a fraction, letters). Digits
 *  only, so "1e2" or "+3" are not read as numbers either. */
export function parseScoreInput(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export type ScorePairResult =
  | { ok: true; redScore: number; yellowScore: number }
  | { ok: false; field: "red" | "yellow" };

/** Both boxes of the panel, checked before anything is sent. A failure
 *  names the first wrong side so the panel can put the cursor there. */
export function validateScorePair(red: string, yellow: string): ScorePairResult {
  const redScore = parseScoreInput(red);
  if (redScore === null) return { ok: false, field: "red" };
  const yellowScore = parseScoreInput(yellow);
  if (yellowScore === null) return { ok: false, field: "yellow" };
  return { ok: true, redScore, yellowScore };
}

/** The query value that opens the panel when the match page loads. */
export const SCORE_PANEL_PARAM = "score";

/** Where a result list's "Add score" goes: the match page, panel open. */
export function scorePanelHref(matchId: string): string {
  return `/matches/${matchId}?${SCORE_PANEL_PARAM}=1`;
}

/** Whether the match page's `?score=` value asks for the panel open. */
export function shouldOpenScorePanel(value: string | string[] | undefined): boolean {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "1";
}
