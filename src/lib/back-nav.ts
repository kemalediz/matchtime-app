/**
 * Where a page's "Back to MatchTime" control takes the reader (Kemal,
 * 2026-10-27: back from the privacy policy took him home and lost his
 * sign-up). PURE and CLIENT-SAFE; `BackToSiteLink` runs it on click.
 *
 *   - came from another page of this site, in this tab: go back to it;
 *   - came from this site in a tab of its own (a form's "opens in a new
 *     tab" link): close that tab, and if the browser will not, open the
 *     page he came from;
 *   - anything else (another site, no referrer, the same page): home.
 */
export type BackAction = { kind: "back" } | { kind: "close"; fallback: string } | { kind: "home" };

export function backAction(a: { referrer: string; origin: string; historyLength: number; here?: string }): BackAction {
  let from: URL;
  try {
    from = new URL(a.referrer);
  } catch {
    return { kind: "home" };
  }
  if (from.origin !== a.origin) return { kind: "home" };
  if (from.pathname === (a.here ?? "/privacy")) return { kind: "home" };
  if (a.historyLength > 1) return { kind: "back" };
  return { kind: "close", fallback: `${from.pathname}${from.search}` };
}
