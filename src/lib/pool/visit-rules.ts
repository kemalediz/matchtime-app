/**
 * THE /play SIGN-UP FUNNEL PER CAMPAIGN CODE, the pure half (visits
 * 2026-11-03, every step 2026-11-04). No database, no clock of its own. The
 * I/O half is `visits.ts`.
 *
 * WHY. A campaign code attributes SIGN-UPS (`PoolProfile.sourceCode`), and
 * the visits said how many opened the link, but not where the rest stopped:
 * /play was opened 24 times on 4 November and nobody sent the form. So each
 * step a person takes is counted, per bucket and London day, and nothing
 * about the person is kept:
 *   opened     the page loaded in a browser (the page's beacon, once per
 *              tab session);
 *   started    the first time a person enters something in the form: a
 *              trusted input or change that really changed a field, such
 *              as typing a character or ticking a box; focus alone or a
 *              bare click does not count (since 2026-11-06, after a
 *              scanner focused the form; `app/play/funnel-start.ts`). The
 *              beacon too, once per tab session;
 *   sent       the form sent: a waiting sign-up made (`signup.ts`, on the
 *              server, never from the page);
 *   confirmed  his WhatsApp message made it active (`confirm.ts`, the
 *              server too).
 * Each is counted on the day it happens, NOT as a cohort: someone who opens
 * on Monday and sends on Tuesday counts on each day. A count survives the
 * housekeeping that deletes old waiting sign-ups.
 *
 * WHAT COUNTS AS A PERSON. A link preview fetcher (Facebook, Nextdoor,
 * WhatsApp, X) reads the HTML and runs no script, so it never sends the
 * beacon; the user-agent check below is the second guard, for fetchers and
 * scripted browsers that do run script. A scanner that runs script under a
 * browser's user agent still counts as opened, but it no longer counts as
 * started unless it really enters something, and every beacon's user agent
 * is logged on the server (`visits.ts`) so such a scanner can be named.
 *
 * THE VISIT LOG (2026-11-13) keeps a little more per beacon for 90 days,
 * still nothing that identifies a person: `visit-log-rules.ts`.
 */
import { formatInTimeZone } from "date-fns-tz";
import { isLinkPreviewFetcher } from "../link-preview-fetchers";
import type { PoolProfileSource } from "./vocab";

export { isLinkPreviewFetcher };

/** /play with no live campaign code: counted with the "web" sign-ups. */
export const POOL_VISIT_DIRECT = "_direct";
/** A friend's /play?ref= link: counted with the "referral" sign-ups. */
export const POOL_VISIT_REFERRAL = "_referral";

/** The steps, in the order a person goes through them. Pinned to the
 *  table's CHECK by `schema-sql.test.ts`. */
export const POOL_FUNNEL_STEPS = ["opened", "started", "sent", "confirmed"] as const;
export type PoolFunnelStep = (typeof POOL_FUNNEL_STEPS)[number];
/** The two only the browser sees, so the only two the page may send. */
export type PoolPageStep = Extract<PoolFunnelStep, "opened" | "started">;

export type PoolFunnelCounts = Record<PoolFunnelStep, number>;

/**
 * The step a beacon body names. None is "opened" (a page cached before
 * steps existed still counts its visit). "sent" and "confirmed" are the
 * server's to count, so a page naming them, or anything else, counts
 * nothing (null).
 */
export function readPoolPageStep(raw: unknown): PoolPageStep | null {
  if (raw === undefined) return "opened";
  return raw === "opened" || raw === "started" ? raw : null;
}

/**
 * The bucket a page step counts under, in the order `signup.ts`
 * resolveSource attributes the sign-up: a friend's LIVE share code (one a
 * confirmed player holds), else a LIVE campaign code, else direct. So a
 * switched-off or unknown code counts as direct, as its sign-up counts as
 * the web, and every step of one visit lands in the same bucket.
 */
export function poolVisitBucket(
  source: { campaignCode: string | null; referralCode: string | null },
  facts: { campaignLive: boolean; referralLive: boolean },
): string {
  if (source.referralCode && facts.referralLive) return POOL_VISIT_REFERRAL;
  if (source.campaignCode && facts.campaignLive) return source.campaignCode;
  return POOL_VISIT_DIRECT;
}

/**
 * The bucket a sign-up's own steps (sent, confirmed) count under, read off
 * the attribution `signup.ts` gave it. Null for a sign-up that did not come
 * through /play: a friend link for one game ("friend", `/play/f`) or a
 * member's own profile ("profile").
 */
export function poolProfileBucket(p: { source: PoolProfileSource | string | null; sourceCode: string | null }): string | null {
  if (p.source === "campaign") return p.sourceCode || null;
  if (p.source === "referral") return POOL_VISIT_REFERRAL;
  if (p.source === "web") return POOL_VISIT_DIRECT;
  return null;
}

/** The London day a step counts on, as "yyyy-MM-dd". */
export function poolVisitDay(now: Date): string {
  return formatInTimeZone(now, "Europe/London", "yyyy-MM-dd");
}

// ── Our own staff ──────────────────────────────────────────────────────

/**
 * OUR OWN VISITS ARE NOT VISITS (2026-11-12). Kemal's tests and QA checks
 * of /play were counted as people opening and starting it. So a browser
 * that has loaded an /admin page as an owner or admin carries this cookie
 * (set by `StaffMark` in the admin layout, a year long, so a staff phone is
 * known on /play even when signed out), and the beacon counts nothing for
 * it, nor for a request that carries an owner's or admin's session.
 * Nothing about the person is stored either way.
 */
export const POOL_STAFF_COOKIE = "mt-staff";
const POOL_STAFF_COOKIE_VALUE = "1";
const POOL_STAFF_COOKIE_MAX_AGE = 365 * 24 * 3600;

/** Is this beacon from our own staff? `adminSession`: the request's session
 *  passes the admin pages' own check (`getUserOrg` + `isOrgAdmin`). */
export function isPoolStaffVisit(a: { staffCookie: string | null | undefined; adminSession: boolean }): boolean {
  return a.staffCookie === POOL_STAFF_COOKIE_VALUE || a.adminSession;
}

/** The staff cookie as `document.cookie` takes it. First-party, the whole
 *  site, Lax so it is sent when /play is opened from a link elsewhere, and
 *  Secure on https (every deployment; plain http is only `next dev`). */
export function poolStaffCookie(o: { secure: boolean }): string {
  const parts = [`${POOL_STAFF_COOKIE}=${POOL_STAFF_COOKIE_VALUE}`, `Max-Age=${POOL_STAFF_COOKIE_MAX_AGE}`, "Path=/", "SameSite=Lax"];
  if (o.secure) parts.push("Secure");
  return parts.join("; ");
}

// ── The owner's view ───────────────────────────────────────────────────

export const POOL_FUNNEL_PERIODS = ["today", "7d", "30d"] as const;
export type PoolFunnelPeriod = (typeof POOL_FUNNEL_PERIODS)[number];
const PERIOD_DAYS: Record<PoolFunnelPeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/** The period in the owner's link; anything else is the last 7 days. */
export function readPoolFunnelPeriod(raw: unknown): PoolFunnelPeriod {
  return (POOL_FUNNEL_PERIODS as readonly unknown[]).includes(raw) ? (raw as PoolFunnelPeriod) : "7d";
}

/** The period's first London day, "yyyy-MM-dd", today counted in. Day
 *  arithmetic on the calendar date, so a clock change never shifts it. */
export function poolFunnelPeriodStart(period: PoolFunnelPeriod, now: Date): string {
  const today = new Date(`${poolVisitDay(now)}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - (PERIOD_DAYS[period] - 1));
  return today.toISOString().slice(0, 10);
}

const zero = (): PoolFunnelCounts => ({ opened: 0, started: 0, sent: 0, confirmed: 0 });

/** Every day's count added up, per bucket and step; a step not seen is 0,
 *  and a step this code does not know is skipped. */
export function poolFunnelTotals(rows: ReadonlyArray<{ code: string; step: string; count: number | null }>): Map<string, PoolFunnelCounts> {
  const out = new Map<string, PoolFunnelCounts>();
  for (const r of rows) {
    if (!(POOL_FUNNEL_STEPS as readonly string[]).includes(r.step)) continue;
    const c = out.get(r.code) ?? zero();
    c[r.step as PoolFunnelStep] += r.count ?? 0;
    out.set(r.code, c);
  }
  return out;
}

export interface PoolFunnelDrop {
  step: PoolFunnelStep;
  count: number;
  /** How many of the step before did not get to this one; null for the
   *  first step, or after a step nobody reached. Never negative: a step can
   *  outnumber the one before (opened yesterday, sent today). */
  lost: number | null;
  /** `lost` as a whole percentage of the step before. */
  lostPct: number | null;
}

/** The four steps left to right, each with the drop from the one before. */
export function poolFunnelDrops(c: PoolFunnelCounts): PoolFunnelDrop[] {
  return POOL_FUNNEL_STEPS.map((step, i) => {
    const before = i === 0 ? 0 : c[POOL_FUNNEL_STEPS[i - 1]];
    if (before === 0) return { step, count: c[step], lost: null, lostPct: null };
    const lost = Math.max(before - c[step], 0);
    return { step, count: c[step], lost, lostPct: Math.round((lost / before) * 100) };
  });
}
