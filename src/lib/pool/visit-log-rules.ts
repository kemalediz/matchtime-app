/**
 * THE /play VISIT BREAKDOWN, the pure half (one row per beacon 2026-11-13;
 * daily totals only since 2026-11-16). No database, no clock of its own.
 * The I/O half is `visits.ts` (`recordPoolVisit`, `purgeOldPoolVisitDaily`).
 *
 * WHY. The funnel counters (`visit-rules.ts`) say how many opened and
 * started, per code and day, but not who the opens were: people, or link
 * scanners. So each open also adds one to a daily total broken down by a
 * few coarse categories: "PoolVisitDaily".
 *
 * ONLY WHAT CANNOT SINGLE ANYONE OUT (Kemal, 2026-11-16). From 13 to 16
 * November each beacon left its own row, with the hour, its time on screen,
 * a browser family and a device class. At our traffic such a row can be
 * matched to the one person who signed up that day: on 13 November the
 * only fb2 sign-up was the only fb2 start, and its row said mobile Safari,
 * not in an app. So a total is now only: the bucket the counters use (a
 * campaign code, "_direct" or "_referral"), the London day, the step (opens
 * only: starts are already in the daily counters, and a start is the step
 * just before a sign-up), what opened the page, whether it was an app's
 * in-app browser, whether it was a scanner, and a count. Never a browser
 * family or device, the hour, the time on screen, the IP address, the user
 * agent itself, the friend's code, a user id or a cookie. Deleted 90 days
 * after its day; the privacy policy says so.
 *
 * The server log (`poolBeaconLogLine`) carries the same categories and
 * nothing more: never the raw user agent.
 *
 * Only `visits.ts` touches the table, to add and to delete
 * (`__tests__/visit-log-unlinked.test.ts`).
 *
 * Reading a user agent into a label is parsing a browser's own string, not
 * understanding people. The list is short on purpose.
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

/** What a daily total, or a log line, may hold as its trigger: the page's
 *  own, "visible-time" for opens from before 16 November 2026 (backfilled
 *  from the per-visit rows), and "none" for an old open that did not say
 *  (and, in the log, for a start, which has no trigger). */
export const POOL_VISIT_TRIGGERS = [...POOL_OPEN_TRIGGERS, "visible-time", "none"] as const;
export type PoolVisitTrigger = (typeof POOL_VISIT_TRIGGERS)[number];

export interface PoolPageBeacon {
  step: PoolPageStep;
  trigger: PoolVisitTrigger;
}

/** Why a beacon counted nothing, for the server log. "not-json" is the
 *  route's own: a body it could not read. */
export type PoolBeaconRejection = "not-json" | "server-step" | "unknown-step" | "no-trigger" | "unknown-trigger" | "time-on-screen";
/** The step a rejected beacon named, only when it is one of ours. */
export type PoolBeaconStepNamed = "opened" | "started" | "sent" | "confirmed" | "other";

export type PoolPageBeaconRead = { ok: true; beacon: PoolPageBeacon } | { ok: false; step: PoolBeaconStepNamed; reason: PoolBeaconRejection };

/**
 * The beacon a body is, or why it is not one the page sends (it then
 * counts nothing):
 *   opened   (or no step, as since 2026-11-04) only with a trigger the page
 *            sends, a person's tap, touch, key, wheel or scroll, or a start
 *            before them; no trigger, "visible-time" or anything else is
 *            not a well-formed open;
 *   started  unchanged: counted whatever it carries, its trigger "none";
 *   "sent", "confirmed": the server's own steps; anything else: nobody's.
 */
export function readPoolPageBeacon(body: Record<string, unknown>): PoolPageBeaconRead {
  const step = readPoolPageStep(body.step);
  if (step === "started") return { ok: true, beacon: { step, trigger: "none" } };
  if (step !== "opened") {
    const server = body.step === "sent" || body.step === "confirmed";
    return { ok: false, step: server ? (body.step as "sent" | "confirmed") : "other", reason: server ? "server-step" : "unknown-step" };
  }
  const t = body.trigger;
  if (typeof t === "string" && (POOL_OPEN_TRIGGERS as readonly string[]).includes(t)) return { ok: true, beacon: { step, trigger: t as PoolOpenTrigger } };
  const reason: PoolBeaconRejection = t === undefined || t === null ? "no-trigger" : t === "visible-time" ? "time-on-screen" : "unknown-trigger";
  return { ok: false, step: "opened", reason };
}

// ── The coarse label ───────────────────────────────────────────────────

export const POOL_IN_APPS = ["facebook", "instagram", "nextdoor", "whatsapp", "other", "none"] as const;

export interface PoolVisitLabel {
  /** An app's own browser, or "none". */
  inApp: (typeof POOL_IN_APPS)[number];
  /** A link preview fetcher or scripted browser (`isLinkPreviewFetcher`, the
   *  counters' own check): added to the breakdown, never counted. */
  scanner: boolean;
}

/** An app's own browser. Nextdoor's in-app user agent is not confirmed: it
 *  is matched on the name. WhatsApp opens links in the phone's browser, so
 *  its name is normally its preview fetcher (a scanner). */
function inAppOf(ua: string): PoolVisitLabel["inApp"] {
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

/** The label a user agent is kept as: two fields. The user agent itself,
 *  its browser family and its device are never kept. */
export function poolVisitLabel(userAgent: string | null | undefined): PoolVisitLabel {
  const ua = (userAgent ?? "").trim();
  return { inApp: ua ? inAppOf(ua) : "none", scanner: isLinkPreviewFetcher(ua) };
}

// ── The daily total ────────────────────────────────────────────────────

/** The key of the daily total one open adds one to: every column of
 *  "PoolVisitDaily" but the count, and no other. */
export interface PoolVisitDailyKey extends PoolVisitLabel {
  code: string;
  /** The London day, "yyyy-MM-dd", as the funnel counters use. */
  day: string;
  step: "opened";
  trigger: PoolVisitTrigger;
}

/** Opens only: a start is counted by the daily counters and added to no
 *  breakdown. */
export function poolVisitDailyKey(a: { code: string; trigger: PoolVisitTrigger; now: Date; userAgent: string | null }): PoolVisitDailyKey {
  const label = poolVisitLabel(a.userAgent);
  return { code: a.code, day: poolVisitDay(a.now), step: "opened", trigger: a.trigger, inApp: label.inApp, scanner: label.scanner };
}

// ── The server log ─────────────────────────────────────────────────────

/**
 * One server log line per beacon (2026-11-06, to tell scanners from
 * people), holding only what the breakdown keeps (2026-11-16): the step,
 * the bucket, the trigger, the in-app browser, the scanner flag and what
 * became of it (counted; fetcher, not counted; failed). Never the raw user
 * agent, the code as sent, a friend's code or an address.
 *   [pool-funnel] beacon step=opened code=fb trigger=touch inApp=facebook scanner=no result=counted
 */
export function poolBeaconLogLine(a: {
  step: PoolPageStep;
  bucket: string | null;
  trigger: PoolVisitTrigger;
  label: PoolVisitLabel;
  result: "counted" | "fetcher" | "failed";
}): string {
  return `[pool-funnel] beacon step=${a.step} code=${a.bucket ?? "-"} trigger=${a.trigger} inApp=${a.label.inApp} scanner=${a.label.scanner ? "yes" : "no"} result=${a.result}`;
}

/** A beacon that counted nothing: its step, if it is one of ours, and why.
 *   [pool-funnel] beacon rejected step=opened reason=time-on-screen */
export function poolBeaconRejectedLogLine(a: { step: PoolBeaconStepNamed; reason: PoolBeaconRejection }): string {
  return `[pool-funnel] beacon rejected step=${a.step} reason=${a.reason}`;
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
