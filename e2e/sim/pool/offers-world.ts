/**
 * THE POOL SCENARIO DSL FOR OFFERS (slice L5a, 2026-10-24). Helpers on top
 * of `world.ts` for the asking, offering and accepting scenarios. Kept in
 * their own file so the sign-up slice (L2) and this one never edit the same
 * lines of `world.ts`.
 *
 *   const fnf = await openClub(pool, "fnf", { name: "FNF", venue: CHEAM });
 *   const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", near: CHEAM });
 *   const ex = await organiserAsks(pool, fnf, { places: 1, now: t(-8) });
 *   pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer", text: /FNF/ }]);
 *   const out = await pollPlatform(pool, { now: t(-8) });     // what goes out now
 *   await tapYes(page, tapLinkIn(ex.sent[0]));                // the offer page
 *
 * PROFILES ARE SEEDED AS IF CONFIRMED. A pool player is written as L2's
 * confirmation leaves him (active, consent with the confirm message's id
 * as evidence, 18+), so these scenarios run before L2 lands. Once L2 is in,
 * a scenario can sign up through `pool.signUp` instead.
 *
 * TIME. Every call that decides by the clock takes `now` and sends it as
 * the `x-test-now` seam (honoured only under MT_TEST_MODE=1); the offer
 * page runs on the real clock, so kickoffs are in the real future and the
 * pinned times sit between the real now and kickoff. The pool switch is
 * the `x-mt-test-pool-open` seam, ON unless a scenario says otherwise.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { signInAs } from "../../fixtures";
import { E2E } from "../../helpers/env";
import { nextMsgId } from "../group";
import { formatLondon, londonDateTimeToUtc } from "../../../src/lib/london-time";
import { classifyPlatformJob, type SentMessage } from "./transcript";
import type { PoolClub, PoolClubOpts, PoolPerson, PoolWorld, Exchange } from "./world";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };
const POOL_OPEN = "x-mt-test-pool-open";

export interface Spot {
  lat: number;
  lng: number;
}

/**
 * EVERY CLUB GETS ITS OWN AREA. Scenarios in one file share a database
 * (`scenarios` resets it once), so a pool player from an earlier scenario
 * would rightly be offered a later scenario's game if they played in the
 * same place. Each club's venue is therefore ~20 miles from every other
 * club's (beyond the farthest travel distance), and players are placed
 * relative to THEIR club: `near(club)` about 1.8 miles away, `far(club)`
 * about 12. Two clubs that should share players pass `venue: near(other)`.
 */
let areaSeq = 0;
const nextArea = (): Spot => {
  areaSeq++;
  return { lat: 50.6 + (areaSeq % 8) * 0.3, lng: -3.5 + Math.floor(areaSeq / 8) * 0.45 };
};
export const near = (c: { spot: Spot } | Spot): Spot => {
  const s = "spot" in c ? c.spot : c;
  return { lat: s.lat + 0.021, lng: s.lng + 0.029 };
};
export const far = (c: { spot: Spot } | Spot): Spot => {
  const s = "spot" in c ? c.spot : c;
  return { lat: s.lat + 0.16, lng: s.lng + 0.18 };
};

let venueSeq = 0;

export interface OpenClubOpts extends PoolClubOpts {
  /** The venue: its own area by default; null: no linked venue at all. */
  venue?: (Partial<Spot> & { name?: string; address?: string }) | null;
  benchPickMode?: "first-come" | "organiser";
  feePerPlayer?: number | null;
  /** Hours from the real now to kickoff (default 48: two days, as createGroup). */
  kickoffInHours?: number;
}

/** A club with the pool switched on for it and a geocoded venue. */
export async function openClub(world: PoolWorld, key: string, opts: OpenClubOpts = {}): Promise<PoolClub & { kickoff: Date; spot: Spot }> {
  const { venue, benchPickMode, feePerPlayer, kickoffInHours, ...clubOpts } = opts;
  const club = await world.club(key, {
    ...clubOpts,
    upcomingMatch: kickoffInHours ? { hoursFromNow: kickoffInHours } : clubOpts.upcomingMatch,
    pool: { featurePlayerPool: true, ...(clubOpts.pool ?? {}) },
  });
  const spot: Spot = venue === null ? nextArea() : { ...nextArea(), ...(venue ?? {}) };
  if (venue !== null) {
    const id = `sim-venue-${++venueSeq}-${nextMsgId()}`;
    await world.db.run(
      `INSERT INTO "Venue" (id, name, "formattedAddress", lat, lng, "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`,
      [id, venue?.name ?? "Goals North Cheam", venue?.address ?? "Cheam Common Rd, Worcester Park KT4 8RH", spot.lat, spot.lng],
    );
    await world.db.run(`UPDATE "Activity" SET "venueId" = $2 WHERE id = $1`, [club.group.activityId, id]);
  }
  if (benchPickMode) await world.db.run(`UPDATE "Organisation" SET "benchPickMode" = $2 WHERE id = $1`, [club.group.orgId, benchPickMode]);
  if (feePerPlayer !== undefined) await world.db.run(`UPDATE "Activity" SET "feePerPlayer" = $2 WHERE id = $1`, [club.group.activityId, feePerPlayer]);
  const m = await world.db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [club.group.matchId]);
  return Object.assign(club, { kickoff: m!.date, spot });
}

/** A London wall-clock time on the day `days` from kickoff's day. */
export function londonOn(kickoff: Date, days: number, time: string): Date {
  const day = formatLondon(new Date(kickoff.getTime() + days * 24 * 3600_000), "yyyy-MM-dd");
  return londonDateTimeToUtc(day, time);
}

/** Another upcoming match of the club's activity, `hours` after its first. */
export async function extraMatch(world: PoolWorld, club: PoolClub & { kickoff: Date }, hours: number): Promise<{ id: string; kickoff: Date }> {
  const id = `sim-match-extra-${nextMsgId()}`;
  const kickoff = new Date(club.kickoff.getTime() + hours * 3600_000);
  await world.db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 14, 'UPCOMING', $3, now())`,
    [id, club.group.activityId, kickoff],
  );
  return { id, kickoff };
}

/** `hours` before (negative) or after kickoff. */
export const at = (kickoff: Date, hours: number): Date => new Date(kickoff.getTime() + hours * 3600_000);

export interface PoolPlayerOpts {
  name?: string;
  lang?: "en" | "tr";
  /** Where he lives: `near(club)` for a nearby player. Required. */
  at: Spot;
  maxMiles?: 1 | 3 | 5 | 10;
  /** Football formats he plays; [] any. */
  formats?: number[];
  /** "active" by default. */
  status?: "active" | "paused" | "stopped";
  /** Days 0..6 he is free, all day. Default every day. */
  days?: number[];
}

/** Someone in the pool: a stranger whose confirm message made him active. */
export async function poolPlayer(world: PoolWorld, key: string, opts: PoolPlayerOpts): Promise<PoolPerson & { userId: string }> {
  const name = opts.name ?? `${key[0].toUpperCase()}${key.slice(1)} Pool`;
  const p = await world.stranger(key, { name });
  const userId = `sim-pool-u-${key}-${nextMsgId()}`;
  await world.db.run(`INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1, $2, $3, $4, true, true, now())`, [
    userId,
    name,
    `${userId}@pool.sim.matchtime.test`,
    p.phone,
  ]);
  const home = opts.at;
  const profileId = `sim-pool-p-${key}-${nextMsgId()}`;
  const status = opts.status ?? "active";
  await world.db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "pausedReason", "pausedAt", "stoppedAt", "consentAt", "consentVersion", "consentChannel", "consentEvidence",
       "adultConfirmedAt", language, "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now(), 1, 'whatsapp', $7, now(), $8, $9, 'SM3', $10, $11, $12, 'web', now())`,
    [
      profileId,
      userId,
      status,
      status === "paused" ? "self" : null,
      status === "paused" ? new Date() : null,
      status === "stopped" ? new Date() : null,
      `wamid-confirm-${nextMsgId()}`,
      opts.lang ?? "en",
      name,
      home.lat,
      home.lng,
      opts.maxMiles ?? 3,
    ],
  );
  await world.db.run(`INSERT INTO "PoolSport" (id, "profileId", sport, formats) VALUES ($1, $2, 'football', $3)`, [`${profileId}-s`, profileId, opts.formats ?? []]);
  for (const day of opts.days ?? [0, 1, 2, 3, 4, 5, 6]) {
    await world.db.run(`INSERT INTO "PoolAvailability" (id, "profileId", day, "fromMin", "toMin") VALUES ($1, $2, $3, 0, 1440)`, [`${profileId}-a${day}`, profileId, day]);
  }
  return Object.assign(p, { userId });
}

const signedIn = new WeakMap<Page, string>();

/** The club's owner, signed in on this browser page (the real /r/ flow). */
async function signInOwner(world: PoolWorld, page: Page, club: PoolClub): Promise<void> {
  const owner = await world.userOf(club.member("owner"));
  if (!owner) throw new Error(`pool: club "${club.key}" has no owner`);
  if (signedIn.get(page) === owner.id) return;
  await signInAs(page, owner.id);
  signedIn.set(page, owner.id);
}

/** The organisers' one-tap approval (the match page's press, over HTTP
 *  with the organiser's session). */
export async function organiserAsks(
  world: PoolWorld,
  page: Page,
  club: PoolClub,
  opts: { places: number; now: Date; pool?: boolean; partnershipIds?: string[]; poolOpen?: boolean; matchId?: string },
): Promise<Exchange> {
  await signInOwner(world, page, club);
  world.log({ kind: "in", from: `${club.key}.owner`, channel: "dm", text: `(match page) ask ${opts.pool === false ? "partners" : "the pool"} for ${opts.places}` });
  const res = await page.request.post(`/api/matches/${opts.matchId ?? club.group.matchId}/ask-round`, {
    headers: { "x-test-now": opts.now.toISOString(), [POOL_OPEN]: opts.poolOpen === false ? "0" : "1" },
    data: { places: opts.places, pool: opts.pool !== false, partnershipIds: opts.partnershipIds ?? [] },
    maxRedirects: 0,
  });
  expect(res.status(), await res.text()).toBe(200);
  return { json: (await res.json()) as Record<string, unknown>, sent: await world.collect() };
}

/** The Pi's platform poll at `now`: the sweep runs, then the claim. What
 *  it hands out is what goes out now. */
export async function pollPlatform(world: PoolWorld, opts: { now: Date; poolOpen?: boolean }): Promise<{ out: SentMessage[]; queued: SentMessage[] }> {
  world.note(`(the Pi polls at ${opts.now.toISOString()})`);
  const res = await world.request.get("/api/whatsapp/platform-jobs", {
    headers: { ...PI, "x-test-now": opts.now.toISOString(), [POOL_OPEN]: opts.poolOpen === false ? "0" : "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string; kind: string; phone?: string; text?: string; purpose?: string }> };
  const queued = await world.collect();
  const byId = new Map(world.sent.map((m) => [m.id, m]));
  const out = jobs.map(
    (j) =>
      byId.get(j.id) ??
      classifyPlatformJob({ id: j.id, kind: j.kind, phone: j.phone ?? null, groupId: null, text: j.text ?? null, purpose: j.purpose ?? "?", sendAfter: null }, registryless(world, j.phone)),
  );
  return { out, queued };
}

function registryless(world: PoolWorld, phone: string | undefined) {
  void world;
  return { people: new Map(phone ? [[phone.replace(/\D/g, ""), `unknown:+${phone}`]] : []), clubs: new Map() };
}

/** The Pi reports every handed-out job sent (so a later poll does not see
 *  them claimed forever). */
export async function reportSent(world: PoolWorld, messages: readonly SentMessage[]): Promise<void> {
  for (const m of messages) {
    const res = await world.request.post("/api/whatsapp/platform-jobs", { headers: PI, data: { id: m.id, outcome: "sent", waMessageId: `wamid-${nextMsgId()}` } });
    expect(res.status()).toBe(200);
  }
}

/** The tap link in an offer DM, as a path. */
export function tapLinkIn(m: SentMessage): string {
  const hit = /https?:\/\/[^\s]+(\/play\/offer\/[A-Za-z0-9_.-]+)/.exec(m.text);
  if (!hit) throw new Error(`no tap link in: ${m.text}`);
  return hit[1];
}

/** Open the offer page and press a button; returns the page's new state. */
export async function tapOffer(page: Page, path: string, button: "yes" | "no" | "pull-out"): Promise<string> {
  await page.goto(path);
  const root = page.getByTestId("pool-offer-page");
  const before = await root.getAttribute("data-state");
  await page.getByTestId(`pool-offer-${button}`).click();
  await expect(root).not.toHaveAttribute("data-state", before ?? "", { timeout: 20_000 });
  return (await root.getAttribute("data-state")) ?? "";
}

export interface OfferRow {
  id: string;
  userId: string;
  wave: number;
  sentAt: Date | null;
  expiresAt: Date;
  outcome: string | null;
  platformJobId: string | null;
}

export function offersOf(world: PoolWorld, p: { userId: string }): Promise<OfferRow[]> {
  return world.db.all<OfferRow>(`SELECT id, "userId", wave, "sentAt", "expiresAt", outcome, "platformJobId" FROM "PoolOffer" WHERE "userId" = $1 ORDER BY "createdAt"`, [p.userId]);
}

export function askOf(world: PoolWorld, club: PoolClub): Promise<{ id: string; status: string; closeReason: string | null; roundId: string | null } | null> {
  return world.db.one(`SELECT id, status, "closeReason", "roundId" FROM "PoolAsk" WHERE "orgId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [club.group.orgId]);
}

/** Pretend `n` pool DMs went out at `at` (the platform cap's count). */
export async function pastPoolSends(world: PoolWorld, club: PoolClub, n: number, sentAt: Date): Promise<void> {
  const ask = `sim-past-ask-${nextMsgId()}`;
  await world.db.run(
    `INSERT INTO "PoolAsk" (id, "matchId", "orgId", places, via, status, "closedAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, 1, 'page', 'closed', now(), $4, now())`,
    [ask, club.group.matchId, club.group.orgId, new Date(sentAt.getTime() - 8 * 24 * 3600_000)],
  );
  for (let i = 0; i < n; i++) {
    await world.db.run(
      `INSERT INTO "PoolOffer" (id, "poolAskId", "matchId", "orgId", "userId", "distanceMiles", "sentAt", "expiresAt", outcome, "resolvedAt")
       VALUES ($1, $2, $3, $4, $5, 1, $6, $6, 'expired', $6)`,
      [`${ask}-o${i}`, ask, club.group.matchId, club.group.orgId, `sim-ghost-${nextMsgId()}`, sentAt],
    );
  }
}
