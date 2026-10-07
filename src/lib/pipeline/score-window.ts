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
