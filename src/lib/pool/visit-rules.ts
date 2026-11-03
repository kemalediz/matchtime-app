/**
 * VISITS TO /play PER CAMPAIGN CODE, the pure half (2026-11-03). No
 * database, no clock of its own. The I/O half is `visits.ts`.
 *
 * WHY. A campaign code attributes SIGN-UPS (`PoolProfile.sourceCode`), but
 * nothing counted visits, so a post with no sign-ups could not say whether
 * people clicked and gave up or never clicked. A visit is counted per
 * bucket and London day, and nothing about the person is kept.
 *
 * WHAT COUNTS. The /play page sends one beacon from the browser after it
 * loads (`src/app/play/visit-beacon.tsx`), once per tab session. A link
 * preview fetcher (Facebook, Nextdoor, WhatsApp, X) reads the HTML and runs
 * no script, so it never sends it; the user-agent check below is the second
 * guard, for fetchers and scripted browsers that do run script.
 */
import { formatInTimeZone } from "date-fns-tz";
import { isLinkPreviewFetcher } from "../link-preview-fetchers";

export { isLinkPreviewFetcher };

/** /play with no live campaign code: counted with the "web" sign-ups. */
export const POOL_VISIT_DIRECT = "_direct";
/** A friend's /play?ref= link: counted with the "referral" sign-ups. */
export const POOL_VISIT_REFERRAL = "_referral";

/**
 * The bucket a visit counts under, in the order `signup.ts` resolveSource
 * attributes the sign-up: a friend's link, else a LIVE campaign code, else
 * direct. So a switched-off or unknown code's visits count as direct, as its
 * sign-ups count as the web.
 */
export function poolVisitBucket(
  source: { campaignCode: string | null; referralCode: string | null },
  facts: { campaignLive: boolean },
): string {
  if (source.referralCode) return POOL_VISIT_REFERRAL;
  if (source.campaignCode && facts.campaignLive) return source.campaignCode;
  return POOL_VISIT_DIRECT;
}

/** The London day a visit counts on, as "yyyy-MM-dd". */
export function poolVisitDay(now: Date): string {
  return formatInTimeZone(now, "Europe/London", "yyyy-MM-dd");
}

/** Every day's count added up, per bucket. */
export function poolVisitTotals(rows: ReadonlyArray<{ code: string; count: number | null }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.code, (out.get(r.code) ?? 0) + (r.count ?? 0));
  return out;
}
