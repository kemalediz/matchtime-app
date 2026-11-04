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
 * (`__tests__/group-hello.test.ts`). Change one and change the other.
 *
 * THE OPENING AND THE FEATURES (Kemal, 2026-11-02; every claim true,
 * 2026-11-03). Only the opening varies by club in shape: the organiser's
 * name, the game day ("help run the Monday games", from the club's one
 * weekly game day; several days or none: "this group's games"), the squad
 * lines for the club's type, and a weekly club's match fees line when its
 * pay links are on. After them every club hears about the SAME features in
 * the same order (friend, remind, then ratings, teams, Man of the Match,
 * profile, the player pool, partner clubs), and each line says what is
 * true for THIS club's settings: a feature switched off keeps its line,
 * marked "(optional, <organiser> can switch this on)" (`withOptionalTag`),
 * and Man of the Match and the teams say who chooses and who shares them.
 * The pool and partner facts are read from the database
 * (`group-hello-load.ts`, `HelloClubFacts`); absent, they read as off,
 * which is a brand new club. A monthly club with an organiser's name then
 * hears that the organiser posts the month's list.
 *
 * Shape: opener, blank line, squad lines + friend + remind, blank line,
 * the features block, blank line, the month's list (monthly) or the
 * catch-up line (weekly sign-up clubs only), blank line, closer.
 *
 * Days and times are written as the setup findings DM writes them
 * (`setup-learning/dm.ts`, `appliedLine`): `wd_weekday` and the stored
 * "HH:mm", so "Monday 21:00" reads the same in both places.
 */
import { t } from "./i18n/t";
import { normaliseLang } from "./i18n/lang";
import { normaliseBenchPickMode } from "./squad-capacity";
import { normaliseSquadMode, type SquadMode } from "./squad-month-rules";
import { organisersAnnounce } from "./list-announcer";
import { organisersPickMom } from "./mom-chooser";
import { isPaymentCollectionLive } from "./payments";

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
  /** The features (2026-11-03): each is always mentioned, and marked
   *  optional when off (`helloFeatureLines`). */
  reminders: boolean;
  teamBalancing: boolean;
  momVoting: boolean;
  playerRating: boolean;
  statsQa: boolean;
  paymentTracking: boolean;
  payLinks: HelloPayLinks;
  /** The organisers share the list and teams (`listAnnouncer`
   *  "organisers", list-announcer.ts). Absent: off, today's hello. */
  organisersAnnounce?: boolean;
  /** `momChosenBy` "organisers" (mom-chooser.ts): no vote, the organisers
   *  pick and MatchTime announces it. Absent: the players vote. */
  momByOrganisers?: boolean;
}

/** What the hello needs to know beyond the club's own columns, read from
 *  the database by `loadHelloClubFacts` (group-hello-load.ts). */
export interface HelloClubFacts {
  /** The player pool is open for the club: the platform switch AND the
   *  club's `featurePlayerPool` (pool/flags.ts `poolOpenForClub`). */
  pool: boolean;
  /** The club asks partner clubs for players: an ACTIVE partnership with
   *  it as the asker, and `partnerAskWhen` not "off" (`canAsk`). */
  partnersAsk: boolean;
  /** A partner club asks this one: an ACTIVE partnership with it as the
   *  partner, so its players hear the partner's asks. */
  partnersHelp: boolean;
}

/** A brand new club: no pool, no partner clubs. */
export const NO_HELLO_CLUB_FACTS: HelloClubFacts = { pool: false, partnersAsk: false, partnersHelp: false };

export interface GroupHelloInput {
  /** The organiser's first name, or null. */
  organiser: string | null;
  lang: string;
  settings: GroupHelloSettings;
  /** The "say In once more" line. Default true; it is still shown only to
   *  a club that signs up each week. False gives today's hello on defaults. */
  catchUp?: boolean;
  /** Rolling squad only (2026-10-13): does MatchTime already have a squad
   *  to carry onto the next game (`hasSquadToCarry`, rolling-squad-rules.ts,
   *  the seeding's own rule), one that fills at least HALF of that game's
   *  places? True: "if you played last time, you're in".
   *  False OR ABSENT: the first-game form, which asks for an In. Absent
   *  reads as false on purpose: telling a whole group they are in when
   *  nobody is costs a game; asking for an In that was not needed costs
   *  nothing. */
  hasSquadToCarry?: boolean;
  /** The club's one weekly game day (0 = Sunday), or null/absent when it
   *  has several or none: "help run this group's games". */
  gameDay?: number | null;
  /** The pool and partner clubs. Absent: `NO_HELLO_CLUB_FACTS`. */
  clubFacts?: HelloClubFacts;
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
  organisersAnnounce: false,
  momByOrganisers: false,
};

/** Do this club's players say In for each game? Not when last week's
 *  squad is carried over, the month's regulars are, the squad comes from a
 *  pasted list, or attendance is off. */
export function signsUpEachWeek(s: GroupHelloSettings): boolean {
  return s.attendance && !s.squadFromList && s.squadMode !== "monthly" && !s.rollingSquad;
}

/**
 * A feature line marked optional: the tag goes inside the bold heading,
 * before its colon ("🤝 *More games:* ..." becomes "🤝 *More games
 * (optional, Davide can switch this on):* ..."). Every features line is
 * written "<emoji> *<heading>:* <body>"; a line without that shape gets
 * the tag at its end, so the mark is never lost.
 */
export function withOptionalTag(line: string, tag: string): string {
  const at = line.indexOf(":*");
  return at < 0 ? `${line}${tag}` : `${line.slice(0, at)}${tag}${line.slice(at)}`;
}

/** The features paragraph, each line true for this club's settings. */
export function helloFeatureLines(input: GroupHelloInput): string[] {
  const s = t(input.lang);
  const c = input.settings;
  const facts = input.clubFacts ?? NO_HELLO_CLUB_FACTS;
  const tag = s.sj_hello_optional({ organiser: input.organiser });
  const opt = (line: string, on: boolean) => (on ? line : withOptionalTag(line, tag));
  // Rating DMs go to the confirmed players (bot-scheduler.ts 6b), which a
  // club has only when it tracks attendance or reads a pasted squad.
  const ratingsOn = c.playerRating && (c.attendance || c.squadFromList);
  const organisers = c.organisersAnnounce === true;
  const teams = organisers && c.teamBalancing ? s.sj_hello_teams_organisers : opt(s.sj_hello_teams, c.teamBalancing);
  // The players vote on their rating link, so a players' vote needs the
  // rating DMs; the organisers' pick does not.
  const mom = c.momByOrganisers === true ? opt(s.sj_hello_mom_organisers, c.momVoting) : opt(s.sj_hello_mom, c.momVoting && ratingsOn);
  const partners =
    facts.partnersAsk && facts.partnersHelp
      ? s.sj_hello_partners
      : facts.partnersAsk
        ? s.sj_hello_partners_lend
        : facts.partnersHelp
          ? s.sj_hello_partners_help({ organiser: input.organiser })
          : withOptionalTag(s.sj_hello_partners, tag);
  return [
    opt(s.sj_hello_ratings, ratingsOn),
    teams,
    mom,
    c.statsQa ? s.sj_hello_profile : s.sj_hello_profile_no_stats({ organiser: input.organiser }),
    opt(s.sj_hello_pool, facts.pool),
    partners,
  ];
}

export function buildGroupHello(input: GroupHelloInput): string {
  const s = t(input.lang);
  const c = input.settings;
  const monthly = c.squadMode === "monthly";
  const rolling = c.rollingSquad && !monthly;
  // ORGANISERS MODE (2026-10-15): the list and the teams are theirs to
  // share (bot-scheduler.ts `toOrganisers`), so "I post it here" is not
  // said and the opening says the organisers share them.
  const organisers = c.organisersAnnounce === true;
  const shareList = organisers && c.attendance && !monthly;
  const shareTeams = organisers && c.teamBalancing;
  const dayTime = (v: HelloDayTime) => ({ day: s.wd_weekday({ dow: v.day }), time: v.time });
  const lines: string[] = [];

  if (c.attendance) {
    if (monthly) {
      // The weekly routine (deadline, final list, bench) and the match fee
      // lines are left out for a monthly club.
      lines.push(s.sj_hello_monthly, s.sj_hello_monthly_join({ organisersPick: c.organisersPick }));
    } else {
      if (rolling) {
        const d = c.dropOutDeadline ? dayTime(c.dropOutDeadline) : null;
        const deadline = d ? `${d.day} ${d.time}` : null;
        if (input.hasSquadToCarry === true) {
          lines.push(
            s.sj_hello_rolling({ deadline }),
            s.sj_hello_rolling_join({ mode: c.organisersPick ? "organiser" : c.bench ? "bench" : "no-bench" }),
          );
        } else {
          // THE FIRST GAME: MatchTime has no last time for this club, so
          // nobody is in yet. One line asks for the In; the "not in the
          // squad yet?" line would be about everybody, so it is left out.
          // Organiser pick in organisers mode: the organisers set the first
          // squad (a pasted list, or the website); an In goes on the bench,
          // which the bench line below says. Nobody is asked for an In.
          lines.push(
            organisers && c.organisersPick
              ? s.sj_hello_rolling_first_organisers({ deadline })
              : s.sj_hello_rolling_first({ deadline, mode: c.organisersPick ? "organiser" : "first-come" }),
          );
        }
      } else {
        if (!c.squadFromList) lines.push(s.sj_hello_whos_in);
        if (c.dropOutDeadline) lines.push(s.sj_hello_deadline(dayTime(c.dropOutDeadline)));
      }
      if (c.listPublish && !organisers) lines.push(s.sj_hello_list(dayTime(c.listPublish)));
      if (c.organisersPick) lines.push(s.sj_hello_bench_organiser);
      else if (c.bench) lines.push(s.sj_hello_bench);
    }
  }
  if (shareList || shareTeams) lines.push(s.sj_hello_organisers_share({ list: shareList, teams: shareTeams }));
  if (!monthly && c.payLinks !== "off") lines.push(s.sj_hello_fees({ tracking: c.paymentTracking, mode: c.payLinks }));
  // Every club hears about the friend link and reminders; off, optional.
  const tag = s.sj_hello_optional({ organiser: input.organiser });
  // The friend link needs In and Out tracking (friend-link/rules.ts).
  lines.push(c.attendance ? s.sj_hello_friend : withOptionalTag(s.sj_hello_friend, tag));
  lines.push(c.reminders ? s.sj_hello_remind : withOptionalTag(s.sj_hello_remind, tag));

  const day = typeof input.gameDay === "number" ? s.wd_weekday({ dow: input.gameDay }) || null : null;
  const blocks = [s.sj_hello_opener({ organiser: input.organiser, day }), lines.join("\n"), helloFeatureLines(input).join("\n")];
  if (monthly && input.organiser) blocks.push(s.sj_hello_month_list({ organiser: input.organiser }));
  if (input.catchUp !== false && signsUpEachWeek(c)) blocks.push(s.sj_hello_catch_up);
  blocks.push(c.attendance ? s.sj_hello_closer : s.sj_hello_closer_tag_only);
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
  listAnnouncer: true,
  momChosenBy: true,
  featurePlayerPool: true,
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
  /** Absent (a row read before 2026-10-15): "matchtime". */
  listAnnouncer?: string | null;
  /** Absent (a row read before 2026-10-18): "players". */
  momChosenBy?: string | null;
  /** The club's own pool switch; read by `loadHelloClubFacts`. Absent: off. */
  featurePlayerPool?: boolean | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One pair, or null when either half is missing or malformed: the same
 *  reading as `weeklyDeadlinesFor` (weekly-deadlines.ts). */
function pair(day: number | null, time: string | null): HelloDayTime | null {
  const okDay = typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6;
  return okDay && typeof time === "string" && TIME_RE.test(time) ? { day: day as number, time } : null;
}

/** The first word of a stored name: how the hello (and the monthly
 *  announcement) name the organiser. */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** `organiserName` is the organiser's full name as stored, or null. */
export function helloInputFromOrg(row: HelloOrgRow, organiserName: string | null | undefined): GroupHelloInput {
  const squadMode = normaliseSquadMode(row.squadMode);
  // Pay links go out only when the club can actually be charged
  // (`isPaymentCollectionLive`, the one rule, payments.ts), and at least
  // one of the two link methods switched on.
  const chargeable = isPaymentCollectionLive(row);
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
      organisersAnnounce: organisersAnnounce(row),
      momByOrganisers: organisersPickMom(row),
    },
  };
}
