/**
 * THE BADGES' THRESHOLDS AND CATALOGUE, in one Prisma-free place
 * (2026-10-01).
 *
 * `loadPlayerSeasonStats` (player-stats.ts) awards the badges with these
 * constants, and "@Match Time help badges" (badge-help.ts) prints them,
 * so the help text can never disagree with the stats page. The numbers
 * are the ones the badges have always used, moved here unchanged. Mr
 * Reliable's own thresholds live in `mr-reliable.ts`, for the same reason.
 */
import { MR_RELIABLE_MAX_SPREAD, MR_RELIABLE_MIN_AVG, MR_RELIABLE_MIN_GAMES, earnsMrReliable } from "./mr-reliable";

/** Regular: games played at the club. */
export const REGULAR_MIN_GAMES = 10;
/** Iron Man: matches the club has played since the player joined (and
 *  the player has played every one of them). */
export const IRON_MAN_MIN_MATCHES = 3;
/** MoM Machine: Man of the Match wins (a tie on the most votes is a win
 *  for everyone in it). */
export const MOM_MACHINE_MIN_WINS = 3;
/** Masterclass: the player's average rating in a single game. */
export const MASTERCLASS_MIN_GAME_AVG = 9;
/** Above the Curve: games the player was rated in. */
export const ABOVE_CURVE_MIN_RATED_GAMES = 3;

export type BadgeKey =
  | "first-game"
  | "ten-games"
  | "ironman"
  | "first-mom"
  | "mom-machine"
  | "masterclass"
  | "reliable"
  | "above-field";

export interface BadgeMeta {
  key: BadgeKey;
  emoji: string;
  label: string;
}

/** The badges in the stats page's order, with the page's emoji and name
 *  (a test checks player-stats.ts against this list). */
export const BADGES: readonly BadgeMeta[] = [
  { key: "first-game", emoji: "👟", label: "On the board" },
  { key: "ten-games", emoji: "🔟", label: "Regular" },
  { key: "ironman", emoji: "🦾", label: "Iron Man" },
  { key: "first-mom", emoji: "🏆", label: "Man of the Match" },
  { key: "mom-machine", emoji: "👑", label: "MoM Machine" },
  { key: "masterclass", emoji: "🌟", label: "Masterclass" },
  { key: "reliable", emoji: "🧱", label: "Mr Reliable" },
  { key: "above-field", emoji: "📈", label: "Above the Curve" },
];

/** Every number the badge help prints, from the constants above. */
export interface BadgeNumbers {
  regularMinGames: number;
  ironManMinMatches: number;
  momMachineMinWins: number;
  masterclassMinGameAvg: number;
  aboveCurveMinRatedGames: number;
  mrReliableMinGames: number;
  mrReliableMinAvg: number;
  mrReliableMaxSpread: number;
  /** Game-by-game averages that earn Mr Reliable, and ones that do not. */
  mrReliableSteady: readonly number[];
  mrReliableSwinging: readonly number[];
}

/** Kemal's examples (2026-10-01). A test checks them against
 *  `earnsMrReliable`, so a change to the rule that makes them wrong fails. */
export const MR_RELIABLE_EXAMPLE_STEADY = [7, 7.5, 6.8, 7.2] as const;
export const MR_RELIABLE_EXAMPLE_SWINGING = [9, 5, 8, 5.5] as const;

export const BADGE_NUMBERS: BadgeNumbers = {
  regularMinGames: REGULAR_MIN_GAMES,
  ironManMinMatches: IRON_MAN_MIN_MATCHES,
  momMachineMinWins: MOM_MACHINE_MIN_WINS,
  masterclassMinGameAvg: MASTERCLASS_MIN_GAME_AVG,
  aboveCurveMinRatedGames: ABOVE_CURVE_MIN_RATED_GAMES,
  mrReliableMinGames: MR_RELIABLE_MIN_GAMES,
  mrReliableMinAvg: MR_RELIABLE_MIN_AVG,
  mrReliableMaxSpread: MR_RELIABLE_MAX_SPREAD,
  mrReliableSteady: MR_RELIABLE_EXAMPLE_STEADY,
  mrReliableSwinging: MR_RELIABLE_EXAMPLE_SWINGING,
};

/** The names a player may type for each badge, English and Turkish. The
 *  badge's key and its label are always accepted too. */
const BADGE_ALIASES: Record<BadgeKey, string[]> = {
  "first-game": ["on the board", "board", "first game", "ilk maç", "ilk maçım"],
  "ten-games": ["regular", "ten games", "10 games", "düzenli", "müdavim", "10 maç", "on maç"],
  ironman: ["iron man", "ironman", "iron", "demir adam"],
  "first-mom": ["man of the match", "first mom", "mom", "motm", "maçın adamı", "maç adamı", "ilk maçın adamı"],
  "mom-machine": ["mom machine", "motm machine", "machine", "maçın adamı makinesi", "makine"],
  masterclass: ["masterclass", "master class", "master", "ustalık", "usta"],
  reliable: ["mr reliable", "mister reliable", "reliable", "güvenilir", "bay güvenilir"],
  "above-field": ["above the curve", "above the field", "above field", "curve", "ortalamanın üstünde", "ortalama üstü", "ortalamanın üzerinde"],
};

/** Lower-case under both casings' rules and drop the Turkish letters'
 *  marks, so "İRON MAN", "maçın adamı" and "macin adami" all compare
 *  equal; anything that is not a letter or digit becomes a space. */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/i̇/g, "i")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Which badge a typed name means, or null. The longest name found in the
 * text wins, so "mom machine" is MoM Machine and not Man of the Match.
 */
export function resolveBadgeName(query: string): BadgeKey | null {
  const q = fold(query ?? "");
  if (!q) return null;
  const padded = ` ${q} `;
  let best: { key: BadgeKey; len: number } | null = null;
  for (const b of BADGES) {
    for (const alias of [b.key, b.label, ...BADGE_ALIASES[b.key]]) {
      const a = fold(alias);
      if (a && padded.includes(` ${a} `) && (!best || a.length > best.len)) best = { key: b.key, len: a.length };
    }
  }
  return best?.key ?? null;
}

// ── The milestone rules, shared with the group's badge announcements ──
//
// (2026-10-01, badge-announcements.ts.) The six badges a player's own
// running totals decide, as one function over the constants above, so
// the announcement's per-match replay applies exactly the thresholds the
// stats page awards with. Iron Man and Above the Curve depend on the whole
// club's season and are not announced, so they are not here.

/** The badges a player's own running totals decide. */
export const MILESTONE_BADGE_KEYS = [
  "first-game",
  "ten-games",
  "first-mom",
  "mom-machine",
  "masterclass",
  "reliable",
] as const satisfies readonly BadgeKey[];
export type MilestoneBadgeKey = (typeof MILESTONE_BADGE_KEYS)[number];

export interface MilestoneInput {
  /** Matches played (CONFIRMED or on a team sheet). */
  gamesPlayed: number;
  /** Matches won (or co-won) as Man of the Match. */
  momCount: number;
  /** The player's average rating in each game they were rated in. */
  perGameAverages: number[];
  /** Mean of every individual score the player received. */
  avgRating: number | null;
}

export function milestoneBadgesEarned(i: MilestoneInput): Record<MilestoneBadgeKey, boolean> {
  return {
    "first-game": i.gamesPlayed >= 1,
    "ten-games": i.gamesPlayed >= REGULAR_MIN_GAMES,
    "first-mom": i.momCount >= 1,
    "mom-machine": i.momCount >= MOM_MACHINE_MIN_WINS,
    masterclass: i.perGameAverages.some((a) => a >= MASTERCLASS_MIN_GAME_AVG),
    reliable: earnsMrReliable({ perGameAverages: i.perGameAverages, avgRating: i.avgRating }),
  };
}

/** The emoji and name the stats page shows for a badge. */
export function badgeMeta(key: BadgeKey): BadgeMeta {
  return BADGES.find((b) => b.key === key)!;
}

/** Resolve the MoM winner(s) for a match from its vote rows: the
 *  playerId(s) with the most votes (>0). Ties co-win, matching the
 *  bot's shared-MoM announcement. Shared by the stats page and the
 *  badge announcements. */
export function momWinners(votes: { playerId: string }[]): Set<string> {
  if (votes.length === 0) return new Set();
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v.playerId, (tally.get(v.playerId) ?? 0) + 1);
  let max = 0;
  for (const c of tally.values()) if (c > max) max = c;
  const winners = new Set<string>();
  for (const [pid, c] of tally) if (c === max && max > 0) winners.add(pid);
  return winners;
}
