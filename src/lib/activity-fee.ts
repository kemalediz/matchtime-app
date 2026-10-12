/**
 * THE WEEKLY GAME'S FEE PER PLAYER, as the organiser types it (go-live
 * slice D3, 2026-10-12). Pure.
 *
 * `Activity.feePerPlayer` (pounds, null for none) had no place on the
 * website where an organiser could enter it. The setup reading now
 * SUGGESTS a fee when the group's chat or description states one
 * (setup-learning/rules.ts, rule 8), and a suggestion needs somewhere to
 * go: the edit form of the weekly game on /admin/activities.
 *
 * Empty means "no fee". Otherwise a number above zero, at most
 * MAX_ACTIVITY_FEE, kept to the penny. "6", "6.5", "6,50" and "£6" are
 * all six pounds or six fifty.
 */

/** The same ceiling the monthly squad prices use (`msq_err_price`). */
export const MAX_ACTIVITY_FEE = 100;

export type ActivityFeeInput = { ok: true; fee: number | null } | { ok: false };

export function parseActivityFee(raw: unknown): ActivityFeeInput {
  if (raw === null || raw === undefined) return { ok: true, fee: null };
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const text = raw.trim().replace(/^£\s*/, "").replace(",", ".");
    if (text === "") return { ok: true, fee: null };
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return { ok: false };
    n = Number(text);
  } else {
    return { ok: false };
  }
  if (!Number.isFinite(n) || n <= 0 || n > MAX_ACTIVITY_FEE) return { ok: false };
  return { ok: true, fee: Math.round(n * 100) / 100 };
}

/** A stored fee as the form and the list show it: "6", "6.50", "" for none. */
export function activityFeeText(fee: number | null | undefined): string {
  if (fee == null || !(fee > 0)) return "";
  return Number.isInteger(fee) ? String(fee) : fee.toFixed(2);
}
