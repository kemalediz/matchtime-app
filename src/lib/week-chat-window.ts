/**
 * THE WEEK OF CHAT A MODEL READS (Kemal, 2026-11-10: "recent chat should
 * be all messages since last 1 week"). Constants only, so a pure reader
 * (`pipeline/open-answer.ts`) can share them without the database; the
 * loader is `week-chat.ts`.
 */
export const WEEK_CHAT_DAYS = 7;
export const WEEK_CHAT_MS = WEEK_CHAT_DAYS * 24 * 60 * 60 * 1000;
/** The newest lines kept, the rating adjuster's 300 since 2026-10-20. */
export const WEEK_CHAT_MAX_LINES = 300;
