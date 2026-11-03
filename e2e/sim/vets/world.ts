/**
 * THE VETS SANDBOX (2026-11-03): a copy of the Vets MNF club's SHAPE, for
 * proving end to end, before MatchTime is unmuted there, that every
 * feature the group was told about works.
 *
 * The shape was read from production read-only (org settings, fixture,
 * member counts); every name and number here is fictitious:
 *
 *   - squadMode "monthly", rollingSquadEnabled false, paygPricePence 800,
 *     payment tracking and collection off, the player pool off, partner
 *     asks off, momChosenBy "players", admin channel "one-person";
 *   - one fixture, Monday 20:30, 14 places, 60 minutes, rating window 120h;
 *   - 27 members: the owner "Davide" and 26 players, 20 of them with NO
 *     name (imported from the WhatsApp member list, phone only).
 *
 * Built on the pool world (`../pool/world.ts`), so every message goes
 * through the real routes and every queued message lands in the
 * transcript a failed scenario prints. The model is whatever the run is:
 * live on ANTHROPIC_API_KEY_DEV under MT_SIM_LIVE_LLM=1, nothing on the
 * path under test stubbed.
 */
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { expect } from "@playwright/test";
import { E2E } from "../../helpers/env";
import type { TestDb } from "../../helpers/test-db";
import { nextMsgId, type SimPlayerSpec, type SimHistoryEntry } from "../group";
import type { PoolClub, PoolWorld } from "../pool/world";
import type { SentMessage } from "../pool/transcript";

export const LONDON = "Europe/London";
const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

/**
 * The cast. `pushname` is what WhatsApp shows the bot for a nameless
 * member (the Pi forwards it as authorName); null = none at all, which is
 * how several Vets members arrive.
 */
interface VetsMember extends SimPlayerSpec {
  nameless?: boolean;
  pushname?: string | null;
}

export const VETS_MEMBERS: VetsMember[] = [
  { key: "davide", name: "Davide Russo", role: "OWNER" },
  // Named players (7 named members in all, the owner included).
  { key: "shane", name: "Shane Walton" },
  { key: "kerem", name: "Kerem Aksoy" },
  { key: "cj", name: "CJ Barlow" },
  { key: "tom", name: "Tom Hale" },
  { key: "rob", name: "Rob Finch" },
  { key: "gus", name: "Gus Moore" },
  // Twenty players with no name: on the month's list by first name only.
  { key: "nabz", name: "x", nameless: true, pushname: "Nabz" },
  { key: "steff", name: "x", nameless: true, pushname: "Steff" },
  { key: "craig", name: "x", nameless: true, pushname: null },
  { key: "dan", name: "x", nameless: true, pushname: "Dan" },
  { key: "ben", name: "x", nameless: true, pushname: null },
  { key: "steve", name: "x", nameless: true, pushname: "Steve" },
  { key: "andrew", name: "x", nameless: true, pushname: null },
  { key: "jon", name: "x", nameless: true, pushname: "Jon" },
  { key: "oumesh", name: "x", nameless: true, pushname: null },
  { key: "luca", name: "x", nameless: true, pushname: "Luca" },
  { key: "p11", name: "x", nameless: true, pushname: null },
  { key: "p12", name: "x", nameless: true, pushname: "Mo" },
  { key: "p13", name: "x", nameless: true, pushname: null },
  { key: "p14", name: "x", nameless: true, pushname: null },
  { key: "p15", name: "x", nameless: true, pushname: "Big Al" },
  { key: "p16", name: "x", nameless: true, pushname: null },
  { key: "p17", name: "x", nameless: true, pushname: null },
  { key: "p18", name: "x", nameless: true, pushname: "Rich" },
  { key: "p19", name: "x", nameless: true, pushname: null },
  { key: "p20", name: "x", nameless: true, pushname: null },
];

/**
 * The month's list as Davide posts it (the real one's format, fake names
 * matching this cast's first names). Thirteen lines, as on 3 Nov.
 */
export function monthListText(monthName: string): string {
  return (
    `MNF ${monthName} \n\n` +
    `1. Davide (paid)\n` +
    `2. ⁠Nabz ( paid 4 only ) \n` +
    `3. ⁠steff ( paid full )\n` +
    `4. Craig (paid 4)\n` +
    `5. Dan (full)\n` +
    `6. ⁠Ben (full fat)\n` +
    `7. Kerem (paid)\n` +
    `8. ⁠Steve (paid)\n` +
    `9. Andrew (paid)\n` +
    `10. ⁠Jon (paid)\n` +
    `11. ⁠Shane (Paid)\n` +
    `12. ⁠CJ (Paid)\n` +
    `13. ⁠Oumesh (paid 4)`
  );
}

/** The thirteen on that list, by cast key, in slot order. */
export const LIST_KEYS = ["davide", "nabz", "steff", "craig", "dan", "ben", "kerem", "steve", "andrew", "jon", "shane", "cj", "oumesh"];

/** London wall clock → instant. */
export function london(day: string, time: string): Date {
  return fromZonedTime(`${day}T${time}:00`, LONDON);
}

export const londonDay = (d: Date) => formatInTimeZone(d, LONDON, "yyyy-MM-dd");
export const londonWeekday = (d: Date) => Number(formatInTimeZone(d, LONDON, "i")) % 7; // 0 = Sunday

/** The next Monday 20:30 London strictly after `now`. */
export function nextMondayKickoff(now = new Date()): Date {
  for (let i = 0; i < 8; i++) {
    const day = londonDay(new Date(now.getTime() + i * 86_400_000));
    const k = london(day, "20:30");
    if (londonWeekday(k) === 1 && k.getTime() > now.getTime()) return k;
  }
  throw new Error("no Monday within a week");
}

/** The last Monday 20:30 London before `now`. */
export function lastMondayKickoff(now = new Date()): Date {
  for (let i = 0; i < 8; i++) {
    const day = londonDay(new Date(now.getTime() - i * 86_400_000));
    const k = london(day, "20:30");
    if (londonWeekday(k) === 1 && k.getTime() < now.getTime()) return k;
  }
  throw new Error("no Monday within a week");
}

export interface VetsClubOpts {
  /** "none": no SquadMonth (as on 3 Nov morning). "running": November started part-way, 13 regulars. */
  month?: "none" | "running";
  /** Upcoming kickoff; default next Monday 20:30. */
  kickoff?: Date;
  /** Add last Monday's game, played and COMPLETED, with these confirmed. */
  played?: { keys: string[]; teams?: Record<string, "RED" | "YELLOW">; redScore?: number; yellowScore?: number };
  /** Seed ratings (Membership.seedRating) by key; everybody else unseeded. */
  seedRatings?: Record<string, number>;
}

export interface VetsClub {
  club: PoolClub;
  orgId: string;
  matchId: string;
  kickoff: Date;
  playedMatchId: string | null;
  monthId: string | null;
  members: Map<string, VetsMember>;
  userId(key: string): string;
  phone(key: string): string;
}

/** The Vets club, in this world, under `key`. */
export async function vetsClub(pool: PoolWorld, key: string, opts: VetsClubOpts = {}): Promise<VetsClub> {
  const now = new Date();
  const kickoff = opts.kickoff ?? nextMondayKickoff(now);
  const played = opts.played;
  const lastKick = lastMondayKickoff(now);
  const club = await pool.club(key, {
    name: "Monday Night Vets Sandbox",
    maxPlayers: 14,
    players: VETS_MEMBERS.map(({ key: k, name, role }) => ({ key: k, name, role })),
    upcomingMatch: { hoursFromNow: (kickoff.getTime() - now.getTime()) / 3_600_000, deadlineHoursBeforeKickoff: 5 },
    ...(played
      ? {
          completedMatch: {
            hoursAgo: (now.getTime() - lastKick.getTime()) / 3_600_000,
            confirmedKeys: played.keys,
            teams: played.teams,
            redScore: played.redScore ?? 5,
            yellowScore: played.yellowScore ?? 3,
            status: "COMPLETED" as const,
          },
        }
      : {}),
  });
  const g = club.group;
  const orgId = g.orgId;
  await pool.db.run(
    `UPDATE "Organisation" SET
       "squadMode" = 'monthly', "rollingSquadEnabled" = false, "paygPricePence" = 800,
       "paymentTrackingEnabled" = false, "paymentCollectionEnabled" = false,
       "featurePlayerPool" = false, "poolAutoAsk" = false, "partnerAskWhen" = 'off',
       "momChosenBy" = 'players', "adminChannelMode" = 'one-person', "adminChannelUserId" = NULL,
       "monthCreditRule" = 'any-miss', "monthListOpensDaysBefore" = 7, "listAnnouncer" = 'matchtime',
       "benchPickMode" = 'first-come', "benchPickFallback" = 'bench-offer',
       "quietHoursEnabled" = false, language = 'en', "setupStage" = 'live', "liveAt" = now() - interval '1 day',
       "featureBadgeAnnouncements" = true, "featureGearReminder" = false,
       "paymentHolderId" = $2
     WHERE id = $1`,
    [orgId, g.player("davide").userId],
  );
  await pool.db.run(
    `UPDATE "Activity" SET name = 'Football 7-a-side', "dayOfWeek" = $2, time = $3, venue = 'Sandbox Park School field',
       "deadlineHours" = 5, "ratingWindowHours" = 120, "matchDurationMins" = 60 WHERE id = $1`,
    [g.activityId, londonWeekday(kickoff), formatInTimeZone(kickoff, LONDON, "HH:mm")],
  );
  await pool.db.run(
    `UPDATE "Sport" SET name = 'Football 7-a-side', "playersPerTeam" = 7, "mvpLabel" = 'Man of the Match',
       "balancingStrategy" = 'position-aware', "positionComposition" = '{"GK": 1, "DEF": 2, "FWD": 2, "MID": 2}'::jsonb
     WHERE id = $1`,
    [g.sportId],
  );
  // The welcome went out when the club went live (production has the
  // `bot-intro` claim from that moment), so the scheduler's old intro
  // never fires here either.
  await pool.db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ($1, $2, 'bot-intro', now() - interval '1 day')`,
    [`sim-vets-intro-${orgId}`, `org-${orgId}:bot-intro`],
  );
  // The imported members have no name and no seed (the default 6 applies).
  const members = new Map(VETS_MEMBERS.map((m) => [m.key, m]));
  for (const m of VETS_MEMBERS) {
    const uid = g.player(m.key).userId;
    if (m.nameless) await pool.db.run(`UPDATE "User" SET name = NULL WHERE id = $1`, [uid]);
    await pool.db.run(`UPDATE "Membership" SET "seedRating" = $2 WHERE "userId" = $1 AND "orgId" = $3`, [uid, opts.seedRatings?.[m.key] ?? null, orgId]);
  }

  let monthId: string | null = null;
  if (opts.month === "running") monthId = await startRunningMonth(pool, club, kickoff);

  return {
    club,
    orgId,
    matchId: g.matchId!,
    kickoff,
    playedMatchId: g.completedMatchId,
    monthId,
    members,
    userId: (k) => g.player(k).userId,
    phone: (k) => g.player(k).phone!.replace(/^\+/, ""),
  };
}

/**
 * November, started part-way as Davide's YES started it on 3 Nov: running,
 * five Mondays, one played before the start, the thirteen on the list as
 * regulars in slots 1 to 13 (Nabz, Craig and Oumesh paid for 4).
 */
async function startRunningMonth(pool: PoolWorld, club: PoolClub, kickoff: Date): Promise<string> {
  const g = club.group;
  const monthId = `sim-vets-month-${nextMsgId()}`;
  const monthStart = `${formatInTimeZone(kickoff, LONDON, "yyyy-MM")}-01`;
  await pool.db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart",
                               "startedMidMonthAt", "startedByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', 5, 1, now() - interval '1 hour', $5, now() - interval '1 hour', now())`,
    [monthId, g.orgId, g.activityId, monthStart, g.player("davide").userId],
  );
  let slot = 0;
  for (const k of LIST_KEYS) {
    slot++;
    const four = ["nabz", "craig", "oumesh"].includes(k);
    await pool.db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "gamesCommitted", "paidAt", source, "joinedAt", "updatedAt")
       VALUES ($1, $2, $3, 'regular', $4, $5, $6, now(), 'seed-list', now() - interval '1 hour', now())`,
      [`${monthId}-${k}`, monthId, g.player(k).userId, slot, four ? 4 : 4, four ? 4 : null],
    );
  }
  return monthId;
}

// ── What people do ────────────────────────────────────────────────────

export interface Said {
  waMessageId: string;
  handledBy: string;
  intent: string | null;
  react: string | null;
  reply: string | null;
  sent: SentMessage[];
}

/** The Pi's authorName for a member: his name, else his pushname, else none. */
export function authorOf(v: VetsClub, key: string): { name: string | null; phone: string } {
  const m = v.members.get(key);
  if (!m) throw new Error(`vets: unknown member ${key}`);
  return { name: m.nameless ? (m.pushname ?? null) : m.name, phone: v.phone(key) };
}

/** ONE message in the players' group (a flush of one), through the real analyze route. */
export async function say(pool: PoolWorld, v: VetsClub, key: string, body: string, opts: { tag?: boolean; history?: SimHistoryEntry[] } = {}): Promise<Said> {
  const [r] = await sayBatch(pool, v, [{ key, body, tag: opts.tag }], { history: opts.history });
  return r;
}

/** A batch of group messages, as one flush of the Pi's buffer. */
export async function sayBatch(
  pool: PoolWorld,
  v: VetsClub,
  items: Array<{ key: string; body: string; tag?: boolean }>,
  opts: { history?: SimHistoryEntry[] } = {},
): Promise<Said[]> {
  for (const it of items) pool.log({ kind: "in", from: `${v.club.key}.${it.key}`, channel: "group", text: it.body });
  const r = await v.club.group.postBatch(
    items.map((it) => ({ body: it.body, author: authorOf(v, it.key), tag: it.tag })),
    { history: opts.history },
  );
  const out: Said[] = [];
  for (const res of r.results) {
    const reply = res.reply?.trim() ? res.reply : null;
    const sent = await pool.collect(reply ? { channel: "group", to: `${v.club.key}.group`, text: reply, orgId: v.orgId } : undefined);
    out.push({ ...res, reply, sent });
  }
  return out;
}

export interface Instruction {
  kind: string;
  key?: string;
  text?: string;
  phone?: string;
  targetUser?: string;
  matchId?: string;
}

/** The Pi's scheduler poll at `now` (claiming, as the Pi does). */
export async function schedulerPoll(pool: PoolWorld, v: VetsClub, now: Date, opts: { claim?: boolean } = {}): Promise<{ instructions: Instruction[]; sent: SentMessage[] }> {
  const res = await pool.request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(v.club.group.groupId)}`, {
    headers: { ...PI, "x-test-now": now.toISOString(), ...(opts.claim === false ? { "x-no-claim": "1" } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { instructions } = (await res.json()) as { instructions: Instruction[] };
  for (const i of instructions) {
    if (i.text) pool.note(`[scheduler ${formatInTimeZone(now, LONDON, "EEE d MMM HH:mm")}] ${i.kind}${i.key ? ` (${i.key})` : ""}${i.phone ? ` to ${i.phone}` : ""}: ${i.text}`);
  }
  return { instructions, sent: await pool.collect() };
}

// ── What it cost ──────────────────────────────────────────────────────

export interface MeterReading {
  calls: number;
  costUsd: number;
  truncated: number;
  byModel: Record<string, { calls: number; costUsd: number }>;
}

const meterUrl = () => (process.env.MT_E2E_LIVE_METER_PORT ? `http://127.0.0.1:${process.env.MT_E2E_LIVE_METER_PORT}` : null);

/** The live run's meter (e2e/replay/meter.ts); zeros on a stubbed run. */
export async function readMeter(): Promise<MeterReading> {
  const url = meterUrl();
  if (!url) return { calls: 0, costUsd: 0, truncated: 0, byModel: {} };
  for (let attempt = 1; ; attempt++) {
    try {
      return (await (await fetch(`${url}/__meter`, { headers: { connection: "close" } })).json()) as MeterReading;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** What the analyze route recorded for one message: owner, intent, reasoning, route. */
export async function analyzed(db: TestDb, waMessageId: string): Promise<Record<string, unknown> | null> {
  const row = await db.one<{ handledBy: string; intent: string | null; action: string | null; reasoning: string | null; pipelineTrace: unknown }>(
    `SELECT "handledBy", intent, action, reasoning, "pipelineTrace" FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
    [waMessageId],
  );
  if (!row) return null;
  const trace = JSON.stringify(row.pipelineTrace ?? null);
  return { ...row, pipelineTrace: trace.length > 1500 ? `${trace.slice(0, 1500)}…` : row.pipelineTrace };
}

/** Make the next router call carrying at least `minMessages` messages come back cut off at max_tokens. */
export async function armRouterCutOff(minMessages: number): Promise<boolean> {
  const url = meterUrl();
  if (!url) return false;
  const r = (await (
    await fetch(`${url}/__meter/truncate-next`, { method: "POST", body: JSON.stringify({ marker: "You are the front door of MatchTime", minMessages }) })
  ).json()) as { armed: boolean };
  return r.armed;
}
