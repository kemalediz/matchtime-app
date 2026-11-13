/**
 * THE /play VISIT LOG, the pure half (2026-11-13). No database, no clock of
 * its own. The I/O half is `visits.ts` (`recordPoolVisit`,
 * `purgeOldPoolVisitEvents`).
 *
 * WHY. The funnel counters (`visit-rules.ts`) say how many opened and
 * started, per code and day, but not why people left: on 12 November 2026
 * the detail that could have said (how long the page was open, what the
 * visitor did, what browser) was only in the server log, gone in a day. So
 * each beacon also leaves one row, "PoolVisitEvent".
 *
 * WHAT IS KEPT, on Kemal's conditions (2026-11-13): only what the funnel
 * analysis needs, nothing that identifies a person, 90 days, said in the
 * privacy policy. A row is the minute, the bucket the counters use (a
 * campaign code, "_direct" or "_referral"), the step, what opened the page,
 * how long it had been on screen, WHETHER a friend's code came with it, and
 * a coarse label read off the user agent here: a browser family, an app's
 * in-app browser, a device class and the scanner flag. Never the IP
 * address, the user agent itself, the friend's code, a user id or a cookie.
 *
 * Reading a user agent into a label is parsing a browser's own string, not
 * understanding people. The lists are short on purpose: a rare browser is
 * "other", so the label can never single anyone out.
 */
import { isLinkPreviewFetcher } from "../link-preview-fetchers";
import type { PoolPageStep } from "./visit-rules";

// ── What the beacon may add ────────────────────────────────────────────

/** What showed a person was there and so sent "opened" (`app/play/funnel-open.ts`):
 *  a trusted pointerdown, touchstart, keydown, wheel or scroll, 5 seconds on
 *  screen, or a start before any of them. */
export const POOL_OPEN_TRIGGERS = ["pointer", "touch", "key", "wheel", "scroll", "visible-time", "before-start"] as const;
export type PoolOpenTrigger = (typeof POOL_OPEN_TRIGGERS)[number];

/** A day on screen is as long as a visit is reported; anything above is a day. */
export const POOL_VISIT_MAX_VISIBLE_MS = 24 * 3600 * 1000;
/** Visible time is kept to a tenth of a second: enough to read, too coarse to tell visits apart by. */
const VISIBLE_STEP_MS = 100;

export interface PoolVisitDetail {
  openedBy: PoolOpenTrigger | null;
  visibleMs: number | null;
}

/**
 * The detail a beacon body carries, checked: a trigger the gate knows, only
 * on "opened" (a start has none), and the visible time as a whole number of
 * ms from 0 to a day, rounded to a tenth of a second. Anything else is none,
 * so a page cached before the log existed still counts, its detail empty.
 */
export function readPoolVisitDetail(body: Record<string, unknown>, step: PoolPageStep): PoolVisitDetail {
  const t = body.trigger;
  const openedBy = step === "opened" && typeof t === "string" && (POOL_OPEN_TRIGGERS as readonly string[]).includes(t) ? (t as PoolOpenTrigger) : null;
  const v = body.visibleMs;
  const visibleMs =
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(Math.max(Math.round(v / VISIBLE_STEP_MS) * VISIBLE_STEP_MS, 0), POOL_VISIT_MAX_VISIBLE_MS)
      : null;
  return { openedBy, visibleMs };
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

// ── The row ────────────────────────────────────────────────────────────

/** The visit's time, to the minute: when, not exactly when. */
export function poolVisitMinute(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

export interface PoolVisitEventRow extends PoolVisitDetail, PoolBrowserLabel {
  at: Date;
  code: string;
  step: PoolPageStep;
  hasRef: boolean;
}

/** One beacon as its row: every field the table has, and no other. The
 *  friend's code and the user agent go in and do not come out. */
export function poolVisitEventRow(a: {
  code: string;
  step: PoolPageStep;
  now: Date;
  detail: PoolVisitDetail;
  referralCode: string | null;
  userAgent: string | null;
}): PoolVisitEventRow {
  const label = poolBrowserLabel(a.userAgent);
  return {
    at: poolVisitMinute(a.now),
    code: a.code,
    step: a.step,
    openedBy: a.detail.openedBy,
    visibleMs: a.detail.visibleMs,
    hasRef: !!a.referralCode,
    browser: label.browser,
    inApp: label.inApp,
    device: label.device,
    scanner: label.scanner,
  };
}

// ── Retention ──────────────────────────────────────────────────────────

/** Kemal, 2026-11-13: a visit's detail is kept 90 days, then deleted by the
 *  daily cron (`purgeOldPoolVisitEvents`). The privacy policy says so. */
export const POOL_VISIT_RETENTION_DAYS = 90;

/** Rows from before this instant are deleted. */
export function poolVisitPurgeBefore(now: Date): Date {
  return new Date(now.getTime() - POOL_VISIT_RETENTION_DAYS * 24 * 3600 * 1000);
}
