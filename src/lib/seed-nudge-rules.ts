/**
 * "RATE YOUR PLAYERS BEFORE THE FIRST TEAMS" (2026-10-15), pure, no Prisma.
 * The text is seed-nudge-copy.ts; the scheduler hook is seed-nudge.ts.
 *
 * WHY. The balancer's prior for a player is this club's seed
 * (`Membership.seedRating`), else this club's mean peer rating, else 5.0
 * (`computeClubRating`, team-generation.ts). A new club has no peer
 * ratings, so a player with no seed is a 5.0, and with most players at
 * 5.0 the first week's "balanced" teams are close to random. FNF went
 * live with 0 of 24 seeded and nobody told the organisers. Now MatchTime
 * tells them, once per club, through the admin channel.
 *
 * THE RULE. Due when ALL of these hold:
 *   1. the club is live (not setting up, `isClubSettingUp`), on weekly squad mode, with
 *      team balancing on;
 *   2. it has not been nudged (see ONCE below);
 *   3. its next match (the soonest one not yet kicked off, not cancelled
 *      or completed) still has status UPCOMING: no teams generated,
 *      proposed or published for it;
 *   4. the club has no peer rating at all (no `Rating` row on any of its
 *      matches), so nothing but the seed can tell players apart;
 *   5. fewer than half of the players likely to play have a seed: the
 *      match's CONFIRMED players, or, while nobody is confirmed yet, the
 *      club's active members (no `leftAt`);
 *   6. it is past the earlier of 09:00 London the morning after go-live
 *      (`liveAt`) and 09:00 London the day before the match, and inside
 *      the message hours (09:00 to 22:59 London).
 *
 * ONCE. One club-wide claim, `org-<orgId>:seed-nudge`, with each
 * recipient's delivery keyed under it (`…:seed-nudge:admin-group` or
 * `…:seed-nudge:<adminUserId>`, the admin channel's usual suffixes). Any
 * of them sent means the club has been nudged, so a club that changes its
 * admin channel is not told again. A manager who has told a club by hand
 * marks it with the bare claim (scripts/mark-seed-nudged.ts). An admin
 * BotJob carrying `MANUAL_SEED_NUDGE_MARKER` counts too, sent or queued:
 * that is how the one-off FNF message of 2026-10-16 is recognised with no
 * manual step.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { inMessageHours, MESSAGE_HOURS_FROM_TIME } from "./message-hours";
import type { Lang } from "./i18n/lang";
import { t } from "./i18n/t";

export const SEED_NUDGE_KIND = "seed-nudge";

/** A phrase in the manual FNF message (and in the English nudge). */
export const MANUAL_SEED_NUDGE_MARKER = "rough rating from 1 to 10";

/** The club-wide claim: set by hand, or implied by any recipient's key. */
export function seedNudgeBaseKey(orgId: string): string {
  return `org-${orgId}:seed-nudge`;
}

/** One recipient's key: an admin's user id, or "admin-group". */
export function seedNudgeKey(orgId: string, who: string): string {
  return `${seedNudgeBaseKey(orgId)}:${who}`;
}

export function seedNudgeAlreadySent(orgId: string, sentKeys: ReadonlySet<string>): boolean {
  const base = seedNudgeBaseKey(orgId);
  if (sentKeys.has(base)) return true;
  for (const k of sentKeys) if (k.startsWith(`${base}:`)) return true;
  return false;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** London calendar date of `d`, shifted by `days` (calendar days, DST-safe). */
function londonDateShifted(d: Date, days: number): string {
  const [y, m, dd] = formatLondon(d, "yyyy-MM-dd").split("-").map(Number);
  // Noon UTC on that calendar date: whole-day arithmetic never crosses a
  // date boundary on a 23 or 25 hour day.
  const shifted = new Date(Date.UTC(y, m - 1, dd, 12) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** 09:00 London the morning after go-live, or the day before the match, whichever is first. */
export function seedNudgeDueFrom(args: { liveAt: Date | null; matchDate: Date }): Date {
  const dayBefore = londonDateTimeToUtc(londonDateShifted(args.matchDate, -1), MESSAGE_HOURS_FROM_TIME);
  if (!args.liveAt) return dayBefore;
  const morningAfter = londonDateTimeToUtc(londonDateShifted(args.liveAt, 1), MESSAGE_HOURS_FROM_TIME);
  return morningAfter.getTime() < dayBefore.getTime() ? morningAfter : dayBefore;
}

export interface SeedNudgeInput {
  now: Date;
  /** Live: went live through GO, or never set up (`!isClubSettingUp`). */
  live: boolean;
  squadMode: string;
  teamBalancing: boolean;
  liveAt: Date | null;
  /** The claim, any recipient's key, or the manual message's BotJob. */
  alreadyNudged: boolean;
  /** The club's next match not yet kicked off (not cancelled or completed). */
  match: { date: Date; status: string } | null;
  /** The match's CONFIRMED players, and how many have a seed in this club. */
  confirmed: { total: number; seeded: number };
  /** The club's active members, and how many have a seed. */
  active: { total: number; seeded: number };
  clubHasPeerRatings: boolean;
}

export type SeedNudgeDecision =
  | { due: true; pool: "confirmed" | "members"; total: number; unseeded: number }
  | {
      due: false;
      reason:
        | "not-live"
        | "not-weekly"
        | "no-team-balancing"
        | "already"
        | "no-match"
        | "teams-made"
        | "too-early"
        | "outside-hours"
        | "has-peer-ratings"
        | "no-players"
        | "mostly-seeded";
    };

type NotDue = Extract<SeedNudgeDecision, { due: false }>;

/** The conditions that need no database read beyond the scheduler's own
 *  (club, features, sent keys, the loaded matches): checked first, so a
 *  club that is not due costs no query on each poll. Null = all pass. */
export function seedNudgePrecheck(
  i: Pick<SeedNudgeInput, "now" | "live" | "squadMode" | "teamBalancing" | "liveAt" | "alreadyNudged" | "match">,
): NotDue | null {
  if (!i.live) return { due: false, reason: "not-live" };
  if (i.squadMode !== "weekly") return { due: false, reason: "not-weekly" };
  if (!i.teamBalancing) return { due: false, reason: "no-team-balancing" };
  if (i.alreadyNudged) return { due: false, reason: "already" };
  if (!i.match || i.match.date.getTime() <= i.now.getTime()) return { due: false, reason: "no-match" };
  if (i.match.status !== "UPCOMING") return { due: false, reason: "teams-made" };
  if (i.now.getTime() < seedNudgeDueFrom({ liveAt: i.liveAt, matchDate: i.match.date }).getTime()) {
    return { due: false, reason: "too-early" };
  }
  if (!inMessageHours(i.now)) return { due: false, reason: "outside-hours" };
  return null;
}

export function decideSeedNudge(i: SeedNudgeInput): SeedNudgeDecision {
  const early = seedNudgePrecheck(i);
  if (early) return early;
  if (i.clubHasPeerRatings) return { due: false, reason: "has-peer-ratings" };
  const pool = i.confirmed.total > 0 ? "confirmed" : "members";
  const { total, seeded } = pool === "confirmed" ? i.confirmed : i.active;
  if (total === 0) return { due: false, reason: "no-players" };
  if (seeded * 2 >= total) return { due: false, reason: "mostly-seeded" };
  return { due: true, pool, total, unseeded: total - seeded };
}

/** "Hamzah or Raihan": the admins' first names, each once, in the club's language. */
export function joinAdminNames(names: ReadonlyArray<string | null | undefined>, lang: Lang | string | null | undefined): string {
  const firsts: string[] = [];
  for (const n of names) {
    const first = (n ?? "").trim().split(/\s+/)[0];
    if (first && !firsts.includes(first)) firsts.push(first);
  }
  return firsts.length === 0 ? "" : t(lang).sn_names({ names: firsts });
}

/** About 15 seconds a player, never under 2 minutes. */
export function ratingMinutes(players: number): number {
  return Math.max(2, Math.ceil(players / 4));
}
