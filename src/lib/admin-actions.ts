/**
 * THE ACTIONS OF ONE ADMIN READING (2026-11-23, review of #629).
 *
 * The admin extractor reports every action a message asks for, in order:
 * `AdminFacts` is the first, `then` the rest. A reader that does ONE kind of
 * action (a DM asking the partner clubs, a DM setting a season break, the
 * attendance path's "where from?") finds its action wherever it sits, and
 * gets the others so it can name them as not done instead of dropping them
 * silently. PURE.
 */
import type { AdminFacts, Facts } from "./pipeline/types";

/** Every action of a reading, in order, each without a `then`. [] when the
 *  facts are not admin facts. */
export function adminActionsOf(f: Facts | AdminFacts | null | undefined): AdminFacts[] {
  if (!f || f.kind !== "admin") return [];
  const { then, ...first } = f as AdminFacts;
  return [first, ...(then ?? [])];
}

/** The first action the reader can do, and every other action of the
 *  reading (to be named as not done). */
export function pickAdminAction(
  f: Facts | AdminFacts | null | undefined,
  can: (a: AdminFacts) => boolean,
): { picked: AdminFacts | null; others: AdminFacts[] } {
  const all = adminActionsOf(f);
  const i = all.findIndex(can);
  if (i < 0) return { picked: null, others: all };
  return { picked: all[i], others: all.filter((_, j) => j !== i) };
}

/** Does the reading hold more than one action? */
export function severalActions(f: Facts | AdminFacts | null | undefined): boolean {
  return adminActionsOf(f).length > 1;
}
