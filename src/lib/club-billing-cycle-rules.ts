/**
 * CLUB FEE BILLING, games played (slice P1): the billing month, the count
 * and the fee. PURE: no database, no clock, no Stripe.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, section 2A.
 *
 *   monthBounds(anchor, k)   the club's k-th month (2A.1): London midnights
 *                            on the anchor day, clamped, never chained
 *   monthIndexAt(anchor, t)  which month an instant falls in
 *   pauseSpansFrom(events)   the billing-paused spans (2A.3)
 *   countClubMonth(input)    scheduled and played (2A.2, 2A.3)
 *   monthFee(input)          price x played / scheduled, floored (2A.4)
 *
 * Counting is the whole product: a wrong count is a wrong charge. Every
 * approximation here goes the club's way: a week we cannot account for is
 * scheduled and not played, which lowers the fee, never raises it.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { SLOT_TIME_TOLERANCE_MS, isSameSlot } from "./match-slot";

/** Stripe's minimum card charge in GBP: below it nothing is charged (2A.4). */
export const STRIPE_MIN_CHARGE_PENCE = 30;

/** BillingEvent types MatchTime writes itself in `setBillingState`, in the
 *  transition's own transaction (ids "mt_paused_<orgId>_<ms>" and
 *  "mt_resumed_<orgId>_<ms>", never colliding with Stripe's "evt_..."). */
export const PAUSED_EVENT_TYPE = "mt.paused";
export const RESUMED_EVENT_TYPE = "mt.resumed";

// ── Month boundaries (2A.1) ─────────────────────────────────────────────

interface Ymd {
  y: number;
  m: number; // 1..12
  d: number;
}

function londonYmd(at: Date): Ymd {
  const [y, m, d] = formatLondon(at, "yyyy-MM-dd").split("-").map(Number);
  return { y, m, d };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymdString = ({ y, m, d }: Ymd) => `${y}-${pad(m)}-${pad(d)}`;

/** 00:00 London on the anchor day, `j` months after the anchor's month
 *  (clamped to the month's last day). Always from the anchor, never from
 *  the previous boundary, so a 31st comes back after a short month. */
function boundary(anchorDay: Ymd, j: number): Date {
  const zero = anchorDay.m - 1 + j;
  const y = anchorDay.y + Math.floor(zero / 12);
  const m = (((zero % 12) + 12) % 12) + 1;
  const d = Math.min(anchorDay.d, daysInMonth(y, m));
  return londonDateTimeToUtc(ymdString({ y, m, d }), "00:00");
}

/**
 * The club's `index`-th billing month (1 = the first month after the free
 * one). `anchor` is `ClubBilling.trialEndsAt`.
 *
 *   month 1   [anchor, 00:00 London on the anchor day of the next month)
 *   month k   [end of month k-1, 00:00 London on the anchor day k months on)
 *
 * The anchor day is the LONDON date of the anchor. A 29th, 30th or 31st is
 * clamped to the last day of a shorter month and comes back the month
 * after. `endsAt` is exclusive.
 */
export function monthBounds(anchor: Date, index: number): { startsAt: Date; endsAt: Date } {
  if (!Number.isInteger(index) || index < 1) throw new Error(`monthBounds: index must be 1 or more, got ${index}`);
  const day = londonYmd(anchor);
  return {
    startsAt: index === 1 ? anchor : boundary(day, index - 1),
    endsAt: boundary(day, index),
  };
}

/** The index of the month containing `at` (0 while still before the
 *  anchor, i.e. in the free month). */
export function monthIndexAt(anchor: Date, at: Date): number {
  if (at.getTime() < anchor.getTime()) return 0;
  const a = londonYmd(anchor);
  const t = londonYmd(at);
  let k = Math.max(1, (t.y - a.y) * 12 + (t.m - a.m));
  while (at.getTime() >= monthBounds(anchor, k).endsAt.getTime()) k += 1;
  while (k > 1 && at.getTime() < monthBounds(anchor, k).startsAt.getTime()) k -= 1;
  return k;
}

// ── Pause spans (2A.3) ──────────────────────────────────────────────────

/** A billing-paused span: [from, to), `to` null while still paused. */
export interface PauseSpan {
  from: Date;
  to: Date | null;
}

/**
 * The pause spans from the `mt.paused` / `mt.resumed` BillingEvent rows: a
 * span runs from an `mt.paused` to the next `mt.resumed`, or to now. A
 * repeated pause while paused, or a resume while not paused, is ignored.
 */
export function pauseSpansFrom(events: Array<{ type: string; at: Date }>): PauseSpan[] {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const spans: PauseSpan[] = [];
  let open: Date | null = null;
  for (const e of sorted) {
    if (e.type === PAUSED_EVENT_TYPE && open === null) open = e.at;
    else if (e.type === RESUMED_EVENT_TYPE && open !== null) {
      spans.push({ from: open, to: e.at });
      open = null;
    }
  }
  if (open !== null) spans.push({ from: open, to: null });
  return spans;
}

function inPause(at: Date, spans: PauseSpan[]): boolean {
  const t = at.getTime();
  return spans.some((s) => s.from.getTime() <= t && (s.to === null || t < s.to.getTime()));
}

// ── Counting (2A.2, 2A.3) ───────────────────────────────────────────────

/** One of the club's activities, as the count reads it. */
export interface CycleActivity {
  id: string;
  /** 0 = Sunday .. 6 = Saturday, London. */
  dayOfWeek: number;
  /** "HH:MM", London. */
  time: string;
  venue: string;
  isActive: boolean;
  createdAt: Date;
}

/** One match row of the club's activities. */
export interface CycleMatch {
  id: string;
  activityId: string;
  /** Kickoff (`Match.date`). */
  date: Date;
  /** `MatchStatus`: UPCOMING, TEAMS_GENERATED, TEAMS_PUBLISHED, COMPLETED, CANCELLED. */
  status: string;
  isHistorical: boolean;
  redScore: number | null;
  yellowScore: number | null;
  /** Attendances with status CONFIRMED (said IN). */
  confirmedCount: number;
}

export interface CountClubMonthInput {
  /** The month, [startsAt, endsAt). */
  startsAt: Date;
  endsAt: Date;
  /** Every activity of the club (the count picks the relevant ones). */
  activities: CycleActivity[];
  /** The club's matches; ones outside the month or historical are ignored. */
  matches: CycleMatch[];
  pauseSpans?: PauseSpan[];
  /** `Organisation.featureAttendance`: false for a MoM-only club with no IN list. */
  tracksAttendance: boolean;
  /** For a month still running (the billing page): a game not played whose
   *  kickoff is at or after `now` is "upcoming". Omit when closing. */
  now?: Date;
}

/** Why a scheduled game was or was not played (for the receipt page and
 *  any dispute). */
export type CycleGameOutcome =
  | "played"
  | "cancelled"
  /** Ended (auto COMPLETED) with nobody IN and no score. */
  | "nobody-in"
  /** MatchTime was paused for billing at kickoff. */
  | "paused"
  /** A week of the weekly game with no match row (deleted empty shell,
   *  dormant club, summer break with the activity left on). */
  | "no-match"
  /** A match row that never reached COMPLETED and whose kickoff passed. */
  | "not-completed"
  /** Still to come (only with `now`). */
  | "upcoming";

export interface CycleGame {
  /** The weekly calendar's kickoff, or the extra game's earliest match. */
  kickoff: Date;
  /** "weekly": a week of the weekly game; "extra": a one-off match off it. */
  source: "weekly" | "extra";
  matchIds: string[];
  played: boolean;
  outcome: CycleGameOutcome;
  /** What proved it was played. */
  evidence?: "in" | "score" | "no-attendance-tracking";
}

export interface ClubMonthCount {
  scheduled: number;
  played: number;
  /** Games still to come (0 without `now`). */
  upcoming: number;
  /** One per scheduled game, in kickoff order. */
  games: CycleGame[];
}

function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

const SLOT_TOLERANCE_MINUTES = SLOT_TIME_TOLERANCE_MS / 60_000;

interface WeeklySlot {
  day: number;
  /** The slot's earliest kickoff, minutes after London midnight. */
  start: number;
  /** The slot's earliest `createdAt`: weeks before it are not scheduled. */
  since: Date;
}

/**
 * The weekly game slots, grouped as `clubFeeTip` groups them
 * (club-billing-rules.ts): same weekday, kickoff times within 90 minutes
 * is one slot (a format-switch pair is one game). The slot plays at its
 * earliest kickoff, from its earliest activity's `createdAt` on.
 */
function weeklySlots(activities: CycleActivity[]): WeeklySlot[] {
  const sorted = [...activities].sort((a, b) => a.dayOfWeek - b.dayOfWeek || minutesOf(a.time) - minutesOf(b.time));
  const slots: WeeklySlot[] = [];
  for (const a of sorted) {
    const at = minutesOf(a.time);
    const slot = slots.find((s) => s.day === a.dayOfWeek && Math.abs(at - s.start) <= SLOT_TOLERANCE_MINUTES);
    if (!slot) slots.push({ day: a.dayOfWeek, start: at, since: a.createdAt });
    else if (a.createdAt.getTime() < slot.since.getTime()) slot.since = a.createdAt;
  }
  return slots;
}

/** London weekday (0 = Sunday) of an instant. */
function londonWeekday(at: Date): number {
  const { y, m, d } = londonYmd(at);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Every London calendar date from the London date of `from` to that of
 *  `to`, inclusive. */
function londonDates(from: Date, to: Date): Ymd[] {
  const a = londonYmd(from);
  const b = londonYmd(to);
  const out: Ymd[] = [];
  const cur = new Date(Date.UTC(a.y, a.m - 1, a.d));
  const end = Date.UTC(b.y, b.m - 1, b.d);
  while (cur.getTime() <= end) {
    out.push({ y: cur.getUTCFullYear(), m: cur.getUTCMonth() + 1, d: cur.getUTCDate() });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const within = (at: Date, startsAt: Date, endsAt: Date) =>
  at.getTime() >= startsAt.getTime() && at.getTime() < endsAt.getTime();

interface Bucket {
  kickoff: Date;
  weekday: number;
  source: "weekly" | "extra";
  matches: CycleMatch[];
}

/**
 * Scheduled and played for one billing month (2A.2, 2A.3).
 *
 * SCHEDULED is the union of
 *   1. the weekly calendar: for every activity that is active, or has a
 *      (non-historical) match in the month, grouped into weekly slots; each
 *      date in the month on the slot's weekday, at its earliest kickoff,
 *      from its earliest `createdAt` on, is one game; and
 *   2. the match rows in the month, whatever their status: a match within
 *      90 minutes of a calendar game on the same London weekday IS that
 *      game; any other match is an extra game, deduplicated with other
 *      extras by venue, weekday and kickoff within 90 minutes
 *      (`isSameSlot`, match-slot.ts), so a format-switch ghost and its real
 *      match are one game.
 *
 * PLAYED: a game with at least one match row that is COMPLETED, not
 * historical, kicked off inside the month and outside every pause span,
 * and shows the game happened: someone said IN, or both scores are set, or
 * the club does not track attendance.
 *
 * Never keyed on `activityId` (a format switch re-points it).
 */
export function countClubMonth(input: CountClubMonthInput): ClubMonthCount {
  const { startsAt, endsAt, tracksAttendance } = input;
  const spans = input.pauseSpans ?? [];
  const matches = input.matches
    .filter((m) => !m.isHistorical && within(m.date, startsAt, endsAt))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
  const withMatches = new Set(matches.map((m) => m.activityId));
  const activityById = new Map(input.activities.map((a) => [a.id, a]));
  const relevant = input.activities.filter((a) => a.isActive || withMatches.has(a.id));

  // 1. The weekly calendar.
  const buckets: Bucket[] = [];
  const dates = londonDates(startsAt, endsAt);
  for (const slot of weeklySlots(relevant)) {
    const time = `${pad(Math.floor(slot.start / 60))}:${pad(slot.start % 60)}`;
    for (const day of dates) {
      if (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() !== slot.day) continue;
      const kickoff = londonDateTimeToUtc(ymdString(day), time);
      if (!within(kickoff, startsAt, endsAt)) continue;
      if (kickoff.getTime() < slot.since.getTime()) continue;
      buckets.push({ kickoff, weekday: slot.day, source: "weekly", matches: [] });
    }
  }

  // 2. The match rows.
  const extraSlot = (m: CycleMatch) => ({
    orgId: "club",
    venue: activityById.get(m.activityId)?.venue ?? "",
    dayOfWeek: londonWeekday(m.date),
    instant: m.date,
  });
  for (const m of matches) {
    const weekday = londonWeekday(m.date);
    let best: Bucket | null = null;
    for (const b of buckets) {
      if (b.source !== "weekly" || b.weekday !== weekday) continue;
      const gap = Math.abs(b.kickoff.getTime() - m.date.getTime());
      if (gap > SLOT_TIME_TOLERANCE_MS) continue;
      if (!best || gap < Math.abs(best.kickoff.getTime() - m.date.getTime())) best = b;
    }
    if (!best) {
      best =
        buckets.find((b) => b.source === "extra" && b.matches.some((x) => isSameSlot(extraSlot(x), extraSlot(m)))) ?? null;
    }
    if (best) best.matches.push(m);
    else buckets.push({ kickoff: m.date, weekday, source: "extra", matches: [m] });
  }

  // 3. Played or not, and why.
  const games: CycleGame[] = buckets
    .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime())
    .map((b) => judge(b, spans, tracksAttendance, input.now));

  return {
    scheduled: games.length,
    played: games.filter((g) => g.played).length,
    upcoming: games.filter((g) => g.outcome === "upcoming").length,
    games,
  };
}

function evidenceOf(m: CycleMatch, tracksAttendance: boolean): CycleGame["evidence"] | null {
  if (m.confirmedCount > 0) return "in";
  if (m.redScore !== null && m.yellowScore !== null) return "score";
  if (!tracksAttendance) return "no-attendance-tracking";
  return null;
}

function judge(b: Bucket, spans: PauseSpan[], tracksAttendance: boolean, now: Date | undefined): CycleGame {
  const base = { kickoff: b.kickoff, source: b.source, matchIds: b.matches.map((m) => m.id) };
  const completed = b.matches.filter((m) => m.status === "COMPLETED");
  for (const m of completed) {
    if (inPause(m.date, spans)) continue;
    const evidence = evidenceOf(m, tracksAttendance);
    if (evidence) return { ...base, played: true, outcome: "played", evidence };
  }
  const notPlayed = (outcome: CycleGameOutcome): CycleGame => ({ ...base, played: false, outcome });
  if (now && b.kickoff.getTime() >= now.getTime() && b.matches.every((m) => m.status !== "COMPLETED" && m.status !== "CANCELLED")) {
    return notPlayed("upcoming");
  }
  if (b.matches.length === 0) return notPlayed(inPause(b.kickoff, spans) ? "paused" : "no-match");
  if (completed.some((m) => inPause(m.date, spans))) return notPlayed("paused");
  if (b.matches.some((m) => m.status === "CANCELLED")) return notPlayed("cancelled");
  if (completed.length > 0) return notPlayed("nobody-in");
  return notPlayed(inPause(b.kickoff, spans) ? "paused" : "not-completed");
}

// ── The fee (2A.4) ──────────────────────────────────────────────────────

export interface MonthFeeInput {
  /** The plan's monthly maximum when the month opened (pence). */
  priceAtStartPence: number;
  /** The plan's monthly maximum at the close; the lower of the two is used. */
  priceAtClosePence?: number | null;
  played: number;
  scheduled: number;
}

export interface MonthFee {
  /** The monthly maximum used. */
  pricePence: number;
  /** floor(price x played / scheduled); 0 when nothing is charged for lack of games. */
  amountPence: number;
  /** True only when there is something to invoice. */
  charge: boolean;
  outcome: "charge" | "no-games" | "below-minimum";
}

/**
 * fee (pence) = floor(monthPrice x played / scheduled), rounded DOWN so a
 * charge is never above the exact share (2 of 4 is 499p, not 500p).
 * Nothing is charged when played or scheduled is 0 ("no-games") or the
 * fee is under STRIPE_MIN_CHARGE_PENCE ("below-minimum"; only a low
 * Custom plan gets there). Nothing is carried over to the next month.
 */
export function monthFee(input: MonthFeeInput): MonthFee {
  const { played, scheduled, priceAtStartPence } = input;
  const close = input.priceAtClosePence;
  for (const [name, v] of [
    ["played", played],
    ["scheduled", scheduled],
    ["priceAtStartPence", priceAtStartPence],
    ["priceAtClosePence", close ?? 0],
  ] as const) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`monthFee: ${name} must be a whole number of 0 or more, got ${v}`);
  }
  if (played > scheduled) throw new Error(`monthFee: played (${played}) above scheduled (${scheduled})`);

  const pricePence = close === null || close === undefined ? priceAtStartPence : Math.min(priceAtStartPence, close);
  if (played === 0 || scheduled === 0) return { pricePence, amountPence: 0, charge: false, outcome: "no-games" };
  const amountPence = Math.floor((pricePence * played) / scheduled);
  if (amountPence < STRIPE_MIN_CHARGE_PENCE) return { pricePence, amountPence, charge: false, outcome: "below-minimum" };
  return { pricePence, amountPence, charge: true, outcome: "charge" };
}
