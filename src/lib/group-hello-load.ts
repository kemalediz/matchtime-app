/**
 * THE DATABASE HALF OF THE SETTINGS-AWARE GROUP HELLO (2026-10-12, go-live
 * slice S2). One read of the club's settings and one of the organiser's
 * name, so the caller only does:
 *
 *   buildGroupHello(await loadHelloInput(orgId))
 *
 * The settings are read at the moment of the call, so a hello built at
 * go-live says what the club is set to then, not at approval.
 *
 * The organiser is the person who connected the club: the user on its
 * most recently linked `ClubConnect` (the same person `decideClub` names
 * in today's hello), else the club's OWNER. Pass `organiserUserId` when
 * the caller already knows who it is. No name is not an error: the hello
 * has a wording for it.
 *
 * `client` may be a transaction, so the hello can be built from the same
 * snapshot the caller writes in.
 *
 * A SQUAD TO CARRY (2026-10-13). For a rolling squad club the hello must
 * not say "if you played last time, you're in" when MatchTime has no last
 * time: a new club's first game has an empty list. So a rolling club gets
 * three more reads, through the same client, and `hasSquadToCarry` is the
 * seeding's own rule (`hasSquadToCarry`, rolling-squad-rules.ts): would
 * `seedDueRollingSquads` put a squad on the next game, and is it at least
 * half of that game's places (owner decision: one player who tapped In on
 * the website is not "the squad")? Every other club
 * gets `false` with no read; the builder only looks at it for a rolling
 * club.
 *
 * THE GAME DAY (2026-11-02). "help run the Monday games": the weekday of
 * the club's active weekly games when they all share one, else null
 * ("this group's games"). Read through the same client; a client without
 * the read, or a read that fails, gives null.
 *
 * THE POOL AND PARTNER CLUBS (2026-11-03, `loadHelloClubFacts`). Whether
 * the player pool is open for the club (the platform switch, the
 * `PlatformSetting` row "pool-offers" with the env override, AND the
 * club's `featurePlayerPool`: `poolOpenForClub`), whether it asks partner
 * clubs (an ACTIVE `ClubPartnership` with it as the asker: the pairing is
 * the switch, Kemal 2026-11-08), and whether a partner asks it (an ACTIVE
 * one with it as the partner). Facts from rows, never words. Any read
 * that is missing or fails reads as off: the hello then marks the line
 * optional, which is never a false promise.
 */
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { db } from "@/lib/db";
import {
  HELLO_ORG_SELECT,
  NO_HELLO_CLUB_FACTS,
  helloInputFromOrg,
  type GroupHelloInput,
  type HelloClubFacts,
  type HelloOrgRow,
} from "./group-hello";
import { poolOpenForClub, poolPlatformOpen } from "./pool/flags";
import { POOL_PLATFORM_KEY } from "./pool/platform-switch";
import {
  ROLLING_LOOKBACK_DAYS,
  carrySourcesAt,
  hasSquadToCarry,
  type FixtureMatch,
  type SeedSourceRow,
} from "./rolling-squad-rules";
import { loadAdminAddedUserIds, type AdminAddedReadClient } from "./admin-added";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

type CarryMatchRow = {
  id: string;
  date: Date;
  status: string;
  isHistorical: boolean;
  rollingSeededAt: Date | null;
  maxPlayers: number;
  activity: { orgId: string; venue: string; dayOfWeek: number };
};
type CarryAttendanceRow = {
  matchId: string;
  userId: string;
  status: string;
  position: number;
  user: { phoneNumber: string | null; email: string; isActive: boolean };
};
type CarryMembershipRow = { userId: string; leftAt: Date | null; provisionallyAddedAt: Date | null };

/** The part of the Prisma client (or of a transaction) this reads through. */
export interface HelloReadClient {
  organisation: { findUnique(args: { where: { id: string }; select: typeof HELLO_ORG_SELECT }): Promise<HelloOrgRow | null> };
  clubConnect: {
    findFirst(args: {
      where: { orgId: string; linkedAt: { not: null } };
      orderBy: { linkedAt: "desc" };
      select: { userId: true };
    }): Promise<{ userId: string } | null>;
  };
  membership: {
    findFirst(args: {
      where: { orgId: string; role: "OWNER"; leftAt: null; guestMatchId: null };
      orderBy: { id: "asc" };
      select: { userId: true };
    }): Promise<{ userId: string } | null>;
    findMany(args: {
      where: { orgId: string; userId: { in: string[] } };
      select: { userId: true; leftAt: true; provisionallyAddedAt: true };
    }): Promise<CarryMembershipRow[]>;
  };
  user: { findUnique(args: { where: { id: string }; select: { name: true } }): Promise<{ name: string | null } | null> };
  match: { findMany(args: object): Promise<CarryMatchRow[]> };
  attendance: { findMany(args: object): Promise<CarryAttendanceRow[]> };
  /** Read only when a carried player has no phone. Optional so a double
   *  without it reads as "no admin added anybody". */
  attendanceEvent?: AdminAddedReadClient["attendanceEvent"];
  /** The partner clubs. Optional: absent reads as none. */
  clubPartnership?: {
    count(args: { where: { askerOrgId: string; status: "active" } | { partnerOrgId: string; status: "active" } }): Promise<number>;
  };
  /** The pool's platform switch. Optional: absent reads as closed. */
  platformSetting?: {
    findUnique(args: { where: { key: string }; select: { on: true } }): Promise<{ on: boolean } | null>;
  };
  /** The game day. Optional: absent reads as no single day. */
  activity?: {
    findMany(args: {
      where: { orgId: string; isActive: true };
      select: { dayOfWeek: true };
    }): Promise<Array<{ dayOfWeek: number }>>;
  };
}

/** The club's one weekly game day (0 = Sunday), or null for several or none. */
export async function loadHelloGameDay(orgId: string, client: HelloReadClient): Promise<number | null> {
  if (!client.activity) return null;
  try {
    const rows = await client.activity.findMany({ where: { orgId, isActive: true }, select: { dayOfWeek: true } });
    const days = new Set(rows.map((r) => r.dayOfWeek));
    return days.size === 1 ? [...days][0] : null;
  } catch (err) {
    console.error(`[group-hello] game day for ${orgId} unread:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}

type Env = Record<string, string | undefined>;

/** The pool and partner facts the hello's lines are built from. */
export async function loadHelloClubFacts(
  orgId: string,
  row: Pick<HelloOrgRow, "featurePlayerPool">,
  client: HelloReadClient,
  env: Env = process.env,
): Promise<HelloClubFacts> {
  try {
    const [platform, asks, helps] = await Promise.all([
      client.platformSetting ? client.platformSetting.findUnique({ where: { key: POOL_PLATFORM_KEY }, select: { on: true } }) : null,
      client.clubPartnership ? client.clubPartnership.count({ where: { askerOrgId: orgId, status: "active" } }) : 0,
      client.clubPartnership ? client.clubPartnership.count({ where: { partnerOrgId: orgId, status: "active" } }) : 0,
    ]);
    return {
      pool: poolOpenForClub({ featurePlayerPool: row.featurePlayerPool === true }, poolPlatformOpen(platform?.on === true, env)),
      partnersAsk: asks > 0,
      partnersHelp: helps > 0,
    };
  } catch (err) {
    console.error(`[group-hello] club facts for ${orgId} unread:`, err instanceof Error ? err.message : "failed");
    return NO_HELLO_CLUB_FACTS;
  }
}

/**
 * The organiser the group hello names, as a full name, or null: the given
 * user, else the most recently linked club connect, else the club's first
 * OWNER. Also read by the monthly announcement (bot-scheduler.ts), so both
 * posts name the same person.
 */
export async function loadOrganiserName(
  orgId: string,
  opts: { organiserUserId?: string | null; client?: Pick<HelloReadClient, "clubConnect" | "membership" | "user"> } = {},
): Promise<string | null> {
  const client = opts.client ?? (db as unknown as HelloReadClient);
  let userId = opts.organiserUserId ?? null;
  if (!userId) {
    const link = await client.clubConnect.findFirst({
      where: { orgId, linkedAt: { not: null } },
      orderBy: { linkedAt: "desc" },
      select: { userId: true },
    });
    userId = link?.userId ?? null;
  }
  if (!userId) {
    const owner = await client.membership.findFirst({
      where: { orgId, role: "OWNER", leftAt: null, ...ORDINARY_MEMBER_WHERE },
      orderBy: { id: "asc" },
      select: { userId: true },
    });
    userId = owner?.userId ?? null;
  }
  const user = userId ? await client.user.findUnique({ where: { id: userId }, select: { name: true } }) : null;
  return user?.name ?? null;
}

/**
 * Would the rolling seeding put a SUBSTANTIAL squad on this club's next
 * game: at least half of its places (`Match.maxPlayers`)? The matches are
 * the ones `seedDueRollingSquads` reads (this club, not historical, live
 * or completed inside the lookback); the decision is `hasSquadToCarry`.
 * Reads players only for the matches that decision names, and only
 * CONFIRMED rows: nobody else is ever carried.
 */
export async function loadHasSquadToCarry(orgId: string, client: HelloReadClient, now: Date): Promise<boolean> {
  const lookbackStart = new Date(now.getTime() - (ROLLING_LOOKBACK_DAYS + 7) * DAY_MS);
  const matches: FixtureMatch[] = await client.match.findMany({
    where: {
      activity: { orgId },
      isHistorical: false,
      OR: [{ status: { in: LIVE_STATUSES } }, { status: "COMPLETED", date: { gte: lookbackStart } }],
    },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      rollingSeededAt: true,
      maxPlayers: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
    },
    orderBy: { date: "asc" },
  });
  const matchIds = [...new Set(carrySourcesAt(matches, now).map((c) => c.match.id))];
  if (matchIds.length === 0) return false;

  const attendance = await client.attendance.findMany({
    where: { matchId: { in: matchIds }, status: "CONFIRMED" },
    select: {
      matchId: true,
      userId: true,
      status: true,
      position: true,
      user: { select: { phoneNumber: true, email: true, isActive: true } },
    },
  });
  if (attendance.length === 0) return false;
  const memberships = await client.membership.findMany({
    where: { orgId, userId: { in: [...new Set(attendance.map((a) => a.userId))] } },
    select: { userId: true, leftAt: true, provisionallyAddedAt: true },
  });
  const membershipOf = new Map(memberships.map((m) => [m.userId, m]));
  // The seeding's own read: a phoneless player is carried only when an
  // admin added him (`admin-added.ts`).
  const phoneless = attendance.filter((a) => !a.user.phoneNumber).map((a) => a.userId);
  const adminAdded =
    phoneless.length > 0 && client.attendanceEvent
      ? await loadAdminAddedUserIds(client as AdminAddedReadClient, orgId, phoneless)
      : new Set<string>();
  const rows = new Map<string, SeedSourceRow[]>();
  for (const a of attendance) {
    const mem = membershipOf.get(a.userId);
    const list = rows.get(a.matchId) ?? [];
    list.push({
      userId: a.userId,
      status: a.status,
      position: a.position,
      phoneNumber: a.user.phoneNumber,
      email: a.user.email,
      isActive: a.user.isActive,
      membership: mem ? { leftAt: mem.leftAt, provisionallyAddedAt: mem.provisionallyAddedAt } : null,
      addedByAdmin: adminAdded.has(a.userId),
    });
    rows.set(a.matchId, list);
  }
  return hasSquadToCarry({ matches, rows, now });
}

export async function loadHelloInput(
  orgId: string,
  opts: { organiserUserId?: string | null; client?: HelloReadClient; now?: Date; env?: Env } = {},
): Promise<GroupHelloInput> {
  const client = opts.client ?? (db as unknown as HelloReadClient);
  const row = await client.organisation.findUnique({ where: { id: orgId }, select: HELLO_ORG_SELECT });
  if (!row) throw new Error(`loadHelloInput: organisation ${orgId} not found`);

  const input = helloInputFromOrg(row, await loadOrganiserName(orgId, { organiserUserId: opts.organiserUserId, client }));
  const gameDay = await loadHelloGameDay(orgId, client);
  const clubFacts = await loadHelloClubFacts(orgId, row, client, opts.env);
  const rolling = input.settings.attendance && input.settings.rollingSquad;
  return {
    ...input,
    gameDay,
    clubFacts,
    hasSquadToCarry: rolling ? await loadHasSquadToCarry(orgId, client, opts.now ?? new Date()) : false,
  };
}
