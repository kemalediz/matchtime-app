/**
 * PURE copy for the scheduler's static group posts. No database, no
 * model, no clock.
 *
 * Extracted VERBATIM from `bot-scheduler.ts` on 2026-09-17 so that each
 * template is reachable from a unit test without Prisma, which is what
 * lets `src/lib/i18n/__tests__/copy-golden.test.ts` pin its English
 * bytes before any string moves into the language table (Phase 2 of
 * MDs/multi-language-design-2026-09-16.md). The scheduler still decides
 * WHEN each post fires and what state it describes; this file decides
 * only the words. Row numbers below are the design's inventory rows.
 *
 * Every builder takes already-formatted labels (dates, times, team
 * names) rather than Dates and rows, so it has no timezone or locale
 * logic of its own; the words come from the string table
 * (`src/lib/i18n/`) for the `lang` the caller passes, English when
 * absent, and the English bytes are unchanged (golden).
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

/** A player as the scheduler sees one: the name may be missing. */
export interface NamedRow {
  name: string | null;
}

type WithLang = { lang?: Lang | string | null };

function numbered(rows: NamedRow[], unnamed: string): string[] {
  return rows.map((r, i) => `${i + 1}. ${r.name ?? unnamed}`);
}

/**
 * Row 68: the cold-open announcement, 09:00 to 12:59 London, more than
 * 24h out, squad empty. `dateLabel` is the London long date, e.g.
 * "Tuesday 8 September at 21:30".
 */
export function buildAnnounceMatchPost(
  args: {
    activityName: string;
    dateLabel: string;
    venue: string;
    maxPlayers: number;
  } & WithLang,
): string {
  return t(args.lang).announce_match(args);
}

/**
 * Row 71: the numbered "Confirmed (N/M):" + "Bench (N):" block inside
 * the daily 17:00 announcement. Goal: every day at 5pm, every player
 * can scan the message and see their own name on the list, which
 * confirms they're playing without anyone needing to scroll up. Bench
 * gets its own numbered sub-list so the gap to the squad is obvious.
 */
export function buildSquadRosterBlock(
  args: {
    confirmed: NamedRow[];
    bench: NamedRow[];
    maxPlayers: number;
  } & WithLang,
): string {
  const { confirmed, bench, maxPlayers } = args;
  const s = t(args.lang);
  const lines: string[] = [];
  lines.push(s.roster_confirmed_header({ confirmed: confirmed.length, maxPlayers }));
  if (confirmed.length === 0) {
    lines.push(s.roster_nobody_yet);
  } else {
    lines.push(...numbered(confirmed, s.unnamed));
  }
  if (bench.length > 0) {
    lines.push("");
    lines.push(s.bench_header({ count: bench.length }));
    lines.push(...numbered(bench, s.unnamed));
  }
  return lines.join("\n");
}

/**
 * Row 69: the match-day 17:00 view when teams have been generated.
 * Replaces the flat squad roster with a Red vs Yellow lineup so each
 * player can scan and confirm what side they're on tonight. Bench is
 * intentionally NOT listed: by match day the bench player isn't
 * playing unless someone drops in the next few hours, and naming them
 * on the lineup post is just noise. No "objections / swap X Y" footer
 * here, that's already in the team-publish post that fired when teams
 * were generated; this is a daily reminder, not a fresh announcement.
 * `timeLabel` is the London kickoff wall-clock, "21:30".
 */
export function buildMatchDayTeamsBlock(
  args: {
    activityName: string;
    venue: string;
    timeLabel: string;
    redLabel: string;
    yellowLabel: string;
    red: NamedRow[];
    yellow: NamedRow[];
  } & WithLang,
): string {
  const s = t(args.lang);
  return [
    s.match_day_header({ timeLabel: args.timeLabel, activityName: args.activityName, venue: args.venue }),
    ``,
    `*${args.redLabel}:*`,
    numbered(args.red, s.unnamed).join("\n"),
    ``,
    `*${args.yellowLabel}:*`,
    numbered(args.yellow, s.unnamed).join("\n"),
    ``,
    s.match_day_teams_signoff,
  ].join("\n");
}

/**
 * Row 70: match day, full squad, but teams haven't been generated yet.
 * Shows the roster AND nudges somebody to trigger team generation so
 * the next 17:00-window tick can show the lineup.
 */
export function buildMatchDayLockedPost(
  args: {
    activityName: string;
    venue: string;
    timeLabel: string;
    rosterBlock: string;
  } & WithLang,
): string {
  const s = t(args.lang);
  const intro =
    `${s.match_day_header({ timeLabel: args.timeLabel, activityName: args.activityName, venue: args.venue })}\n\n` +
    s.match_day_locked_line;
  return `${intro}\n\n${args.rosterBlock}`;
}

/**
 * Row 72: the static fallback for the 17:00 short-squad chase when the
 * model compose path is unavailable. Mirrors the LLM template: count +
 * roster INCLUDING the bench (bench shows in every squad display, all
 * orgs, Kemal 2026-06-12). `rosterBlock` is `buildSquadRosterBlock`'s
 * output, which already renders the "*Bench (N):*" sub-list when
 * populated.
 */
export function buildDailyInListFallback(
  args: {
    activityName: string;
    need: number;
    rosterBlock: string;
  } & WithLang,
): string {
  return `${t(args.lang).daily_in_list_fallback_lead({ activityName: args.activityName, need: args.need })}\n\n` + args.rosterBlock;
}

/**
 * Row 73: the unpaid-payments tail appended to the 17:00 post, or
 * posted alone. Poll-only format per Sait's suggestion (2026-04-25). No
 * naming, no shaming: point everyone at the original payment poll.
 * Anyone who's already paid clears themselves by ticking their team.
 * The caller has already decided `unpaid >= 1`.
 */
export function buildUnpaidTailText(unpaid: number, lang?: Lang | string | null): string {
  return t(lang).unpaid_tail({ unpaid });
}

/**
 * Row 81: the context clause inside the bench-slot offer (row 52's
 * `{context}` and row 85's plain twin for the DM). With a team and a
 * replaced player it names both; otherwise just the fixture.
 *
 * `replacingName` is the dropped player's name as the row has it, or
 * null when the row has no name (rendered as "—", as it always was).
 * `teamLabel` and `replacingName` are set together or not at all: the
 * scheduler only knows the team when the replaced player had a team
 * assignment.
 *
 * `plain` is ALWAYS English in Phase 2: it is only ever read by the
 * bench-offer DM (row 85), which stays English until Phase 3 moves the
 * DMs, and a Turkish clause inside an English sentence is worse than
 * either. The Turkish `_plain` entries exist in the table so the pair
 * moves together then.
 */
export function buildBenchOfferContext(
  args: {
    activityName: string;
    team: { teamLabel: string; replacingName: string | null } | null;
  } & WithLang,
): { group: string; plain: string } {
  const s = t(args.lang);
  const dm = t("en");
  if (args.team) {
    const p = { teamLabel: args.team.teamLabel, replacingName: args.team.replacingName ?? "—", activityName: args.activityName };
    return { group: s.bench_offer_context_team(p), plain: dm.bench_offer_context_team_plain(p) };
  }
  const p = { activityName: args.activityName };
  return { group: s.bench_offer_context_fixture(p), plain: dm.bench_offer_context_fixture_plain(p) };
}

/**
 * Row 78: the payment poll question posted the instant the match ends.
 * The options are the two team labels; any vote counts as paid
 * (`poll-vote/route.ts`), so the option text is never parsed.
 */
export function buildPaymentPollQuestion(activityName: string, lang?: Lang | string | null): string {
  return t(lang).payment_poll_question({ activityName });
}

/** The feature flags the day-one intro is built from. */
export interface IntroFeatures {
  attendance: boolean;
  bench: boolean;
  teamBalancing: boolean;
  momVoting: boolean;
  playerRating: boolean;
  reminders: boolean;
  statsQa: boolean;
  paymentTracking: boolean;
}

/**
 * Row 67: the one-time introductory message posted on the org's first
 * active activity. Built from the org's ENABLED feature modules only: a
 * group running just MoM + ratings must not be promised attendance,
 * bench, teams or payments it'll never see. No hardcoded owner name
 * (was "Ask @Kemal", Sutton-specific; other groups have their own
 * admins). Kemal flagged 2026-05-19: any static Sutton value has to
 * become per-group dynamic. Moved verbatim from `bot-scheduler.ts`.
 *
 * `benchLine` is `buildBenchIntroLine()` (bench-offer-copy.ts), passed
 * in so this module stays free of that one's flag.
 */
export function buildBotIntro(f: IntroFeatures, benchLine: string, lang?: Lang | string | null): string {
  const s = t(lang);
  const lines: string[] = [s.intro_opener, ``, s.intro_what_i_do];
  if (f.attendance) {
    lines.push(``, s.intro_attendance, ``, s.intro_daily);
  }
  if (f.bench) {
    lines.push(``, benchLine);
  }
  if (f.teamBalancing) {
    lines.push(``, s.intro_teams);
  }
  if (f.momVoting || f.playerRating) {
    const bits: string[] = [];
    if (f.playerRating) bits.push(s.intro_rating_bit);
    if (f.momVoting) bits.push(s.intro_mom_bit);
    lines.push(``, s.intro_ratings_line({ bits }));
  }
  if (f.reminders) {
    lines.push(``, s.intro_reminders);
  }
  if (f.statsQa) {
    lines.push(``, s.intro_stats);
  }
  if (f.paymentTracking) {
    lines.push(``, s.intro_payments);
  }
  lines.push(``, s.intro_closer);
  return lines.join("\n");
}

/** Row 74: the 3-4h-before-kickoff chase, static fallback. */
export function buildChasePreKickoffFallback(
  args: {
    need: number;
    activityName: string;
    timeLabel: string;
  } & WithLang,
): string {
  return t(args.lang).chase_pre_kickoff_fallback(args);
}

/** Row 75: the 0.5-2h-before-kickoff last-chance plea, static fallback. */
export function buildPreKickoffShortFallback(
  args: {
    timeLabel: string;
    venue: string;
    confirmed: number;
    maxPlayers: number;
    need: number;
  } & WithLang,
): string {
  return t(args.lang).pre_kickoff_short_fallback(args);
}

/** Row 76: the football gear reminder, 1.5-2h before kickoff. */
export function buildGearReminder(args: { timeLabel: string; venue: string } & WithLang): string {
  return t(args.lang).gear_reminder(args);
}

/** Row 77: the score ask, 1h after the match ends. */
export function buildAskScorePost(args: { activityName: string } & WithLang): string {
  return t(args.lang).ask_score(args);
}
