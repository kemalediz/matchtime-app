/**
 * A GAME'S SIZES (2026-11-03). PURE: no database, no clock, no model.
 *
 * The Vets play 7-a-side with 14 places, but 6, 7 or 8 a side depending on
 * numbers. Their organiser sets the fewest and the most players the game is
 * played with (`Activity.minPlayers`, `Activity.maxPlayers`, both even), and
 * any one match may then be any size in between: 12, 14 or 16 places.
 *
 * WHERE A MATCH'S SIZE LIVES. On the match, `Match.maxPlayers`, the field
 * every attendance, bench, monthly list and chase path already reads as
 * "the places". Switching size changes only that field: the match stays on
 * its own Activity. That is deliberate. The older switch to ANOTHER Activity
 * (Sutton's 7-a-side to 5-a-side, `switchMatchFormat`) re-points
 * `activityId`, and three bugs came from code keyed on it (the ghost match,
 * the exact-time slot key, the rollover guard). A size switch inside one
 * game's range cannot create a second match or move the kickoff.
 *
 * The range never leaves out the game's own format (`normal`): a minimum
 * is at most the places, a maximum at least them. Null for either is the
 * format's places, which is every game before this (nothing changes).
 */

/** The fewest a minimum may be: one a side. */
export const PLAYERS_FLOOR = 2;
/** The most a maximum may be: 15 a side, above any small-sided game. */
export const PLAYERS_CEILING = 30;

/** What a game's size is read from. `playersPerTeam` is the format's. */
export interface GameSize {
  minPlayers: number | null;
  maxPlayers: number | null;
  playersPerTeam: number;
}

/** Totals across both sides. `normal` is the format's own places. */
export interface PlayerRange {
  min: number;
  max: number;
  normal: number;
}

export function playerRange(g: GameSize): PlayerRange {
  const normal = g.playersPerTeam * 2;
  return {
    normal,
    min: Math.min(g.minPlayers ?? normal, normal),
    max: Math.max(g.maxPlayers ?? normal, normal),
  };
}

/**
 * The players a side the range allows, smallest first: [6, 7, 8] for 12 to
 * 16. An odd minimum saved before minimums had to be even (13) allows the
 * full sides inside it only (7).
 */
export function sidesInRange(r: PlayerRange): number[] {
  const out: number[] = [];
  for (let s = Math.ceil(r.min / 2); s * 2 <= r.max; s++) if (s >= 1) out.push(s);
  return out;
}

/** May one match be played `perSide` a side? */
export function sideAllowed(perSide: number, r: PlayerRange): boolean {
  return Number.isInteger(perSide) && sidesInRange(r).includes(perSide);
}

export type RangeError = "not-a-number" | "odd" | "too-low" | "too-high" | "min-above-places" | "max-below-places";

export type RangeCheck =
  | { ok: true; min: number | null; max: number | null }
  | { ok: false; error: RangeError; field: "min" | "max" };

/**
 * A minimum and a maximum the web page or WhatsApp may save. Even numbers
 * only (two sides of the same size are what an organiser books), the
 * minimum from 2 up to the places, the maximum from the places up to the
 * ceiling. Null is the game's own format, and so are the game's own places
 * (stored as null, so "back to normal" and "never set" are one state).
 */
export function checkPlayerRange(p: { min: unknown; max: unknown; normal: number }): RangeCheck {
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  let min: number | null = null;
  let max: number | null = null;
  if (p.min !== null) {
    if (!whole(p.min)) return { ok: false, error: "not-a-number", field: "min" };
    if (p.min < PLAYERS_FLOOR) return { ok: false, error: "too-low", field: "min" };
    if (p.min % 2 !== 0) return { ok: false, error: "odd", field: "min" };
    if (p.min > p.normal) return { ok: false, error: "min-above-places", field: "min" };
    min = p.min === p.normal ? null : p.min;
  }
  if (p.max !== null) {
    if (!whole(p.max)) return { ok: false, error: "not-a-number", field: "max" };
    if (p.max % 2 !== 0) return { ok: false, error: "odd", field: "max" };
    if (p.max < p.normal) return { ok: false, error: "max-below-places", field: "max" };
    if (p.max > PLAYERS_CEILING) return { ok: false, error: "too-high", field: "max" };
    max = p.max === p.normal ? null : p.max;
  }
  return { ok: true, min, max };
}

/** The next size up from `places` inside the range, or null. */
export function nextSizeUp(places: number, r: PlayerRange): number | null {
  const up = places + 2;
  return up <= r.max ? up : null;
}

// ── The bench suggestion ──────────────────────────────────────────────

/** Every suggestion's key starts `<matchId>` then this. */
export const FORMAT_UP_KEY_PREFIX = ":format-up:";

/** One suggestion per match per size: `<matchId>:format-up:<places>`. */
export function formatUpKey(matchId: string, places: number): string {
  return `${matchId}${FORMAT_UP_KEY_PREFIX}${places}`;
}

export type BenchSuggestion = { kind: "suggest"; toPlaces: number } | { kind: "rearm" } | { kind: "none" };

/**
 * Should MatchTime suggest going up a size? When the squad is full and the
 * bench holds two (one more each side), and the next size up is inside the
 * maximum. Once per match per size (the caller's key, `formatUpKey`); the
 * caller forgets the keys when the bench drops below two ("rearm"), so it
 * is suggested again only after the bench has emptied and filled again,
 * never as people come and go around two.
 *
 * `bench` counts only players who may be moved in (not one who asked to
 * be on the bench). `live`: the match is still to come and not called off.
 */
export function decideBenchSuggestion(p: {
  live: boolean;
  teamsOut: boolean;
  places: number;
  confirmed: number;
  bench: number;
  range: PlayerRange;
}): BenchSuggestion {
  if (!p.live) return { kind: "none" };
  if (p.bench < 2) return { kind: "rearm" };
  if (p.teamsOut) return { kind: "none" };
  const up = nextSizeUp(p.places, p.range);
  if (up === null || p.confirmed < p.places) return { kind: "none" };
  return { kind: "suggest", toPlaces: up };
}

// ── Who moves on a switch ─────────────────────────────────────────────

export interface ResizeRow {
  userId: string;
  status: "CONFIRMED" | "BENCH" | "DROPPED";
  /** `Attendance.position`: the bench order. */
  position: number;
  /** When they last became CONFIRMED or joined the bench (ms). */
  joinedAt: number;
  /** On the bench because they ASKED to be: never moved in. */
  choseBench?: boolean;
  /** A regular of a running month: never benched before a non-regular. */
  regular?: boolean;
}

/**
 * Who moves when one match changes size.
 *
 *  UP: the bench moves into the new places in bench order (position, then
 *  who was there first), except a player who asked to be on the bench.
 *  DOWN: the squad above the new size goes to the bench, the last to join
 *  first. In a monthly club the month's regulars have paid for their
 *  place, so every non-regular (a pay as you go player, a fill-in) goes
 *  before any regular, as the monthly seed rule does.
 */
export function planResize(p: { rows: ResizeRow[]; newPlaces: number }): { promote: string[]; demote: string[] } {
  const confirmed = p.rows.filter((r) => r.status === "CONFIRMED");
  if (confirmed.length < p.newPlaces) {
    const room = p.newPlaces - confirmed.length;
    const promote = p.rows
      .filter((r) => r.status === "BENCH" && !r.choseBench)
      .sort((a, b) => a.position - b.position || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId))
      .slice(0, room)
      .map((r) => r.userId);
    return { promote, demote: [] };
  }
  if (confirmed.length > p.newPlaces) {
    const excess = confirmed.length - p.newPlaces;
    const demote = [...confirmed]
      .sort(
        (a, b) =>
          Number(a.regular === true) - Number(b.regular === true) ||
          b.joinedAt - a.joinedAt ||
          b.position - a.position ||
          b.userId.localeCompare(a.userId),
      )
      .slice(0, excess)
      .map((r) => r.userId);
    return { promote: [], demote };
  }
  return { promote: [], demote: [] };
}

// ── The teams ─────────────────────────────────────────────────────────

/**
 * Players a side of one match: its own places halved, when they are a size
 * its game's range allows (a match switched to 8-a-side has 16 places).
 * Anything else is the format's own players a side, as before: every
 * production match has `maxPlayers = playersPerTeam * 2` (87 of 87 on
 * 2026-11-03), and a test fixture's odd 5 must not become 2 a side.
 */
export function perTeamFor(m: { maxPlayers: number; playersPerTeam: number; range?: PlayerRange }): number {
  const r = m.range ?? playerRange({ minPlayers: null, maxPlayers: null, playersPerTeam: m.playersPerTeam });
  return sideAllowed(m.maxPlayers / 2, r) ? m.maxPlayers / 2 : m.playersPerTeam;
}

/**
 * The fewest confirmed players the teams are made with: the game's minimum
 * (so 13 makes 7 against 6), never more than the match's places. With no
 * minimum set that is two full sides, as before.
 */
export function teamsNeeded(p: { places: number; range: PlayerRange }): number {
  return Math.max(PLAYERS_FLOOR, Math.min(p.places, p.range.min));
}

/** The two sides for `count` players: never more than `perTeam` a side, the
 *  odd one on the first side. */
export function teamSides(count: number, perTeam: number): { red: number; yellow: number } {
  const n = Math.max(0, Math.min(count, perTeam * 2));
  return { red: Math.ceil(n / 2), yellow: Math.floor(n / 2) };
}

// ── The admin extractor's facts, as numbers ───────────────────────────

/**
 * `player_numbers` facts as the save's words. Numbers said a side
 * (`aSide`) are doubled here, so the model never does the arithmetic.
 */
export function playerRangeWordsOf(f: { minPlayers?: number; maxPlayers?: number; fullTeams?: true; aSide?: true; matchDay?: string }): {
  minPlayers: number | null;
  maxPlayers: number | null;
  fullTeams: boolean;
  matchDay: string | null;
} {
  const total = (n: number | undefined): number | null => (n === undefined ? null : f.aSide ? n * 2 : n);
  return { minPlayers: total(f.minPlayers), maxPlayers: total(f.maxPlayers), fullTeams: f.fullTeams === true, matchDay: f.matchDay?.trim() || null };
}

/** `switch_format` facts as players a side: a side as said, or half an
 *  even total. 0 when nothing usable was said. */
export function perSideOf(f: { size?: number; aSide?: true }): number {
  if (!f.size) return 0;
  if (f.aSide) return f.size;
  return f.size % 2 === 0 ? f.size / 2 : 0;
}
