/**
 * BADGE ANNOUNCEMENTS (2026-10-01): when a player earns a notable badge,
 * MatchTime says so in the club's WhatsApp group, as text.
 *
 * Pure: no DB, no clock. The scheduler half that loads the data and
 * emits the instruction is `badge-announcement-scheduler.ts`.
 *
 * ── The rules (Kemal, 2026-10-01) ────────────────────────────────────
 *
 *  1. WHICH badges: `ANNOUNCEABLE_BADGE_KEYS`. One constant, so adding
 *     or dropping one is a one-line change. Iron Man and Above the Curve
 *     are deliberately not announced.
 *
 *  2. WHEN: ONE group post per match, at 18:00 London on the second
 *     calendar day after it (a Tuesday match is announced on Thursday
 *     at 18:00), key `<matchId>:badges`. A Pi outage at 18:00 must not
 *     lose it, so it stays due on the following evenings, 18:00 to
 *     20:59, for `BADGES_POST_RETRY_DAYS` days (the
 *     `unpaidFollowUpDue` pattern). Nobody new: no post.
 *
 *  3. WHAT goes in it: every announceable badge a current member holds
 *     and has never been announced for, at that moment. Each badge is
 *     announced ONCE per player per club, ever (`BadgeAnnouncement`,
 *     unique on org + user + badge).
 *
 *  4. ONLY FINAL RESULTS COUNT. The stats page shows the MoM vote and
 *     the ratings as they stand, so two days after a match it can show a
 *     provisional MoM leader, or a Mr Reliable earned from a handful of
 *     ratings. A match's ratings and MoM votes count here only once it is
 *     final (`badgeMatchFinalised`): its MoM result has been posted, or
 *     it is past the point where one ever could be. Playing is never
 *     provisional, so a first game or a tenth is announced at once; a
 *     MoM or ratings badge from a match whose vote is still open rolls
 *     into a later post, once (rule 3 makes it neither lost nor
 *     repeated).
 *
 *  5. NO FLOOD on the first run. A club that has players who already
 *     hold badges must not hear about all of them the day this ships.
 *     Two layers, see `pickBadgeAwards`:
 *       a. the backfill (`scripts/backfill-badge-announcements.ts`)
 *          records every badge already earned as announced, before the
 *          feature's first post;
 *       b. the guard, in case the backfill was not run (or a club joins
 *          the ledger later): while a club has NO ledger rows at all
 *          (`bootstrap`), only badges earned at the match being announced
 *          are posted, and every other badge already held is written to
 *          the ledger in the same transaction as the post, silently.
 */
import { badgeMeta, milestoneBadgesEarned, momWinners, type MilestoneBadgeKey } from "./badge-rules";
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

/**
 * The badges MatchTime announces, in the order their lines appear in the
 * post. Not announced: Iron Man, Above the Curve.
 */
export const ANNOUNCEABLE_BADGE_KEYS = [
  "first-game",
  "first-mom",
  "mom-machine",
  "masterclass",
  "ten-games",
  "reliable",
] as const satisfies readonly MilestoneBadgeKey[];
export type AnnounceableBadgeKey = (typeof ANNOUNCEABLE_BADGE_KEYS)[number];

const ANNOUNCEABLE = new Set<string>(ANNOUNCEABLE_BADGE_KEYS);

// ── When ─────────────────────────────────────────────────────────────

/** Evenings after the first, from 18:00 on the second day, on which a
 *  missed post is retried. */
export const BADGES_POST_RETRY_DAYS = 3;
const FROM_HOUR = 18;
const TO_HOUR = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

export function badgesPostKey(matchId: string): string {
  return `${matchId}:badges`;
}

/** 18:00 London on the second calendar day after the match's London date. */
export function badgesPostAt(matchDate: Date): Date {
  const [y, m, d] = formatLondon(matchDate, "yyyy-MM-dd").split("-").map(Number);
  const key = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().slice(0, 10);
  return londonDateTimeToUtc(key, "18:00");
}

/** Due from 18:00 two days after, 18:00 to 20:59 London, for the retry days. */
export function badgesPostDue(now: Date, matchDate: Date): boolean {
  const at = badgesPostAt(matchDate);
  if (now.getTime() < at.getTime()) return false;
  if (now.getTime() >= at.getTime() + BADGES_POST_RETRY_DAYS * DAY_MS) return false;
  const hour = Number(formatLondon(now, "H"));
  return hour >= FROM_HOUR && hour < TO_HOUR;
}

// ── Final vs provisional ─────────────────────────────────────────────

/**
 * The scheduler's hard stop for a MoM announcement, in days after kickoff
 * (`MOM_ANNOUNCE_MAX_AGE_DAYS` in bot-scheduler.ts, which imports Prisma;
 * `__tests__/badge-announcements.test.ts` pins the two together). Past it
 * no MoM result will ever be posted for the match, and its rating window
 * has long closed, so its numbers are as final as they will get.
 */
export const BADGE_FINAL_AFTER_DAYS = 9;

/**
 * Does this match's MoM vote and ratings count toward badges yet? Yes
 * once its MoM result has been posted (`<matchId>:mom-announcement`, the
 * moment the scheduler declares the vote over), or once it is too old for
 * one ever to be posted (a club without MoM voting, a vote nobody cast,
 * a result overtaken by the next fixture).
 */
export function badgeMatchFinalised(
  match: { id: string; date: Date },
  sentKeys: ReadonlySet<string>,
  now: Date,
): boolean {
  if (sentKeys.has(`${match.id}:mom-announcement`)) return true;
  return now.getTime() - match.date.getTime() > BADGE_FINAL_AFTER_DAYS * DAY_MS;
}

// ── Replay ───────────────────────────────────────────────────────────

/** A completed match as loaded from the database, in date order. */
export interface RawBadgeMatch {
  id: string;
  /** Users with a CONFIRMED attendance. */
  confirmed: string[];
  /** Users on the team sheet. Either one counts as playing, as on the stats page. */
  teamUserIds: string[];
  ratings: { playerId: string; score: number }[];
  momVotes: { playerId: string }[];
}

/** A match as the replay sees it: provisional results already removed. */
export interface ReplayMatch {
  id: string;
  played: string[];
  ratings: { playerId: string; score: number }[];
  momWinners: string[];
}

/**
 * The FINALISED view of a club's history: who played is always kept;
 * ratings and the MoM result only for a match `isFinal` accepts.
 */
export function toReplayMatches<T extends RawBadgeMatch>(
  raw: T[],
  isFinal: (m: T) => boolean,
): ReplayMatch[] {
  return raw.map((m) => {
    const final = isFinal(m);
    return {
      id: m.id,
      played: [...new Set([...m.confirmed, ...m.teamUserIds])],
      ratings: final ? m.ratings : [],
      momWinners: final ? [...momWinners(m.momVotes)] : [],
    };
  });
}

export interface BadgeReplay {
  /** Badges held at the end of the replay: userId → badge → the match at
   *  which it (most recently) became held. */
  held: Map<string, Map<AnnounceableBadgeKey, string>>;
  /** Every badge ever held at any point: userId → badge → the match at
   *  which it was first held. (Mr Reliable can be lost and regained.) */
  everEarned: Map<string, Map<AnnounceableBadgeKey, string>>;
}

/**
 * Walk the club's matches in order, keeping each player's running totals
 * the same way `loadPlayerSeasonStats` does, and note the match at which
 * each announceable badge was earned.
 */
export function replayBadges(matches: ReplayMatch[]): BadgeReplay {
  const acc = new Map<string, { games: number; mom: number; perGame: number[]; all: number[] }>();
  const held: BadgeReplay["held"] = new Map();
  const everEarned: BadgeReplay["everEarned"] = new Map();

  for (const m of matches) {
    const played = new Set(m.played);
    const winners = new Set(m.momWinners);
    const scoresBy = new Map<string, number[]>();
    for (const r of m.ratings) {
      const xs = scoresBy.get(r.playerId) ?? [];
      xs.push(r.score);
      scoresBy.set(r.playerId, xs);
    }
    const involved = new Set<string>([...played, ...winners, ...scoresBy.keys()]);

    for (const u of involved) {
      const a = acc.get(u) ?? { games: 0, mom: 0, perGame: [], all: [] };
      if (played.has(u)) a.games++;
      if (winners.has(u)) a.mom++;
      const xs = scoresBy.get(u);
      if (xs && xs.length > 0) {
        a.perGame.push(xs.reduce((s, x) => s + x, 0) / xs.length);
        a.all.push(...xs);
      }
      acc.set(u, a);

      const flags = milestoneBadgesEarned({
        gamesPlayed: a.games,
        momCount: a.mom,
        perGameAverages: a.perGame,
        avgRating: a.all.length > 0 ? a.all.reduce((s, x) => s + x, 0) / a.all.length : null,
      });
      const h = held.get(u) ?? new Map<AnnounceableBadgeKey, string>();
      const e = everEarned.get(u) ?? new Map<AnnounceableBadgeKey, string>();
      for (const key of ANNOUNCEABLE_BADGE_KEYS) {
        if (flags[key]) {
          if (!h.has(key)) h.set(key, m.id);
          if (!e.has(key)) e.set(key, m.id);
        } else {
          h.delete(key);
        }
      }
      held.set(u, h);
      everEarned.set(u, e);
    }
  }
  return { held, everEarned };
}

// ── Who to announce ──────────────────────────────────────────────────

export interface BadgeAward {
  userId: string;
  badgeKey: AnnounceableBadgeKey;
  /** The match at which the badge was earned. */
  matchId: string;
}

export function announcedKey(userId: string, badgeKey: string): string {
  return `${userId}:${badgeKey}`;
}

/**
 * Pick what this match's post announces.
 *
 *   awards    badges held now by a current member, never announced
 *             before. In `bootstrap` (the club has no ledger rows yet),
 *             only those earned AT `matchId`.
 *   baseline  (bootstrap only) every other badge ever held and never
 *             announced: recorded with the post, silently, so the first
 *             run can never flood the group with old badges.
 */
export function pickBadgeAwards(args: {
  replay: BadgeReplay;
  matchId: string;
  /** `announcedKey(userId, badgeKey)` for every ledger row of the club. */
  announced: ReadonlySet<string>;
  bootstrap: boolean;
  /** Current members of the club. */
  eligibleUserIds: ReadonlySet<string>;
}): { awards: BadgeAward[]; baseline: BadgeAward[] } {
  const { replay, matchId, announced, bootstrap, eligibleUserIds } = args;
  const awards: BadgeAward[] = [];
  const awarded = new Set<string>();
  for (const [userId, keys] of replay.held) {
    if (!eligibleUserIds.has(userId)) continue;
    for (const key of ANNOUNCEABLE_BADGE_KEYS) {
      const earnedAt = keys.get(key);
      if (earnedAt === undefined || !ANNOUNCEABLE.has(key)) continue;
      if (announced.has(announcedKey(userId, key))) continue;
      if (bootstrap && earnedAt !== matchId) continue;
      awards.push({ userId, badgeKey: key, matchId: earnedAt });
      awarded.add(announcedKey(userId, key));
    }
  }

  const baseline: BadgeAward[] = [];
  if (bootstrap) {
    for (const [userId, keys] of replay.everEarned) {
      for (const [key, earnedAt] of keys) {
        const k = announcedKey(userId, key);
        if (announced.has(k) || awarded.has(k)) continue;
        baseline.push({ userId, badgeKey: key, matchId: earnedAt });
      }
    }
  }
  return { awards, baseline };
}

// ── The launch backfill ──────────────────────────────────────────────

/**
 * The rows the launch backfill writes: every badge ever earned (under
 * the finalised view) at a match that kicked off BEFORE `from`, not yet
 * in the ledger. Badges earned at or after `from` are left for the first
 * post. `from` null: everything already earned counts as announced.
 *
 * For Sutton FC `from` is 00:00 London on 22 Sept 2026, so the first post
 * carries the 22 Sept first MoMs and the 29 Sept attendance badges.
 */
export function selectBackfillRows(args: {
  replay: BadgeReplay;
  matchDateById: ReadonlyMap<string, Date>;
  from: Date | null;
  announced: ReadonlySet<string>;
}): BadgeAward[] {
  const { replay, matchDateById, from, announced } = args;
  const rows: BadgeAward[] = [];
  for (const [userId, keys] of replay.everEarned) {
    for (const [key, earnedAt] of keys) {
      if (announced.has(announcedKey(userId, key))) continue;
      if (from) {
        const at = matchDateById.get(earnedAt);
        // A match we cannot date is treated as old: recording it silently
        // is the safe side (a missed post, never a flood).
        if (at && at.getTime() >= from.getTime()) continue;
      }
      rows.push({ userId, badgeKey: key, matchId: earnedAt });
    }
  }
  return rows;
}

// ── The words ────────────────────────────────────────────────────────

export interface BadgePostEntry {
  name: string;
  keys: readonly AnnounceableBadgeKey[];
  /** For a first MoM: the match it was won at, so first-timers who
   *  shared the same match's award are told they shared it. */
  firstMomMatchId?: string;
}

/** Turn awards into the post's entries; `nameById` must name every awarded user. */
export function entriesFor(awards: BadgeAward[], nameById: ReadonlyMap<string, string>): BadgePostEntry[] {
  const byUser = new Map<string, { keys: AnnounceableBadgeKey[]; firstMomMatchId?: string }>();
  for (const a of awards) {
    const e = byUser.get(a.userId) ?? { keys: [] };
    e.keys.push(a.badgeKey);
    if (a.badgeKey === "first-mom") e.firstMomMatchId = a.matchId;
    byUser.set(a.userId, e);
  }
  return [...byUser].map(([userId, e]) => ({ name: nameById.get(userId) ?? userId, ...e }));
}

/**
 * The group post: a header, one line per badge (players who earned the
 * same badge share its line, names alphabetical), and a sign-off. Badge
 * names stay English in every language, as on the stats page. Null when
 * there is nothing to say.
 */
export function buildBadgeAnnouncementPost(
  entries: BadgePostEntry[],
  lang?: Lang | string | null,
): string | null {
  const s = t(lang);
  const lines: string[] = [];
  for (const key of ANNOUNCEABLE_BADGE_KEYS) {
    const holders = entries
      .filter((e) => e.keys.includes(key))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (holders.length === 0) continue;
    const names = holders.map((e) => e.name);
    const { emoji, label } = badgeMeta(key);
    const p = { emoji, label, names };
    switch (key) {
      case "first-game":
        lines.push(s.badges_line_first_game(p));
        break;
      case "first-mom": {
        // First-timers who co-won the SAME match shared it; the rest won
        // theirs alone (or alongside someone for whom it was not a first,
        // who is not named here at all).
        const byMatch = new Map<string, string[]>();
        const solo: string[] = [];
        for (const h of holders) {
          if (!h.firstMomMatchId) {
            solo.push(h.name);
            continue;
          }
          const g = byMatch.get(h.firstMomMatchId) ?? [];
          g.push(h.name);
          byMatch.set(h.firstMomMatchId, g);
        }
        const shared: string[][] = [];
        for (const g of byMatch.values()) {
          if (g.length > 1) shared.push(g);
          else solo.push(g[0]);
        }
        solo.sort((a, b) => a.localeCompare(b));
        lines.push(s.badges_line_first_mom({ emoji, label, shared, solo }));
        break;
      }
      case "mom-machine":
        lines.push(s.badges_line_mom_machine(p));
        break;
      case "masterclass":
        lines.push(s.badges_line_masterclass(p));
        break;
      case "ten-games":
        lines.push(s.badges_line_ten_games(p));
        break;
      case "reliable":
        lines.push(s.badges_line_reliable(p));
        break;
    }
  }
  if (lines.length === 0) return null;
  return `${s.badges_post_header}\n\n${lines.join("\n")}\n\n${s.badges_post_footer}`;
}
