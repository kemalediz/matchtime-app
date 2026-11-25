/**
 * PURE HALF of the Vets one-offs (2026-11-03): scripts/_tmp-vets-nov2-ratings.ts
 * (record Mon 2 Nov's game and queue its rating DMs) and
 * scripts/_tmp-vets-nov-add.ts (add the 09:14 list's five to November).
 * No database, no network. Tests: scripts/_tmp-vets-nov2-plan.test.ts.
 */

/** Mon 2 Nov 2026, as Kemal gave it. RED/YELLOW are the app's internal
 *  slots (`Team` enum); the club's own words go in `Match.teamLabels`. */
export const NOV2_GAME = {
  londonDate: "2026-11-02",
  red: { label: "Bibs", score: 3, players: ["Jon", "Andrew", "smiler", "Kemal", "Davide", "CJ"] },
  yellow: { label: "No bibs", score: 4, players: ["Ben", "Nabz", "Ibrahim Sahin", "Craig", "Steve", "Oumesh", "Luca"] },
} as const;

/** Played as a guest from another club (partner guest shape). */
export const GUEST_LIST_NAMES = new Set(["ibrahim sahin"]);

export function allListNames(): string[] {
  return [...NOV2_GAME.red.players, ...NOV2_GAME.yellow.players];
}

export function teamOfListName(name: string): "RED" | "YELLOW" | null {
  const k = name.trim().toLowerCase();
  if (NOV2_GAME.red.players.some((p) => p.toLowerCase() === k)) return "RED";
  if (NOV2_GAME.yellow.players.some((p) => p.toLowerCase() === k)) return "YELLOW";
  return null;
}

type Normalise = (raw: string | null | undefined) => string | null;

export interface MappingEntry {
  listName: string;
  phone: string | null;
  userId: string | null;
  /** Create a phoneless club player (the admin "add by name" path). */
  create: boolean;
  /** Given as null: not known yet. Never guessed. */
  unknown: boolean;
  /** Left off the recorded game (e.g. a child with no account). */
  skip: boolean;
  seed: number | null;
}

const isSeed = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10;

/**
 * The name -> person mapping file. Keys are the team-sheet names (any
 * case). A value is a phone, a userId (starts with "c"), null (not known
 * yet), or `{ phone | userId | create: "phoneless" | skip: true, seed? }`.
 */
export function parseMapping(raw: unknown, normalise: Normalise): { entries: Map<string, MappingEntry>; errors: string[] } {
  const entries = new Map<string, MappingEntry>();
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { entries, errors: ["the mapping must be a JSON object"] };
  const roster = new Map(allListNames().map((n) => [n.toLowerCase(), n]));
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim().toLowerCase();
    const listName = roster.get(k);
    if (!listName) {
      errors.push(`"${key}" is not one of the 2 Nov players`);
      continue;
    }
    if (seen.has(k)) {
      errors.push(`"${key}" is given twice`);
      continue;
    }
    seen.add(k);
    const e: MappingEntry = { listName, phone: null, userId: null, create: false, unknown: false, skip: false, seed: null };
    const v = typeof value === "string" ? (value.trim().startsWith("c") ? { userId: value.trim() } : { phone: value }) : value;
    if (v === null) {
      entries.set(k, { ...e, unknown: true });
      continue;
    }
    if (typeof v !== "object" || Array.isArray(v)) {
      errors.push(`"${key}": not a phone, a userId, null or an object`);
      continue;
    }
    const o = v as { phone?: unknown; userId?: unknown; create?: unknown; skip?: unknown; seed?: unknown };
    if (o.seed !== undefined && o.seed !== null && !isSeed(o.seed)) {
      errors.push(`"${key}": a seed is a whole number from 1 to 10`);
      continue;
    }
    e.seed = isSeed(o.seed) ? o.seed : null;
    if (o.phone !== undefined && o.userId !== undefined) {
      errors.push(`"${key}": give a phone OR a userId, not both`);
      continue;
    }
    if (typeof o.phone === "string") {
      const p = normalise(o.phone);
      if (!p) {
        errors.push(`"${key}": "${o.phone}" is not a phone number`);
        continue;
      }
      e.phone = p;
    } else if (typeof o.userId === "string" && o.userId.trim()) {
      e.userId = o.userId.trim();
    } else if (o.create === "phoneless") {
      e.create = true;
    } else if (o.skip === true) {
      e.skip = true;
    } else {
      errors.push(`"${key}": needs a phone, a userId, "create": "phoneless" or "skip": true`);
      continue;
    }
    entries.set(k, e);
  }
  return { entries, errors };
}

/** The app's naming rule (`ensureOrgPlayer`): a nameless user the club
 *  owns gets the name; an existing name is never overwritten. */
export function planNaming(p: { current: string | null; listName: string; clubOwned: boolean }):
  | { action: "name"; to: string }
  | { action: "keep"; current: string }
  | { action: "not-owned" } {
  const current = p.current?.trim() ?? "";
  if (current) return { action: "keep", current: p.current as string };
  if (!p.clubOwned) return { action: "not-owned" };
  return { action: "name", to: p.listName.trim() };
}

/** A club seed is written only where there is none; a different existing
 *  one is reported, never changed. */
export function planSeed(current: number | null, wanted: number | null):
  | { action: "write"; to: number }
  | { action: "same" }
  | { action: "differs"; current: number; wanted: number }
  | { action: "none" } {
  if (wanted == null) return { action: "none" };
  if (current == null) return { action: "write", to: wanted };
  if (current === wanted) return { action: "same" };
  return { action: "differs", current, wanted };
}

export type RateDmSkip = "ratings-off" | "mom-announced" | "no-phone" | "opted-out" | "already-rated" | "already-sent";

/** The rating DM's gates: the late-DM path's (`addPlayerToMatch`: ratings
 *  on, MoM not yet announced, a phone, no `rate-dm` key) plus the
 *  scheduler's 6b (not opted out of rating DMs, not already rated). */
export function rateDmDecision(p: {
  hasPhone: boolean;
  optedOut: boolean;
  engaged: boolean;
  alreadyKeyed: boolean;
  playerRating: boolean;
  momAnnounced: boolean;
}): { send: true } | { send: false; reason: RateDmSkip } {
  if (!p.playerRating) return { send: false, reason: "ratings-off" };
  if (p.momAnnounced) return { send: false, reason: "mom-announced" };
  if (!p.hasPhone) return { send: false, reason: "no-phone" };
  if (p.optedOut) return { send: false, reason: "opted-out" };
  if (p.engaged) return { send: false, reason: "already-rated" };
  if (p.alreadyKeyed) return { send: false, reason: "already-sent" };
  return { send: true };
}

export interface MonthAddRow {
  listName: string;
  phone: string | null;
  userId: string | null;
  /** "says paid" on the list. */
  paid: boolean;
  /** "4 only"; null = every game left. */
  games: number | null;
}

/** The November additions file: `[{ name, phone | userId, paid?, games? }]`. */
export function parseMonthAdds(raw: unknown, normalise: Normalise): { rows: MonthAddRow[]; errors: string[] } {
  const rows: MonthAddRow[] = [];
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { rows, errors: ["the additions must be a JSON array"] };
  raw.forEach((r, i) => {
    const o = (r ?? {}) as { name?: unknown; phone?: unknown; userId?: unknown; paid?: unknown; games?: unknown };
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) return void errors.push(`row ${i + 1}: needs a name`);
    const phone = typeof o.phone === "string" ? normalise(o.phone) : null;
    const userId = typeof o.userId === "string" && o.userId.trim() ? o.userId.trim() : null;
    if (typeof o.phone === "string" && !phone) return void errors.push(`"${name}": "${o.phone}" is not a phone number`);
    if (!phone && !userId) return void errors.push(`"${name}": needs a phone or a userId`);
    const games = o.games === undefined || o.games === null ? null : o.games;
    if (games !== null && !(typeof games === "number" && Number.isInteger(games) && games >= 1 && games <= 10)) {
      return void errors.push(`"${name}": games is a whole number from 1 to 10`);
    }
    rows.push({ listName: name, phone, userId, paid: o.paid === true, games: games as number | null });
  });
  return { rows, errors };
}
