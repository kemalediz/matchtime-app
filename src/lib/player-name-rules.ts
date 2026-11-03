/**
 * Pure name rules for printing a player, with no database behind them
 * (2026-11-03). Lifted out of `player-display-name.ts`, unchanged, so the
 * copy builders (`monthly-week-copy.ts`, which the Playwright harness
 * loads in-process, where Prisma cannot run) can use the same test of
 * what counts as a name. `player-display-name.ts` re-exports it.
 */

const RAW_PHONE = /(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/;

/** The name as printed: whitespace collapsed and trimmed, or null when it
 *  is empty, has no letter, or is a phone number. */
export function usableName(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!v || RAW_PHONE.test(v) || !/\p{L}/u.test(v)) return null;
  return v;
}
