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
//
// THREE KINDS OF KEY, all under `<matchId>:format-up`, all kept for good
// (review of #517: a re-arm must not forget what an organiser settled, nor
// the suggestion's own row, which a reply to it is resolved by):
//   `<matchId>:format-up:<places>`            SETTLED: a switch passed
//                                              through this size; never
//                                              suggested again for the match
//   `<matchId>:format-up:<places>:e<n>`       one suggestion, in episode n
//   `<matchId>:format-up-rearm:<n>`           the bench dropped below two
//                                              after a suggestion of episode
//                                              n - 1: episode n begins

/** Every format-up key of a match starts with this. */
export const FORMAT_UP_KEY_PREFIX = ":format-up";

/** A size a switch passed through: never suggested again for the match. */
export function formatUpSettledKey(matchId: string, places: number): string {
  return `${matchId}:format-up:${places}`;
}

/** One suggestion of a size, in one episode. */
export function formatUpKey(matchId: string, places: number, episode: number): string {
  return `${matchId}:format-up:${places}:e${episode}`;
}

/** The marker that begins episode `episode`. */
export function formatUpRearmKey(matchId: string, episode: number): string {
  return `${matchId}:format-up-rearm:${episode}`;
}

/** A suggestion's key, read back: its match, size and episode. */
export function parseFormatUpKey(key: string): { matchId: string; places: number; episode: number } | null {
  const m = /^(.+):format-up:(\d+):e(\d+)$/.exec(key);
  return m ? { matchId: m[1], places: Number(m[2]), episode: Number(m[3]) } : null;
}

/** The match's current episode: the newest re-arm marker, 0 with none. */
export function formatUpEpisode(keys: Iterable<string>, matchId: string): number {
  let n = 0;
  const prefix = `${matchId}:format-up-rearm:`;
  for (const k of keys) if (k.startsWith(prefix)) n = Math.max(n, Number(k.slice(prefix.length)) || 0);
  return n;
}

/**
 * The scheduler's whole decision for one poll, from the keys it holds:
 *   "suggest"  post `formatUpKey(matchId, toPlaces, episode)`;
 *   "rearm"    write `formatUpRearmKey(matchId, episode + 1)`: the bench is
 *              below two and this episode had a suggestion;
 *   "none".
 */
export function planFormatUp(p: {
  matchId: string;
  keys: ReadonlySet<string>;
  decision: BenchSuggestion;
}): { kind: "suggest"; key: string; toPlaces: number } | { kind: "rearm"; key: string } | { kind: "none" } {
  const episode = formatUpEpisode(p.keys, p.matchId);
  if (p.decision.kind === "rearm") {
    const suffix = `:e${episode}`;
    const suggested = [...p.keys].some((k) => k.startsWith(`${p.matchId}:format-up:`) && k.endsWith(suffix));
    return suggested ? { kind: "rearm", key: formatUpRearmKey(p.matchId, episode + 1) } : { kind: "none" };
  }
  if (p.decision.kind !== "suggest") return { kind: "none" };
  const to = p.decision.toPlaces;
  if (p.keys.has(formatUpSettledKey(p.matchId, to))) return { kind: "none" };
  const key = formatUpKey(p.matchId, to, episode);
  return p.keys.has(key) ? { kind: "none" } : { kind: "suggest", key, toPlaces: to };
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

/**
 * Does this game go up a size at all, with MatchTime telling the group?
 * A maximum above the game's own places, and a club whose list is
 * MatchTime's to tell (on "organisers" the list is theirs). The
 * scheduler's suggestion and the list's "one more" line both read it.
 */
export function formatUpOffered(p: { range: PlayerRange; organisers: boolean }): boolean {
  return p.range.max > p.range.normal && !p.organisers;
}

/**
 * The month's list line (Kemal, 2026-11-09): "One more on the bench and the
 * organisers can make it 8-a-side." The next size's places when exactly ONE
 * more movable player on the bench would make MatchTime suggest it, else
 * null. Not a rule of its own: it is `decideBenchSuggestion` asked with one
 * more on the bench while it does not suggest now, plus the same gates the
 * scheduler puts around it (`formatUpOffered`, and a size an organiser
 * already switched through, `formatUpSettledKey`, is never offered). So
 * with two on the bench there is no line: the suggestion post is out.
 */
export function oneMoreForNextSize(p: {
  live: boolean;
  teamsOut: boolean;
  places: number;
  confirmed: number;
  /** Movable only, as the suggestion counts it (not who chose the bench). */
  bench: number;
  range: PlayerRange;
  organisers: boolean;
  matchId: string;
  keys: ReadonlySet<string>;
}): number | null {
  if (!formatUpOffered(p)) return null;
  if (decideBenchSuggestion(p).kind === "suggest") return null;
  const next = decideBenchSuggestion({ ...p, bench: p.bench + 1 });
  if (next.kind !== "suggest") return null;
  return p.keys.has(formatUpSettledKey(p.matchId, next.toPlaces)) ? null : next.toPlaces;
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
 * Players a side of one match: its OWN places halved, whatever its game's
 * range says now (review of #517: a match switched to 8-a-side whose
 * range was then narrowed is still a 16-place match, and its 16 confirmed
 * all play). Every production match has even places (`playersPerTeam * 2`,
 * 87 of 87 on 2026-11-03); anything else (a test fixture's odd 5) is the
 * format's own players a side, as before.
 */
export function perTeamFor(m: { maxPlayers: number; playersPerTeam: number }): number {
  return Number.isInteger(m.maxPlayers) && m.maxPlayers >= 2 && m.maxPlayers % 2 === 0 ? m.maxPlayers / 2 : m.playersPerTeam;
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
