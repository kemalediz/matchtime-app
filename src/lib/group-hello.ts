/**
 * THE GROUP HELLO, BUILT FROM THE CLUB'S REAL SETTINGS (2026-10-12).
 * Slice S2 of the go-live plan (section 2.5, "Hello").
 *
 * `sj_group_hello` is static: it tells every new group to say In or Out
 * each week, which is wrong for a rolling squad club, a monthly squad
 * club, or a club that has switched attendance off. This builder says
 * only what the club's own settings do.
 *
 * PURE: no database, no clock, no model. `group-hello-load.ts` reads the
 * row; the caller does `buildGroupHello(await loadHelloInput(orgId))`.
 *
 * THE PROMISE: on default settings, with the catch-up line left out, the
 * output equals `sj_group_hello` byte for byte, in every language
 * (`__tests__/group-hello.test.ts`). `sj_group_hello` itself is untouched.
 *
 * Shape: opener, blank line, one line per thing the club has on, blank
 * line, the catch-up line (weekly sign-up clubs only), blank line, closer.
 *
 * Days and times are written as the setup findings DM writes them
 * (`setup-learning/dm.ts`, `appliedLine`): `wd_weekday` and the stored
 * "HH:mm", so "Monday 21:00" reads the same in both places.
 */
import { t } from "./i18n/t";
import { normaliseLang } from "./i18n/lang";
import { normaliseBenchPickMode } from "./squad-capacity";
import { normaliseSquadMode, type SquadMode } from "./squad-month-rules";

/** A London weekday (0 = Sunday) and a wall-clock "HH:mm". */
export interface HelloDayTime {
  day: number;
  time: string;
}

/** Which ways a pay link can be paid; "off" when the club sends none. */
export type HelloPayLinks = "off" | "card" | "bank" | "card-and-bank";

export interface GroupHelloSettings {
  /** "monthly": regulars pay for the month. Rolling squad then reads as off. */
  squadMode: SquadMode;
  /** In and Out tracking (`featureAttendance`). Off: no squad lines at all. */
  attendance: boolean;
  /** The squad is read from a pasted list (`featureSquadFromList`). */
  squadFromList: boolean;
  rollingSquad: boolean;
  dropOutDeadline: HelloDayTime | null;
  listPublish: HelloDayTime | null;
  /** `benchPickMode` is "organiser". */
  organisersPick: boolean;
  bench: boolean;
  reminders: boolean;
  teamBalancing: boolean;
  momVoting: boolean;
  playerRating: boolean;
  statsQa: boolean;
  paymentTracking: boolean;
  payLinks: HelloPayLinks;
}

export interface GroupHelloInput {
  /** The organiser's first name, or null. */
  organiser: string | null;
  lang: string;
  settings: GroupHelloSettings;
  /** The "say In once more" line. Default true; it is still shown only to
   *  a club that signs up each week. False gives today's hello on defaults. */
  catchUp?: boolean;
}

/** What a club has before anybody changes a setting (the column defaults). */
export const DEFAULT_HELLO_SETTINGS: GroupHelloSettings = {
  squadMode: "weekly",
  attendance: true,
  squadFromList: false,
  rollingSquad: false,
  dropOutDeadline: null,
  listPublish: null,
  organisersPick: false,
  bench: true,
  reminders: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  paymentTracking: false,
  payLinks: "off",
};

/** Do this club's players say In for each game? Not when last week's
 *  squad is carried over, the month's regulars are, the squad comes from a
 *  pasted list, or attendance is off. */
export function signsUpEachWeek(s: GroupHelloSettings): boolean {
  return s.attendance && !s.squadFromList && s.squadMode !== "monthly" && !s.rollingSquad;
}

export function buildGroupHello(input: GroupHelloInput): string {
  const s = t(input.lang);
  const c = input.settings;
  const monthly = c.squadMode === "monthly";
  const rolling = c.rollingSquad && !monthly;
  const dayTime = (v: HelloDayTime) => ({ day: s.wd_weekday({ dow: v.day }), time: v.time });
  const lines: string[] = [];

  if (c.attendance) {
    if (monthly) {
      // The weekly routine (deadline, final list, bench) and the match fee
      // lines are left out for a monthly club: how they read beside the
      // month's list is not decided yet.
      lines.push(s.sj_hello_monthly, s.sj_hello_monthly_join({ organisersPick: c.organisersPick }));
    } else {
      if (rolling) {
        const d = c.dropOutDeadline ? dayTime(c.dropOutDeadline) : null;
        lines.push(
          s.sj_hello_rolling({ deadline: d ? `${d.day} ${d.time}` : null }),
          s.sj_hello_rolling_join({ mode: c.organisersPick ? "organiser" : c.bench ? "bench" : "no-bench" }),
        );
      } else {
        if (!c.squadFromList) lines.push(s.sj_hello_whos_in);
        if (c.dropOutDeadline) lines.push(s.sj_hello_deadline(dayTime(c.dropOutDeadline)));
      }
      if (c.listPublish) lines.push(s.sj_hello_list(dayTime(c.listPublish)));
      if (c.organisersPick) lines.push(s.sj_hello_bench_organiser);
      else if (c.bench) lines.push(s.sj_hello_bench);
    }
  }
  if (c.reminders) lines.push(s.sj_hello_remind);
  if (c.teamBalancing) lines.push(s.sj_hello_teams);
  if (c.momVoting || c.playerRating) lines.push(s.sj_hello_mom({ mom: c.momVoting, ratings: c.playerRating }));
  if (c.statsQa) lines.push(s.sj_hello_stats);
  if (!monthly) lines.push(s.sj_hello_fees({ tracking: c.paymentTracking, mode: c.payLinks }));

  const blocks = [s.sj_hello_opener({ organiser: input.organiser }), lines.join("\n")];
  if (input.catchUp !== false && signsUpEachWeek(c)) blocks.push(s.sj_hello_catch_up);
  blocks.push(s.sj_hello_closer({ attendance: c.attendance }));
  return blocks.join("\n\n");
}

// ── An Organisation row to the builder's input ───────────────────────

/** The `Organisation` columns the hello is built from. */
export const HELLO_ORG_SELECT = {
  language: true,
  squadMode: true,
  featureAttendance: true,
  featureBench: true,
  featureTeamBalancing: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  featureReminders: true,
  featureStatsQa: true,
  featureSquadFromList: true,
  rollingSquadEnabled: true,
  benchPickMode: true,
  dropOutDeadlineDay: true,
  dropOutDeadlineTime: true,
  listPublishDay: true,
  listPublishTime: true,
  paymentTrackingEnabled: true,
  paymentCollectionEnabled: true,
  stripeConnectAccountId: true,
  stripeChargesEnabled: true,
  payMethodCard: true,
  payMethodPayByBank: true,
} as const;

export interface HelloOrgRow {
  language: string;
  squadMode: string;
  featureAttendance: boolean;
  featureBench: boolean;
  featureTeamBalancing: boolean;
  featureMomVoting: boolean;
  featurePlayerRating: boolean;
  featureReminders: boolean;
  featureStatsQa: boolean;
  featureSquadFromList: boolean;
  rollingSquadEnabled: boolean;
  benchPickMode: string;
  dropOutDeadlineDay: number | null;
  dropOutDeadlineTime: string | null;
  listPublishDay: number | null;
  listPublishTime: string | null;
  paymentTrackingEnabled: boolean;
  paymentCollectionEnabled: boolean;
  stripeConnectAccountId: string | null;
  stripeChargesEnabled: boolean;
  payMethodCard: boolean;
  payMethodPayByBank: boolean;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One pair, or null when either half is missing or malformed: the same
 *  reading as `weeklyDeadlinesFor` (weekly-deadlines.ts). */
function pair(day: number | null, time: string | null): HelloDayTime | null {
  const okDay = typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6;
  return okDay && typeof time === "string" && TIME_RE.test(time) ? { day: day as number, time } : null;
}

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** `organiserName` is the organiser's full name as stored, or null. */
export function helloInputFromOrg(row: HelloOrgRow, organiserName: string | null | undefined): GroupHelloInput {
  const squadMode = normaliseSquadMode(row.squadMode);
  // Pay links go out only when the club can actually be charged: the
  // rule of `isPaymentCollectionLive` (payments-live-announce.ts), and at
  // least one of the two link methods switched on.
  const chargeable = row.paymentCollectionEnabled && !!row.stripeConnectAccountId && row.stripeChargesEnabled;
  const payLinks: HelloPayLinks = !chargeable
    ? "off"
    : row.payMethodCard && row.payMethodPayByBank
      ? "card-and-bank"
      : row.payMethodCard
        ? "card"
        : row.payMethodPayByBank
          ? "bank"
          : "off";
  return {
    organiser: firstName(organiserName),
    lang: normaliseLang(row.language),
    settings: {
      squadMode,
      attendance: row.featureAttendance,
      squadFromList: row.featureSquadFromList,
      rollingSquad: row.rollingSquadEnabled && squadMode !== "monthly",
      dropOutDeadline: pair(row.dropOutDeadlineDay, row.dropOutDeadlineTime),
      listPublish: pair(row.listPublishDay, row.listPublishTime),
      organisersPick: normaliseBenchPickMode(row.benchPickMode) === "organiser",
      bench: row.featureBench,
      reminders: row.featureReminders,
      teamBalancing: row.featureTeamBalancing,
      momVoting: row.featureMomVoting,
      playerRating: row.featurePlayerRating,
      statsQa: row.featureStatsQa,
      paymentTracking: row.paymentTrackingEnabled,
      payLinks,
    },
  };
}
