/**
 * FINDING CLUBS NEARBY: the pure rules (partner discovery, slice P2,
 * 2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 2.1
 * to 2.4 and 9. No database import: the loader is club-discovery.ts.
 *
 * WHO IS LISTED (2.1). Approved, with a players' group, with "Let nearby
 * clubs find us and send requests" on (the default), and with a geocoded
 * venue: an active game's venue, or the club venue (`homeVenueId`). Dormant,
 * billing-paused and trial clubs are NOT excluded (Kemal, 2026-10-22: "the
 * more we show in the search results, the better"), so nothing here reads
 * dormancy or billing.
 *
 * WHO MAY SEARCH (D-3). A club that is itself listed. Without a venue it
 * sees "Confirm your venue" instead.
 *
 * DISTANCE (2.2). From each of our active games' venues to each of theirs;
 * a club with no active game (or none with a position) is measured from its
 * club venue. In range when any pair is; the card shows the nearest, to 0.1
 * mile. Presets 1, 3, 5 and 10 miles, default 3, never more than 10.
 *
 * WHAT A CARD SHOWS (2.3, 2.4, D-8, D-10). Club name, venue name and town,
 * distance, each active game's day, kickoff and format, the exact count of
 * live non-guest members and the regular players. Never a name, a phone
 * number, a group, a link, a fee, a rating, match history or coordinates.
 */
import { distanceKm } from "./geo";
import { APPROVED_CLUB_WHERE } from "./club-approval-state";

// ─── The radius ─────────────────────────────────────────────────────────

export const RADIUS_PRESETS_MILES = [1, 3, 5, 10] as const;
export type RadiusMiles = (typeof RADIUS_PRESETS_MILES)[number];
export const DEFAULT_RADIUS_MILES: RadiusMiles = 3;
/** Kemal, 2026-10-22: players will not travel further. */
export const MAX_RADIUS_MILES = 10;
export const KM_PER_MILE = 1.609344;
export const NEARBY_PAGE_SIZE = 50;

/** One of the presets, from the URL; anything else is the default. */
export function parseRadiusMiles(value: unknown): RadiusMiles {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return (RADIUS_PRESETS_MILES as readonly number[]).includes(n) && n <= MAX_RADIUS_MILES ? (n as RadiusMiles) : DEFAULT_RADIUS_MILES;
}

export function parsePage(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function parseSameDay(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

// ─── Positions and distance ─────────────────────────────────────────────

export interface Position {
  lat: number | null;
  lng: number | null;
}
export interface Point {
  lat: number;
  lng: number;
}

const hasPosition = <V extends Position>(v: V | null | undefined): v is V & Point =>
  !!v && typeof v.lat === "number" && typeof v.lng === "number";

/** Mean km per degree of latitude, and of longitude at the equator. */
const KM_PER_DEGREE = 111.195;

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Every point within `radiusMiles` of `origin` lies in this box (with a 1%
 * margin). The box is only the database's coarse cut; the exact distance
 * decides, so its corners are never "in range".
 */
export function boundingBox(origin: Point, radiusMiles: number): BoundingBox {
  const km = Math.min(radiusMiles, MAX_RADIUS_MILES) * KM_PER_MILE * 1.01;
  const dLat = km / KM_PER_DEGREE;
  const cos = Math.max(0.01, Math.cos((origin.lat * Math.PI) / 180));
  const dLng = km / (KM_PER_DEGREE * cos);
  return { minLat: origin.lat - dLat, maxLat: origin.lat + dLat, minLng: origin.lng - dLng, maxLng: origin.lng + dLng };
}

export function roundMiles(miles: number): number {
  return Math.round(miles * 10) / 10;
}

/** The nearest pair, exact (haversine, `distanceKm`), and which of theirs. */
export function nearestMiles(ours: Point[], theirs: Point[]): { miles: number; theirIndex: number } | null {
  let best: { miles: number; theirIndex: number } | null = null;
  for (const a of ours) {
    theirs.forEach((b, i) => {
      const miles = distanceKm(a.lat, a.lng, b.lat, b.lng) / KM_PER_MILE;
      if (!best || miles < best.miles) best = { miles, theirIndex: i };
    });
  }
  return best;
}

export function inRange(miles: number, radiusMiles: number): boolean {
  return miles <= Math.min(radiusMiles, MAX_RADIUS_MILES);
}

/**
 * Where a club is measured from: every ACTIVE game's geocoded venue; if
 * there is none, its club venue; otherwise nowhere. Generic, so the caller
 * keeps the venue's name and address alongside its position.
 */
export function measuredFrom<V extends Position>(club: {
  homeVenue: V | null;
  games: Array<{ isActive: boolean; venue: V | null }>;
}): Array<V & Point> {
  const games = club.games.filter((g) => g.isActive).map((g) => g.venue).filter(hasPosition);
  if (games.length > 0) return games;
  return hasPosition(club.homeVenue) ? [club.homeVenue] : [];
}

// ─── Who is listed, who may search ──────────────────────────────────────

export interface ListableClub {
  /** `isClubApproved` (club-approval.ts is the one reader of the state). */
  approved: boolean;
  hasPlayersGroup: boolean;
  discoverable?: boolean | null;
  homeVenue: Position | null;
  games: Array<{ isActive: boolean; venue: Position | null }>;
}

/** The database side of `isListable`, minus the venue (the box does that).
 *  Nothing about dormancy or billing, on purpose. */
export const LISTABLE_CLUB_WHERE = { ...APPROVED_CLUB_WHERE, whatsappGroupId: { not: null }, discoverable: true } as const;

export function isListable(club: ListableClub): boolean {
  return searcherState(club) === "ok";
}

export type SearcherState = "ok" | "not-live" | "not-discoverable" | "no-venue";

/** May this club search? Only when it is itself listed (D-3). */
export function searcherState(club: ListableClub): SearcherState {
  if (!club.approved || !club.hasPlayersGroup) return "not-live";
  if (club.discoverable === false) return "not-discoverable";
  if (measuredFrom(club).length === 0) return "no-venue";
  return "ok";
}

// ─── The same-day filter ────────────────────────────────────────────────

/**
 * "Plays on the same day as us", off by default. On, it keeps a club that
 * plays on one of our game days. A club with no game is never excluded;
 * and with no game of our own there is nothing to compare, so it keeps all.
 */
export function sameDayKeeps(ourDays: number[], theirDays: number[], on: boolean): boolean {
  if (!on || ourDays.length === 0 || theirDays.length === 0) return true;
  return theirDays.some((d) => ourDays.includes(d));
}

// ─── Hidden clubs and statuses ──────────────────────────────────────────

/** After a club declines us or ends with us, it is not listed for 30 days. */
export const REPLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export interface RelationRow {
  askerOrgId: string;
  partnerOrgId: string;
  status: string;
  askerAcceptedAt: Date | null;
  partnerAcceptedAt: Date | null;
  endReason: string | null;
  endedByOrgId: string | null;
  endedAt: Date | null;
}
export interface BlockRow {
  blockerOrgId: string;
  blockedOrgId: string;
}

/**
 * Never listed: ourselves; a club that blocked us or that we blocked; a
 * club that declined us or ended a pairing with us in the last 30 days
 * (`endReason` "declined" or "ended", `endedByOrgId` theirs). Our own end,
 * a withdrawal, an expiry or the platform's end starts no wait.
 */
export function hiddenOrgIds(a: { selfOrgId: string; blocks: BlockRow[]; partnerships: RelationRow[]; now: Date }): Set<string> {
  const hidden = new Set<string>([a.selfOrgId]);
  for (const b of a.blocks) {
    if (b.blockedOrgId === a.selfOrgId) hidden.add(b.blockerOrgId);
    if (b.blockerOrgId === a.selfOrgId) hidden.add(b.blockedOrgId);
  }
  for (const p of a.partnerships) {
    const other = p.askerOrgId === a.selfOrgId ? p.partnerOrgId : p.partnerOrgId === a.selfOrgId ? p.askerOrgId : null;
    if (!other || p.endedByOrgId !== other || !p.endedAt) continue;
    if (p.endReason !== "declined" && p.endReason !== "ended") continue;
    if (a.now.getTime() - p.endedAt.getTime() < REPLY_COOLDOWN_MS) hidden.add(other);
  }
  return hidden;
}

export type CardStatus = "paired" | "paused" | "pending";

/**
 * What stands in place of the checkbox: our pairing with them (we ask
 * them), active, paused or still proposed. A pairing in which THEY ask US
 * is the other direction (D-1), so it leaves the checkbox.
 */
export function cardStatus(selfOrgId: string, otherOrgId: string, partnerships: RelationRow[]): CardStatus | null {
  const p = partnerships.find((r) => r.askerOrgId === selfOrgId && r.partnerOrgId === otherOrgId && r.status !== "ended");
  if (!p) return null;
  if (p.status === "active") return "paired";
  if (p.status === "paused") return "paused";
  return "pending";
}

// ─── The card ───────────────────────────────────────────────────────────

export interface NearbyClubGame {
  /** 0 = Sunday. */
  dow: number;
  time: string;
  /** Players per team: "7-a-side". */
  perSide: number;
}

export interface NearbyClubCard {
  orgId: string;
  name: string;
  venueName: string;
  town: string | null;
  miles: number;
  /** Empty: "No regular game yet". */
  games: NearbyClubGame[];
  /** Live, non-guest members. */
  members: number;
  /** Played at least 2 of the club's last 8 games. */
  regulars: number;
  status: CardStatus | null;
}

/** Exactly the card's fields; the loader's guard test pins it. */
export const CARD_KEYS = ["orgId", "name", "venueName", "town", "miles", "games", "members", "regulars", "status"] as const satisfies ReadonlyArray<keyof NearbyClubCard>;

const COUNTRIES = new Set(["uk", "united kingdom", "england", "scotland", "wales", "northern ireland", "türkiye", "turkiye", "turkey"]);
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
const NUMERIC_POSTCODE = /\b\d{4,5}\b/g;

/**
 * The town part of Google's formatted address: drop the country, take the
 * last part left, strip its postcode. "Purley Way, Croydon CR0 4RQ, UK" is
 * "Croydon". Null when nothing is left.
 */
export function townOf(formattedAddress: string | null | undefined): string | null {
  if (!formattedAddress) return null;
  const parts = formattedAddress.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0 && (parts.length >= 2 || COUNTRIES.has(parts[parts.length - 1].toLowerCase()))) parts.pop();
  for (let i = parts.length - 1; i >= 0; i--) {
    const town = parts[i].replace(UK_POSTCODE, "").replace(NUMERIC_POSTCODE, "").replace(/\s+/g, " ").trim();
    if (town) return town;
  }
  return null;
}

export const REGULAR_LAST_GAMES = 8;
export const REGULAR_MIN_PLAYED = 2;

/**
 * Regular players: how many played at least 2 of the club's last 8 games.
 * `games` newest first, each with who played (CONFIRMED); `members` the
 * live non-guest members, when the caller has not already filtered.
 */
export function regularPlayers(games: Array<{ userIds: string[] }>, members: Set<string> | null = null): number {
  const played = new Map<string, number>();
  for (const g of games.slice(0, REGULAR_LAST_GAMES)) {
    for (const u of new Set(g.userIds)) {
      if (members && !members.has(u)) continue;
      played.set(u, (played.get(u) ?? 0) + 1);
    }
  }
  let n = 0;
  for (const c of played.values()) if (c >= REGULAR_MIN_PLAYED) n++;
  return n;
}

// ─── The send ───────────────────────────────────────────────────────────

/** The shape `sendPartnerRequestsAction` returns (src/app/actions/
 *  partner-requests.ts; slice P3 owns it), read structurally here so this
 *  pure file imports nothing from the server. */
export interface SendResultShape {
  ok: boolean;
  error?: string;
  results?: Array<{ orgId: string; outcome: "sent" | "refused"; reason?: string }>;
  /** Only the nearest 20 were sent: the daily cap (D-4). */
  capped?: boolean;
}

export interface SendOutcomes {
  failed: boolean;
  capped: boolean;
  byOrg: Record<string, { outcome: "sent" | "refused"; reason?: string }>;
}

/** The page's reading of a send: per club, sent or refused with a reason. */
export function readSendResult(r: SendResultShape | null | undefined): SendOutcomes {
  if (!r || !r.ok || !Array.isArray(r.results)) return { failed: true, capped: false, byOrg: {} };
  const byOrg: SendOutcomes["byOrg"] = {};
  for (const x of r.results) byOrg[x.orgId] = x.reason ? { outcome: x.outcome, reason: x.reason } : { outcome: x.outcome };
  return { failed: false, capped: r.capped === true, byOrg };
}
