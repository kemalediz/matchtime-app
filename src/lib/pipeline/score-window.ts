/**
 * How long after KICKOFF a recorded result can be corrected from the
 * group (2026-10-07). After it, the bot points at the match page.
 *
 * 48 hours: long enough for "hang on, that's the wrong way round" the
 * next morning, short enough that the result is settled before the
 * badges post (18:00 two days after the match) and long before the next
 * weekly game, whose own result becomes the "last played" match anyway.
 *
 * Its own file so the state loader can read it without importing the
 * engine.
 */
export const SCORE_CORRECTION_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How long after a game ENDS (kickoff plus its duration) MatchTime tells
 * the router it is waiting for the score (2026-11-17, Vets: "@Match Time
 * bibs 9, no bibs 4" was read as an instruction because nothing said a
 * score was due). A day: the result comes that night or the next morning,
 * and a line shown for longer only sits above unrelated chat.
 */
export const SCORE_AWAITED_WINDOW_MS = 24 * 60 * 60 * 1000;
