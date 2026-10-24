/**
 * ROLLING SQUAD, THE WRITE (2026-09-30).
 *
 * Slice 1 of MDs/friday-group-features-plan-2026-09-30.md, section 1.4.
 * The rules live in `rolling-squad-rules.ts` (pure); this module loads
 * the rows, runs them, and writes the result.
 *
 *   seedDueRollingSquads(now)   called by /api/cron/complete-matches
 *                               every 15 minutes, right after matches
 *                               are completed. Server side, so it does
 *                               not depend on the Pi being up.
 *   seedRollingSquad(...)       one target, one transaction. Also the
 *                               admin's "Carry over last squad" button.
 *
 * NOT through `registerAttendance`: this is a bulk write with its own
 * events, like the format-switch recut. Seeding runs after the source
 * completed, so it never meets `registerAttendance`'s "previous match
 * still in flight" guard.
 *
 * The bot's mute switch (`whatsappBotEnabled`) does NOT stop seeding,
 * for the same reason it does not stop fixture generation: an hour of
 * engineering must not cost a club its squad. Posts stay muted by it.
 */
import { db } from "./db";
import { servingClubWhere } from "./club-approval-state";
import { LIVE_STAGE_WHERE } from "./club-setup-rules";
import { formatLondon } from "./london-time";
import { recordAttendanceEvent } from "./attendance-events";
import { loadAdminAddedUserIds, type AdminAddedReadClient } from "./admin-added";
import { isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";
import {
  ROLLING_LOOKBACK_DAYS,
  applyCancelledWeeks,
  cancelledWeekIntents,
  decideSeed,
  pickSeedSource,
  pickSeedTarget,
  rollingSeedDue,
  rollingSeedDueAt,
  type CancelledWeek,
  type SeedSourceRow,
} from "./rolling-squad-rules";

export type SeedActor = { kind: "scheduler" } | { kind: "admin"; userId: string };

export interface SeedResult {
  /** False when the target was already seeded (someone else won the claim). */
  seeded: boolean;
  /** Rows written, CONFIRMED and BENCH together. */
  carried: number;
  /** Of those, the ones that overflowed onto the bench. */
  overflow: number;
}

const NOTHING: SeedResult = { seeded: false, carried: 0, overflow: 0 };

type AttendanceWithUser = {
  userId: string;
  status: string;
  position: number;
  user: { phoneNumber: string | null; email: string; isActive: boolean };
};

/** `SeedSourceRow`s for attendance rows of this club: membership and
 *  whether an admin added a phoneless player, read in bulk. */
async function describeRows(orgId: string, atts: AttendanceWithUser[]): Promise<SeedSourceRow[]> {
  if (atts.length === 0) return [];
  const memberships = await db.membership.findMany({
    where: { orgId, userId: { in: atts.map((a) => a.userId) } },
    select: { userId: true, leftAt: true, provisionallyAddedAt: true, guestFromOrgId: true, guestMatchId: true },
  });
  const membershipOf = new Map(memberships.map((m) => [m.userId, m]));
  // Only a phoneless player's carry depends on whether an admin added him.
  const phoneless = atts.filter((a) => a.status === "CONFIRMED" && !a.user.phoneNumber).map((a) => a.userId);
  const adminAdded =
    phoneless.length > 0
      ? await loadAdminAddedUserIds(db as unknown as AdminAddedReadClient, orgId, phoneless)
      : new Set<string>();
  return atts.map((a) => {
    const mem = membershipOf.get(a.userId);
    return {
      userId: a.userId,
      status: a.status,
      position: a.position,
      phoneNumber: a.user.phoneNumber,
      email: a.user.email,
      isActive: a.user.isActive,
      membership: mem
        ? { leftAt: mem.leftAt, provisionallyAddedAt: mem.provisionallyAddedAt, guestFromOrgId: mem.guestFromOrgId, guestMatchId: mem.guestMatchId }
        : null,
      addedByAdmin: adminAdded.has(a.userId),
    };
  });
}

/**
 * The rows the seed carries from, and who is left out for saying OUT for
 * a cancelled week (2026-10-24, `applyCancelledWeeks`). The cancelled
 * weeks are the CANCELLED, non-historical matches of the same fixture
 * strictly between the source and the target.
 */
async function loadCarryRows(args: {
  orgId: string;
  fixture: RecurringFixtureKey;
  target: { id: string; date: Date };
  source: { id: string; date: Date };
}): Promise<{ rows: SeedSourceRow[]; leftOut: string[] }> {
  const { orgId, target, source } = args;
  const sourceAtt = await db.attendance.findMany({
    where: { matchId: source.id },
    include: { user: { select: { id: true, phoneNumber: true, email: true, isActive: true } } },
  });
  const sourceRows = await describeRows(orgId, sourceAtt);

  const between = await db.match.findMany({
    where: {
      activity: { orgId },
      status: "CANCELLED",
      isHistorical: false,
      date: { gt: source.date, lt: target.date },
    },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      updatedAt: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
    },
  });
  const cancelled = between.filter(
    (m) =>
      m.status === "CANCELLED" &&
      !m.isHistorical &&
      m.date.getTime() > source.date.getTime() &&
      m.date.getTime() < target.date.getTime() &&
      isSameRecurringFixture(m.activity, { ...args.fixture, orgId }),
  );
  if (cancelled.length === 0) return { rows: sourceRows, leftOut: [] };

  const events = await db.attendanceEvent.findMany({
    where: { matchId: { in: cancelled.map((m) => m.id) } },
    select: { matchId: true, userId: true, fromStatus: true, toStatus: true, cause: true, at: true, toPosition: true },
  });
  const weeks: CancelledWeek[] = cancelled.map((m) => ({
    date: m.date,
    cancelledAt: m.updatedAt,
    events: events.filter((e) => e.matchId === m.id),
  }));
  const intents = cancelledWeekIntents(weeks);
  const saidIn = [...intents].filter(([, i]) => i.intent === "in").map(([u]) => u);
  const inAtt =
    saidIn.length > 0
      ? await db.attendance.findMany({
          where: { matchId: { in: cancelled.map((m) => m.id) }, userId: { in: saidIn } },
          include: { user: { select: { id: true, phoneNumber: true, email: true, isActive: true } } },
        })
      : [];
  // One description per player; CONFIRMED so a phoneless one is checked
  // for an admin's add like any carried player.
  const seen = new Set<string>();
  const unique = inAtt.filter((a) => (seen.has(a.userId) ? false : (seen.add(a.userId), true)));
  const cancelledWeekRows = await describeRows(
    orgId,
    unique.map((a) => ({ ...a, status: "CONFIRMED" })),
  );
  return applyCancelledWeeks({ sourceRows, weeks, cancelledWeekRows });
}

/**
 * WHO WAS LEFT OUT OF `matchId`'s CARRIED SQUAD FOR SAYING OUT FOR A
 * CANCELLED WEEK (2026-10-24, Kemal): "MT should mention who is excluded
 * from this week's squad due to changing their minds and telling OUT".
 * Read by the rolling announcement (players' group, or the organisers'
 * notice in HQ). Recomputed from the same history the seed read, which
 * no longer changes. A player who has since said IN or gone on the bench
 * for this match is not named: he is on the list.
 *
 * Empty when the match was not seeded, or nobody was left out.
 */
export async function loadRollingLeftOut(matchId: string): Promise<Array<{ userId: string; name: string | null }>> {
  const target = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      rollingSeededFromMatchId: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
    },
  });
  if (!target?.rollingSeededFromMatchId) return [];
  const source = await db.match.findUnique({ where: { id: target.rollingSeededFromMatchId }, select: { id: true, date: true } });
  if (!source) return [];
  const { leftOut } = await loadCarryRows({ orgId: target.activity.orgId, fixture: target.activity, target, source });
  if (leftOut.length === 0) return [];
  const [onTarget, users] = await Promise.all([
    db.attendance.findMany({
      where: { matchId, userId: { in: leftOut }, status: { in: ["CONFIRMED", "BENCH"] } },
      select: { userId: true },
    }),
    db.user.findMany({ where: { id: { in: leftOut } }, select: { id: true, name: true } }),
  ]);
  const listed = new Set(onTarget.map((a) => a.userId));
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return leftOut.filter((u) => !listed.has(u)).map((u) => ({ userId: u, name: nameOf.get(u) ?? null }));
}

/**
 * Copy `sourceId`'s squad onto `targetId`, once.
 *
 * One transaction:
 *   1. claim: set `rollingSeededAt` WHERE it is NULL; zero rows means the
 *      match was seeded already, so stop;
 *   2. read the target's rows and run `decideSeed`;
 *   3. write the rows after the target's existing positions;
 *   4. one `rolling-squad` AttendanceEvent per row, same transaction;
 *   5. when the seed fills the squad, write the `<matchId>:squad-locked`
 *      claim. `announceSquadFullIfJustFilled` is deliberately NOT called:
 *      its "Squad complete" post would land at 08:00, before the rolling
 *      announcement, which carries the full roster anyway. A later drop
 *      clears the claim (`cancelAttendance`) and a refill announces.
 */
export async function seedRollingSquad(args: {
  targetId: string;
  sourceId: string;
  actor: SeedActor;
  now?: Date;
}): Promise<SeedResult> {
  const now = args.now ?? new Date();
  const [target, source] = await Promise.all([
    db.match.findUnique({
      where: { id: args.targetId },
      include: { activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
    }),
    db.match.findUnique({ where: { id: args.sourceId }, select: { id: true, date: true } }),
  ]);
  if (!target || !source) return NOTHING;
  const orgId = target.activity.orgId;

  // History: the source's rows, and the cancelled weeks in between, are
  // not changing any more, so they are read outside the transaction.
  const { rows: sourceRows } = await loadCarryRows({ orgId, fixture: target.activity, target, source });
  const sourceLabel = formatLondon(source.date, "yyyy-MM-dd");

  return db.$transaction(async (tx) => {
    const claim = await tx.match.updateMany({
      where: { id: target.id, rollingSeededAt: null },
      data: { rollingSeededAt: now, rollingSeededFromMatchId: source.id },
    });
    if (claim.count === 0) return NOTHING;

    const targetRows = await tx.attendance.findMany({ where: { matchId: target.id } });
    const decisions = decideSeed({ sourceRows, targetRows, maxPlayers: target.maxPlayers });
    if (decisions.length === 0) return { seeded: true, carried: 0, overflow: 0 };

    let position = targetRows.reduce((max, r) => Math.max(max, r.position), 0);
    const rows = decisions.map((d) => ({
      matchId: target.id,
      userId: d.userId,
      status: d.status,
      position: ++position,
      respondedAt: now,
    }));
    await tx.attendance.createMany({ data: rows });

    for (let i = 0; i < rows.length; i++) {
      await recordAttendanceEvent(
        tx,
        {
          matchId: target.id,
          userId: rows[i].userId,
          orgId,
          fromStatus: null,
          toStatus: rows[i].status,
          fromPosition: null,
          toPosition: rows[i].position,
        },
        {
          cause: "rolling-squad",
          actorKind: args.actor.kind,
          actorUserId: args.actor.kind === "admin" ? args.actor.userId : null,
          sourceRef: source.id,
          note: `${decisions[i].note} from ${sourceLabel}`,
        },
      );
    }

    const confirmedAfter =
      targetRows.filter((r) => r.status === "CONFIRMED").length +
      decisions.filter((d) => d.status === "CONFIRMED").length;
    if (confirmedAfter >= target.maxPlayers) {
      const key = `${target.id}:squad-locked`;
      await tx.sentNotification.upsert({
        where: { key },
        create: { key, matchId: target.id, kind: "group-message" },
        update: {},
      });
    }

    return {
      seeded: true,
      carried: decisions.length,
      overflow: decisions.filter((d) => d.status === "BENCH").length,
    };
  });
}

type FixtureRow = {
  id: string;
  date: Date;
  status: string;
  isHistorical: boolean;
  rollingSeededAt: Date | null;
  activityId: string;
  activity: RecurringFixtureKey & { matchDurationMins: number };
};

/**
 * Every rolling club's due seeds (plan 1.4). For each fixture of each
 * approved, non-dormant club with the setting on: the soonest live match
 * (`pickSeedTarget`) is seeded from last week's played match
 * (`pickSeedSource`) once the first 08:00 London after that match's end
 * has passed.
 */
export async function seedDueRollingSquads(now: Date = new Date()): Promise<{ seeded: number }> {
  const orgs = await db.organisation.findMany({
    // Not a club that is approved but still setting up (PR #234 review,
    // fix 4): nothing is carried over, and no once-key is claimed, for a
    // group MatchTime has not spoken in yet. The first run after go-live
    // seeds it. Every club that was never held is in the live stage, so
    // for them this is the same selection as before.
    where: { ...servingClubWhere(), ...LIVE_STAGE_WHERE, rollingSquadEnabled: true, dormantAt: null },
    select: { id: true },
  });

  let seeded = 0;
  for (const org of orgs) {
    const lookbackStart = new Date(now.getTime() - (ROLLING_LOOKBACK_DAYS + 7) * 24 * 60 * 60 * 1000);
    const matches: FixtureRow[] = await db.match.findMany({
      where: {
        activity: { orgId: org.id },
        isHistorical: false,
        OR: [
          { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
          { status: "COMPLETED", date: { gte: lookbackStart } },
        ],
      },
      select: {
        id: true,
        date: true,
        status: true,
        isHistorical: true,
        rollingSeededAt: true,
        activityId: true,
        activity: { select: { orgId: true, venue: true, dayOfWeek: true, matchDurationMins: true } },
      },
      orderBy: { date: "asc" },
    });

    // One pass per fixture, not per activity: a format switch re-points a
    // match to the other activity of the same weekly game.
    const fixtures: RecurringFixtureKey[] = [];
    for (const m of matches) {
      if (!fixtures.some((f) => isSameRecurringFixture(f, m.activity))) fixtures.push(m.activity);
    }

    for (const fixture of fixtures) {
      const target = pickSeedTarget(matches, fixture, now);
      if (!target) continue;
      const source = pickSeedSource(target, matches);
      if (!source) continue;
      const sourceEnd = new Date(source.date.getTime() + source.activity.matchDurationMins * 60 * 1000);
      if (!rollingSeedDue(sourceEnd, now)) continue;
      try {
        const res = await seedRollingSquad({
          targetId: target.id,
          sourceId: source.id,
          actor: { kind: "scheduler" },
          now,
        });
        if (res.seeded) {
          seeded++;
          console.log(
            `[rolling-squad] seeded ${target.id} from ${source.id}: ${res.carried} carried, ${res.overflow} to the waiting list`,
          );
        }
      } catch (err) {
        // One club's failure must not stop the others; the claim rolled
        // back with the transaction, so the next tick retries.
        console.error(`[rolling-squad] seeding ${target.id} from ${source.id} failed:`, err);
      }
    }
  }
  return { seeded };
}

/**
 * For the admin's "Carry over last squad" button: the match this one
 * would be seeded from, with NO lookback limit (a summer break is
 * exactly when an admin reaches for the button). Null when there is
 * nothing to carry, or the button does not apply.
 */
export async function findCarryOverSource(
  targetId: string,
): Promise<{ id: string; date: Date } | null> {
  const target = await db.match.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      rollingSeededAt: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
      _count: { select: { attendances: true } },
    },
  });
  if (!target || target.isHistorical || target.rollingSeededAt) return null;
  if (!["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(target.status)) return null;
  // Only onto an empty match: the button builds a squad, it never merges
  // into one people have already answered for.
  if (target._count.attendances > 0) return null;
  const completed = await db.match.findMany({
    where: { activity: { orgId: target.activity.orgId }, status: "COMPLETED", isHistorical: false, date: { lt: target.date } },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
    },
    orderBy: { date: "desc" },
    take: 50,
  });
  const source = pickSeedSource(target, completed, { lookbackDays: Infinity });
  return source ? { id: source.id, date: source.date } : null;
}

/**
 * WHEN THE SQUAD OF `matchId` IS STILL TO BE CARRIED OVER (2026-10-17):
 * the time it is due, else null.
 *
 * Pending means: the club has the rolling squad, the match is not seeded
 * yet, last week's played match is there to carry from (`pickSeedSource`,
 * the scheduler's own rule), and the 08:00 carry-over (`rollingSeedDueAt`)
 * has not come yet. Past that time the scheduler seeds within 15 minutes
 * and the list is MatchTime's to change again, so it is not pending.
 *
 * Read by the admin group (`admin-group-squad-change.ts`): FNF's
 * organisers talk about next week the night of a game, before its list is
 * set (2026-10-16, "Imti Rafi AH back"), and nothing they say then is
 * applied to it.
 */
export async function rollingSeedPendingAt(matchId: string, now: Date): Promise<Date | null> {
  const target = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      rollingSeededAt: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true, org: { select: { rollingSquadEnabled: true } } } },
    },
  });
  if (!target || target.rollingSeededAt || target.activity.org?.rollingSquadEnabled !== true) return null;
  const lookbackStart = new Date(target.date.getTime() - ROLLING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const completed = await db.match.findMany({
    where: { activity: { orgId: target.activity.orgId }, status: "COMPLETED", isHistorical: false, date: { gte: lookbackStart, lt: target.date } },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true, matchDurationMins: true } },
    },
  });
  const source = pickSeedSource(target, completed);
  if (!source) return null;
  const due = rollingSeedDueAt(new Date(source.date.getTime() + source.activity.matchDurationMins * 60 * 1000));
  return now.getTime() < due.getTime() ? due : null;
}
