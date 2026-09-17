/**
 * Man-of-the-Match result announcement — pure text builder.
 *
 * Extracted from the scheduler (`computeForMatch`) so the group-facing copy
 * can be unit-tested in isolation. No DB, no clock: give it the settled
 * vote tally and it returns the exact message the bot posts to the group.
 */

import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

export interface MomTallyEntry {
  name: string;
  votes: number;
}

export interface BuildMomAnnouncementArgs {
  /** e.g. sport.mvpLabel — "Man of the Match" / "Player of the Match". */
  mvpLabel: string;
  /** The activity/team name shown in the header. */
  activityName: string;
  /**
   * Per-player vote tally, already sorted descending by votes (ties broken
   * by name). Must be non-empty — callers skip the announcement on 0 votes.
   */
  tally: MomTallyEntry[];
  /** The group's language; English when absent. */
  lang?: Lang | string | null;
}

/**
 * Build the MoM result announcement text. The closing perk line is trophy
 * only — the drink offer was removed 2026-07-06.
 */
export function buildMomAnnouncement(args: BuildMomAnnouncementArgs): string {
  const { mvpLabel, activityName, tally } = args;
  const s = t(args.lang);

  const totalVotes = tally.reduce((sum, t) => sum + t.votes, 0);
  const topCount = tally[0].votes;
  const topNames = tally.filter((t) => t.votes === topCount).map((t) => t.name);
  const sharedHeader = topNames.length > 1;
  const namesText = sharedHeader
    ? topNames.length === 2
      ? `${topNames[0]} & ${topNames[1]}`
      : `${topNames.slice(0, -1).join(", ")} & ${topNames.slice(-1)[0]}`
    : topNames[0];
  const breakdown = tally.map((e) => s.mom_vote_row({ name: e.name, votes: e.votes })).join("\n");

  return (
    `${s.mom_header({ mvpLabel, activityName })}\n\n` +
    (sharedHeader
      ? `${s.mom_shared({ names: namesText, top: topCount, total: totalVotes })}\n\n`
      : `${s.mom_winner({ name: namesText, top: topCount, total: totalVotes })}\n\n`) +
    `${s.mom_votes_header}\n${breakdown}\n\n` +
    s.mom_trophy_line
  );
}
