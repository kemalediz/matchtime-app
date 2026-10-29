/**
 * The pure half of the owner's intro messages (2026-10-29), so the DM admin
 * intent (`dm-intent.ts`) can use it without importing the owner DM door.
 * See `owner-intro.ts`.
 */
export type IntroCategory = 1 | 2 | 3;
export const INTRO_CATEGORIES: readonly IntroCategory[] = [1, 2, 3];

/**
 * The categories to send, from what the model listed: each valid one once,
 * in category order. None valid (an empty list, "all", nothing): all three.
 */
export function introCategoriesToSend(raw: unknown): IntroCategory[] {
  const picked = Array.isArray(raw) ? INTRO_CATEGORIES.filter((c) => raw.includes(c)) : [];
  return picked.length > 0 ? picked : [...INTRO_CATEGORIES];
}
