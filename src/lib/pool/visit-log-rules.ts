/**
 * THE /play VISIT BREAKDOWN, the pure half (one row per beacon 2026-11-13;
 * daily totals only since 2026-11-16). No database, no clock of its own.
 * The I/O half is `visits.ts` (`recordPoolVisit`, `purgeOldPoolVisitDaily`).
 *
 * WHY. The funnel counters (`visit-rules.ts`) say how many opened and
 * started, per code and day, but not why people left. So each beacon also
 * adds one to a daily total broken down by a few coarse categories:
 * "PoolVisitDaily".
 *
 * DAILY TOTALS ONLY (Kemal, 2026-11-16). From 13 to 16 November 2026 each
 * beacon left its own row, with the hour and its time on screen. At our
 * traffic an hour-stamped row can be matched to the one person who signed
 * up that hour, so nothing per visit is kept any more. A total is: the
 * bucket the counters use (a campaign code, "_direct" or "_referral"), the
 * London day, the step, what opened the page, and a coarse label read off
 * the user agent here (browser family, in-app browser, device class,
 * scanner), with a count. Never the hour, the time on screen, the IP
 * address, the user agent itself, the friend's code, a user id or a
 * cookie. Deleted 90 days after its day; the privacy policy says so.
 *
 * A total has a fixed set of keys per code and day, so a flood of beacons
 * only raises counts: the per-hour row cap of 2026-11-13 is gone with the
 * rows it capped.
 *
 * NEVER LINKED: the policy promises the breakdown is never tied to a
 * sign-up or a profile. Only `visits.ts` touches the table, to add and to
 * delete; `__tests__/visit-log-unlinked.test.ts` keeps it so.
 *
 * Reading a user agent into a label is parsing a browser's own string, not
 * understanding people. The lists are short on purpose: a rare browser is
 * "other", so the label alone does not single anyone out.
 */
import { isLinkPreviewFetcher } from "../link-preview-fetchers";
import { poolVisitDay, readPoolPageStep, type PoolPageStep } from "./visit-rules";

// ── What the beacon may say ────────────────────────────────────────────

/** What showed a person was there and so sent "opened" (`app/play/funnel-open.ts`):
 *  a trusted pointerdown, touchstart, keydown, wheel or scroll, or a start
 *  before any of them. Since 2026-11-16 time on screen opens nothing: on
 *  15 November 2026 all 4 counted opens were scanners that waited exactly
 *  5000 ms. */
export const POOL_OPEN_TRIGGERS = ["pointer", "touch", "key", "wheel", "scroll", "before-start"] as const;
export type PoolOpenTrigger = (typeof POOL_OPEN_TRIGGERS)[number];

/** What a daily total may hold as its trigger: the page's own, "visible-time"
 *  for opens from before 16 November 2026 (backfilled from the per-visit
 *  rows), and "none" for a start, which has no trigger. */
export const POOL_VISIT_TRIGGERS = [...POOL_OPEN_TRIGGERS, "visible-time", "none"] as const;
export type PoolVisitTrigger = (typeof POOL_VISIT_TRIGGERS)[number];

export interface PoolPageBeacon {
  step: PoolPageStep;
  trigger: PoolVisitTrigger;
}

/**
 * The beacon a body is, or null when it is not one the page sends, which
 * then counts nothing:
 *   opened   (or no step, as since 2026-11-04) only with a trigger the page
 *            sends, a person's tap, touch, key, wheel or scroll, or a start
 *            before them; no trigger, "visible-time" or anything else is
 *            not a well-formed open;
 *   started  unchanged: counted whatever it carries, kept with trigger "none";
 *   anything else ("sent", "confirmed" are the server's): null.
 */
export function readPoolPageBeacon(body: Record<string, unknown>): PoolPageBeacon | null {
  const step = readPoolPageStep(body.step);
  if (step === "started") return { step, trigger: "none" };
  if (step !== "opened") return null;
  const t = body.trigger;
  return typeof t === "string" && (POOL_OPEN_TRIGGERS as readonly string[]).includes(t) ? { step, trigger: t as PoolOpenTrigger } : null;
}

// ── The coarse browser label ───────────────────────────────────────────

export const POOL_BROWSERS = ["chrome", "safari", "firefox", "edge", "samsung", "other"] as const;
export const POOL_IN_APPS = ["facebook", "instagram", "nextdoor", "whatsapp", "other", "none"] as const;
/** "other": not a browser's user agent at all (a fetcher, a script, none). */
export const POOL_DEVICES = ["mobile", "tablet", "desktop", "other"] as const;

export interface PoolBrowserLabel {
  browser: (typeof POOL_BROWSERS)[number];
  inApp: (typeof POOL_IN_APPS)[number];
  device: (typeof POOL_DEVICES)[number];
  /** A link preview fetcher or scripted browser (`isLinkPreviewFetcher`, the
   *  counters' own check): its visit is logged, never counted. */
  scanner: boolean;
}

function browserOf(ua: string): PoolBrowserLabel["browser"] {
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|Opera/.test(ua)) return "other";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  // Safari, and every app's web view on an iPhone or iPad (all WebKit).
  if (/Safari\//.test(ua) || /\((iPhone|iPad|iPod|Macintosh)\b.*AppleWebKit\//.test(ua)) return "safari";
  return "other";
}

/** An app's own browser. Nextdoor's in-app user agent is not confirmed: it
 *  is matched on the name. WhatsApp opens links in the phone's browser, so
 *  its name is normally its preview fetcher (a scanner). */
function inAppOf(ua: string): PoolBrowserLabel["inApp"] {
  if (/\bFBAN\/|\bFBAV\/|\bFB_IAB\//.test(ua)) return "facebook";
  if (/\bInstagram\b/.test(ua)) return "instagram";
  if (/nextdoor/i.test(ua)) return "nextdoor";
  if (/WhatsApp/i.test(ua)) return "whatsapp";
  // Some other app's web view: Android marks it "wv"; on an iPhone or iPad
  // it is WebKit without Safari's own token.
  if (/;\s*wv\)/.test(ua)) return "other";
  if (/\((iPhone|iPad|iPod)\b/.test(ua) && !/Safari\//.test(ua)) return "other";
  return "none";
}

function deviceOf(ua: string): PoolBrowserLabel["device"] {
  if (!/^Mozilla\//.test(ua)) return "other";
  if (/\biPad\b|Tablet|Kindle|Silk\//.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Android/.test(ua)) return "mobile";
  return "desktop";
}

/** The label a user agent is kept as. The user agent itself is never kept. */
export function poolBrowserLabel(userAgent: string | null | undefined): PoolBrowserLabel {
  const ua = (userAgent ?? "").trim();
  const scanner = isLinkPreviewFetcher(ua);
  if (!ua) return { browser: "other", inApp: "none", device: "other", scanner };
  return { browser: browserOf(ua), inApp: inAppOf(ua), device: deviceOf(ua), scanner };
}

// ── The daily total ────────────────────────────────────────────────────

/** The key of the daily total one beacon adds one to: every column of
 *  "PoolVisitDaily" but the count, and no other. The user agent goes in and
 *  does not come out; there is no hour, no time on screen, no friend's code. */
export interface PoolVisitDailyKey extends PoolBrowserLabel {
  code: string;
  /** The London day, "yyyy-MM-dd", as the funnel counters use. */
  day: string;
  step: PoolPageStep;
  trigger: PoolVisitTrigger;
}

export function poolVisitDailyKey(a: { code: string; step: PoolPageStep; trigger: PoolVisitTrigger; now: Date; userAgent: string | null }): PoolVisitDailyKey {
  const label = poolBrowserLabel(a.userAgent);
  return {
    code: a.code,
    day: poolVisitDay(a.now),
    step: a.step,
    trigger: a.trigger,
    browser: label.browser,
    inApp: label.inApp,
    device: label.device,
    scanner: label.scanner,
  };
}

// ── Retention ──────────────────────────────────────────────────────────

/** Kemal, 2026-11-13, kept for the daily totals on 2026-11-16: the
 *  breakdown is kept 90 days, then deleted by the daily cron
 *  (`purgeOldPoolVisitDaily`). The privacy policy says so. The plain
 *  counters ("PoolCampaignVisit", no category) are not part of it. */
export const POOL_VISIT_RETENTION_DAYS = 90;

/** Totals for a London day before this one ("yyyy-MM-dd") are deleted.
 *  Calendar arithmetic, so a clock change never shifts it. */
export function poolVisitPurgeBeforeDay(now: Date): string {
  const d = new Date(`${poolVisitDay(now)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - POOL_VISIT_RETENTION_DAYS);
  return d.toISOString().slice(0, 10);
}
