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
 * logic of its own and no reason to import anything.
 */

/** A player as the scheduler sees one: the name may be missing. */
export interface NamedRow {
  name: string | null;
}

function numbered(rows: NamedRow[]): string[] {
  return rows.map((r, i) => `${i + 1}. ${r.name ?? "(unnamed)"}`);
}

/**
 * Row 68: the cold-open announcement, 09:00 to 12:59 London, more than
 * 24h out, squad empty. `dateLabel` is the London long date, e.g.
 * "Tuesday 8 September at 21:30".
 */
export function buildAnnounceMatchPost(args: {
  activityName: string;
  dateLabel: string;
  venue: string;
  maxPlayers: number;
}): string {
  return `📅 *${args.activityName}* — *${args.dateLabel}* at ${args.venue}.\n\nSay *IN* to join. First ${args.maxPlayers} confirmed play.`;
}

/**
 * Row 71: the numbered "Confirmed (N/M):" + "Bench (N):" block inside
 * the daily 17:00 announcement. Goal: every day at 5pm, every player
 * can scan the message and see their own name on the list, which
 * confirms they're playing without anyone needing to scroll up. Bench
 * gets its own numbered sub-list so the gap to the squad is obvious.
 */
export function buildSquadRosterBlock(args: {
  confirmed: NamedRow[];
  bench: NamedRow[];
  maxPlayers: number;
}): string {
  const { confirmed, bench, maxPlayers } = args;
  const lines: string[] = [];
  lines.push(`*Confirmed (${confirmed.length}/${maxPlayers}):*`);
  if (confirmed.length === 0) {
    lines.push("_nobody yet_");
  } else {
    lines.push(...numbered(confirmed));
  }
  if (bench.length > 0) {
    lines.push("");
    lines.push(`*Bench (${bench.length}):*`);
    lines.push(...numbered(bench));
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
export function buildMatchDayTeamsBlock(args: {
  activityName: string;
  venue: string;
  timeLabel: string;
  redLabel: string;
  yellowLabel: string;
  red: NamedRow[];
  yellow: NamedRow[];
}): string {
  return [
    `⚽ *Tonight at ${args.timeLabel}* — *${args.activityName}* at ${args.venue}`,
    ``,
    `*${args.redLabel}:*`,
    numbered(args.red).join("\n"),
    ``,
    `*${args.yellowLabel}:*`,
    numbered(args.yellow).join("\n"),
    ``,
    `See you tonight 🙌`,
  ].join("\n");
}

/**
 * Row 70: match day, full squad, but teams haven't been generated yet.
 * Shows the roster AND nudges somebody to trigger team generation so
 * the next 17:00-window tick can show the lineup.
 */
export function buildMatchDayLockedPost(args: {
  activityName: string;
  venue: string;
  timeLabel: string;
  rosterBlock: string;
}): string {
  const intro =
    `⚽ *Tonight at ${args.timeLabel}* — *${args.activityName}* at ${args.venue}\n\n` +
    `Squad is locked. Say *@MatchTime generate teams* in the chat to lock in tonight's lineup 👇`;
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
export function buildDailyInListFallback(args: {
  activityName: string;
  need: number;
  rosterBlock: string;
}): string {
  return `🗓 *${args.activityName}* — need *${args.need} more*.\n\n` + args.rosterBlock;
}

/**
 * Row 73: the unpaid-payments tail appended to the 17:00 post, or
 * posted alone. Poll-only format per Sait's suggestion (2026-04-25). No
 * naming, no shaming: point everyone at the original payment poll.
 * Anyone who's already paid clears themselves by ticking their team.
 * The caller has already decided `unpaid >= 1`.
 */
export function buildUnpaidTailText(unpaid: number): string {
  return unpaid === 1
    ? `💳 1 payment still pending for last week's match — if you've already paid, tick your team in the poll above to clear it 🙏`
    : `💳 *${unpaid}* payments still pending for last week's match — if you've already paid, just tick your team in the poll above to clear it 🙏`;
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
 */
export function buildBenchOfferContext(args: {
  activityName: string;
  team: { teamLabel: string; replacingName: string | null } | null;
}): { group: string; plain: string } {
  if (args.team) {
    const name = args.team.replacingName ?? "—";
    return {
      group: `on *${args.team.teamLabel}* (replacing ${name}) for *${args.activityName}* tonight`,
      plain: `on ${args.team.teamLabel} (replacing ${name}) for ${args.activityName} tonight`,
    };
  }
  return {
    group: `for *${args.activityName}* tonight`,
    plain: `for ${args.activityName} tonight`,
  };
}

/**
 * Row 78: the payment poll question posted the instant the match ends.
 * The options are the two team labels; any vote counts as paid
 * (`poll-vote/route.ts`), so the option text is never parsed.
 */
export function buildPaymentPollQuestion(activityName: string): string {
  return `💳 Payments for *${activityName}* — tick when you've paid`;
}
