/**
 * THE FACTS A GUEST IS TOLD, AND THE GAMES HE CAN BE ADDED TO (2026-11-17).
 * Thin reads. The game's club, kick-off, venue and fee are the friend
 * link's (`friend-link/facts.ts`, the pool's fee rule); this adds what the
 * welcome DM also shows: the format the game is played at
 * (`matchFormatTitle`), the venue's address and its map link
 * (`venueMapUrl`, the club's linked place).
 */
import { db } from "../db";
import { loadFriendMatchFacts } from "../friend-link/facts";
import { matchFormatTitle } from "../match-format-title";
import { getOrgFeatures } from "../org-features";
import { venueMapUrl } from "../venue-location-rules";
import type { GuestGameFacts } from "./copy";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;
/** How far ahead a guest can be added from a message. */
export const GUEST_GAMES_AHEAD_MS = 14 * 24 * 3600_000;

export interface GuestMatchFacts extends GuestGameFacts {
  matchId: string;
  orgId: string;
  language: string;
  benchPickMode: string | null;
}

export async function loadGuestMatchFacts(matchId: string): Promise<GuestMatchFacts | null> {
  const base = await loadFriendMatchFacts(matchId);
  if (!base) return null;
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: { maxPlayers: true, activity: { select: { name: true, venueRef: { select: { placeId: true, lat: true, lng: true } } } } },
  });
  const format = m ? matchFormatTitle(m.activity.name, m.maxPlayers).trim() || null : null;
  const ref = m?.activity.venueRef ?? null;
  return {
    matchId,
    orgId: base.orgId,
    language: base.language,
    benchPickMode: base.benchPickMode,
    club: base.club,
    kickoff: base.kickoff,
    format,
    venue: base.venue,
    address: base.address,
    mapUrl: (ref ? venueMapUrl({ placeId: ref.placeId ?? null, lat: ref.lat ?? null, lng: ref.lng ?? null }) : null) ?? mapSearchUrl(base.address ?? base.venue),
    fee: base.fee,
    monthly: base.monthly,
  };
}

/** A place the club has not linked: a Maps search on its address, else its
 *  name. The same URL shape as `venueMapUrl`, by text instead of a point. */
export function mapSearchUrl(text: string | null | undefined): string | null {
  const q = text?.trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: q }).toString()}`;
}

export interface ComingGame {
  matchId: string;
  orgId: string;
  club: string;
  kickoff: Date;
}

/** The coming games of these clubs that take players (attendance on), soonest first. */
export async function loadComingGames(orgIds: readonly string[], now: Date): Promise<ComingGame[]> {
  if (orgIds.length === 0) return [];
  const taking: string[] = [];
  for (const id of orgIds) if ((await getOrgFeatures(id)).attendance) taking.push(id);
  if (taking.length === 0) return [];
  const rows = await db.match.findMany({
    where: {
      activity: { orgId: { in: taking } },
      status: { in: [...LIVE] },
      isHistorical: false,
      date: { gt: now, lte: new Date(now.getTime() + GUEST_GAMES_AHEAD_MS) },
    },
    orderBy: { date: "asc" },
    take: 6,
    select: { id: true, date: true, activity: { select: { orgId: true, org: { select: { name: true } } } } },
  });
  return rows.map((r) => ({ matchId: r.id, orgId: r.activity.orgId, club: r.activity.org.name, kickoff: r.date }));
}
