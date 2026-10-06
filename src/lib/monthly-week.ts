/**
 * Monthly squad, slice 5: the weekly flow, the database side (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, section 5.
 *
 * For a club on `squadMode = "monthly"` with a RUNNING month:
 *
 *   loadMonthlyWeek(matchId)        this week's match as the month sees it
 *                                   (members, rows), or null when the club
 *                                   is weekly or the match has no running
 *                                   month. Every caller's first question.
 *   seedDueMonthlySquads(now)       put the month's regulars onto each
 *                                   fixture's next match, once: right after
 *                                   a mid-month start, then at 08:00 London
 *                                   the morning after each game. Called by
 *                                   /api/cron/complete-matches (so it does
 *                                   not depend on the Pi), by the due-posts
 *                                   poll, and by the start-month action.
 *   afterMonthlyAttendanceChange()  called from the attendance write path
 *                                   for a monthly club only: the slot a
 *                                   fill-in takes, then `syncMonthlyWeek`.
 *   syncMonthlyWeek(matchId)        idempotent: regulars' rows carry
 *                                   `paymentMethod = "monthly"`, and the
 *                                   "missed" credits match who is out.
 *   openPaygPoolOffer()             a place opened and nobody is waiting:
 *                                   one `BenchSlotOffer` for the PAYG pool.
 *
 * The rules are pure and live in `monthly-week-rules.ts`. Nothing here
 * calls a model or posts: posts are computed by `bot-scheduler.ts`.
 * A club on "weekly" (Sutton FC and every club before this) is refused by
 * `loadMonthlyWeek` before anything is written.
 */
import { db } from "./db";
import { recordAttendanceEvent } from "./attendance-events";
import { isClubOperational, servingClubWhere } from "./club-approval-state";
import { isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";
import { ROLLING_LOOKBACK_DAYS, pickSeedSource, rollingSeedDue } from "./rolling-squad-rules";
import { buildWeekListPost } from "./monthly-week-copy";
import { londonMonthStart, normaliseCreditRule, normaliseSquadMode, type MonthCreditRule } from "./squad-month-rules";
import {
  buildWeekList,
  decideMissedCredits,
  decideMonthlySeed,
  decideSlotFor,
  paygPoolOfferAllowed,
  selectPaygPool,
  weekListHash,
  type PoolCandidate,
  type WeekMember,
  type WeekRow,
  type WeekStatus,
} from "./monthly-week-rules";

/** `Attendance.paymentMethod` for a regular's weekly row: the month paid
 *  for it, so every per-match payment path skips it (plan 5.6). */
export const MONTHLY_PAYMENT_METHOD = "monthly";

/** True for a row the month paid for. The one test every per-match
 *  payment path uses; false for every row of a weekly club. */
export function isMonthlyRow(a: { paymentMethod?: string | null }): boolean {
  return a.paymentMethod === MONTHLY_PAYMENT_METHOD;
}

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** "Anyone who played PAYG in the last three months" (plan 5.3). */
const PAYG_POOL_LOOKBACK_DAYS = 92;

// ── Loading ────────────────────────────────────────────────────────────

/** A running month with its members, as loaded for one club. */
export interface RunningMonth {
  id: string;
  /** "2026-10-01". */
  monthStart: string;
  createdAt: Date;
  fixture: RecurringFixtureKey;
  members: Array<{
    userId: string;
    name: string;
    kind: "regular" | "payg";
    slot: number | null;
    paid: "none" | "claimed" | "confirmed";
    absentMatchIds: string[];
    paygMatchIds: string[];
  }>;
}

/** Every RUNNING month of a club, members included. Read only. */
export async function loadRunningMonths(orgId: string): Promise<RunningMonth[]> {
  const months = await db.squadMonth.findMany({
    where: { orgId, status: "running" },
    select: {
      id: true,
      monthStart: true,
      createdAt: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
      members: {
        where: { leftAt: null },
        orderBy: [{ slot: "asc" }, { createdAt: "asc" }],
        select: {
          userId: true,
          kind: true,
          slot: true,
          paidAt: true,
          paidClaimedAt: true,
          absentMatchIds: true,
          paygMatchIds: true,
          user: { select: { name: true } },
        },
      },
    },
  });
  return months.map((m) => ({
    id: m.id,
    monthStart: m.monthStart.toISOString().slice(0, 10),
    createdAt: m.createdAt,
    fixture: m.activity,
    members: m.members.map((r) => ({
      userId: r.userId,
      name: r.user.name ?? "",
      kind: r.kind === "payg" ? "payg" : "regular",
      slot: r.slot,
      paid: r.paidAt ? "confirmed" : r.paidClaimedAt ? "claimed" : "none",
      absentMatchIds: r.absentMatchIds,
      paygMatchIds: r.paygMatchIds,
    })),
  }));
}

/** The running month a match belongs to: the same weekly fixture (not the
 *  same Activity: a format switch re-points a match), and the London
 *  month the match is played in. */
export function monthForMatch(
  months: RunningMonth[],
  match: { date: Date; activity: RecurringFixtureKey },
): RunningMonth | null {
  const monthStart = londonMonthStart(match.date);
  return months.find((m) => m.monthStart === monthStart && isSameRecurringFixture(m.fixture, match.activity)) ?? null;
}

/** A month's members as one match sees them. */
export function weekMembers(month: RunningMonth, matchId: string): WeekMember[] {
  return month.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    kind: m.kind,
    slot: m.slot,
    paid: m.paid,
    absent: m.absentMatchIds.includes(matchId),
    paygDated: m.paygMatchIds.includes(matchId),
  }));
}

export interface MonthlyWeek {
  matchId: string;
  orgId: string;
  monthId: string;
  monthCreatedAt: Date;
  matchDate: Date;
  matchStatus: string;
  /** The month's regulars have been put onto this match. */
  seeded: boolean;
  maxPlayers: number;
  activityName: string;
  creditRule: MonthCreditRule;
  paygPricePence: number | null;
  pickMode: string | null;
  language: string | null;
  teamsOut: boolean;
  members: WeekMember[];
  rows: WeekRow[];
}

/**
 * This week's match as the month sees it. NULL when the club is on
 * "weekly", or the match has no running month: the caller then does
 * exactly what it did before monthly mode existed.
 */
export async function loadMonthlyWeek(matchId: string): Promise<MonthlyWeek | null> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      maxPlayers: true,
      rollingSeededAt: true,
      activity: {
        select: {
          orgId: true,
          name: true,
          venue: true,
          dayOfWeek: true,
          org: {
            select: { squadMode: true, monthCreditRule: true, paygPricePence: true, benchPickMode: true, language: true },
          },
        },
      },
      attendances: { select: { userId: true, status: true, position: true, user: { select: { name: true } } } },
      _count: { select: { teamAssignments: true } },
    },
  });
  if (!match || normaliseSquadMode(match.activity.org.squadMode) !== "monthly") return null;
  const month = monthForMatch(await loadRunningMonths(match.activity.orgId), match);
  if (!month) return null;
  return {
    matchId: match.id,
    orgId: match.activity.orgId,
    monthId: month.id,
    monthCreatedAt: month.createdAt,
    matchDate: match.date,
    matchStatus: match.status,
    seeded: match.rollingSeededAt != null && match.rollingSeededAt.getTime() >= month.createdAt.getTime(),
    maxPlayers: match.maxPlayers,
    activityName: match.activity.name,
    creditRule: normaliseCreditRule(match.activity.org.monthCreditRule),
    paygPricePence: match.activity.org.paygPricePence,
    pickMode: match.activity.org.benchPickMode,
    language: match.activity.org.language,
    teamsOut: match._count.teamAssignments > 0,
    members: weekMembers(month, match.id),
    rows: match.attendances.map((a) => ({
      userId: a.userId,
      name: a.user.name ?? "",
      status: a.status as WeekStatus,
      position: a.position,
    })),
  };
}

// ── Seeding (plan 5.1) ─────────────────────────────────────────────────

export type MonthlySeedActor = { kind: "scheduler" } | { kind: "admin"; userId: string };

/**
 * Put the month's regulars (and this date's PAYG players) onto one match,
 * once. One transaction:
 *   1. claim `rollingSeededAt` (the rolling squad's own claim, which
 *      monthly mode replaces). A match the ROLLING squad seeded before the
 *      month existed is claimed again, so a club that switches mid-week
 *      still gets its regulars; a match the month already seeded is not;
 *   2. `decideMonthlySeed` against the rows already there (an early OUT
 *      stays OUT);
 *   3. the rows, each with a `monthly-squad` AttendanceEvent.
 * Members who have left the group or been deactivated are not seeded.
 */
export async function seedMonthlySquad(args: {
  matchId: string;
  actor: MonthlySeedActor;
  now?: Date;
}): Promise<{ seeded: boolean; written: number }> {
  const now = args.now ?? new Date();
  const week = await loadMonthlyWeek(args.matchId);
  if (!week) return { seeded: false, written: 0 };

  const memberships = await db.membership.findMany({
    where: { orgId: week.orgId, userId: { in: week.members.map((m) => m.userId) }, leftAt: null, user: { isActive: true } },
    select: { userId: true },
  });
  const here = new Set(memberships.map((m) => m.userId));
  const members = week.members.filter((m) => here.has(m.userId));

  return db.$transaction(async (tx) => {
    const claim = await tx.match.updateMany({
      where: {
        id: week.matchId,
        OR: [{ rollingSeededAt: null }, { rollingSeededAt: { lt: week.monthCreatedAt } }],
      },
      data: { rollingSeededAt: now, rollingSeededFromMatchId: null },
    });
    if (claim.count === 0) return { seeded: false, written: 0 };

    const targetRows = await tx.attendance.findMany({
      where: { matchId: week.matchId },
      select: { userId: true, status: true },
    });
    const { write, markMonthly } = decideMonthlySeed({ members, targetRows, maxPlayers: week.maxPlayers });
    if (write.length > 0) {
      await tx.attendance.createMany({
        data: write.map((w) => ({
          matchId: week.matchId,
          userId: w.userId,
          status: w.status,
          position: w.position,
          respondedAt: now,
          ...(w.monthly ? { paymentMethod: MONTHLY_PAYMENT_METHOD } : {}),
        })),
      });
      for (const w of write) {
        await recordAttendanceEvent(
          tx,
          {
            matchId: week.matchId,
            userId: w.userId,
            orgId: week.orgId,
            fromStatus: null,
            toStatus: w.status,
            fromPosition: null,
            toPosition: w.position,
          },
          {
            cause: "monthly-squad",
            actorKind: args.actor.kind,
            actorUserId: args.actor.kind === "admin" ? args.actor.userId : null,
            sourceRef: week.monthId,
            note: w.note,
          },
        );
      }
    }
    if (markMonthly.length > 0) {
      await tx.attendance.updateMany({
        where: { matchId: week.matchId, userId: { in: markMonthly }, paymentMethod: null, paidAt: null },
        data: { paymentMethod: MONTHLY_PAYMENT_METHOD },
      });
    }
    return { seeded: true, written: write.length };
  });
}

/**
 * Every monthly club's due seeds. For each running month: the SOONEST live
 * match of its fixture, when that match is in the month, has not kicked
 * off and the month has not seeded it yet, is seeded
 *   - at once when the fixture has no played match behind it (a club that
 *     starts part-way through a month, plan 4.5);
 *   - otherwise from the first 08:00 London after the previous match
 *     ended, the rolling squad's hour, so the admins keep the night to
 *     take a no-show off first.
 * Only approved, non-dormant, non-paused clubs. The mute switch does not
 * stop seeding (posts stay muted by it), exactly like the rolling squad.
 */
export async function seedDueMonthlySquads(now: Date = new Date(), onlyOrgId?: string): Promise<{ seeded: number }> {
  const orgs = await db.organisation.findMany({
    where: { ...servingClubWhere(), squadMode: "monthly", dormantAt: null, ...(onlyOrgId ? { id: onlyOrgId } : {}) },
    select: { id: true },
  });
  let seeded = 0;
  for (const org of orgs) {
    const months = await loadRunningMonths(org.id);
    if (months.length === 0) continue;
    const lookbackStart = new Date(now.getTime() - (ROLLING_LOOKBACK_DAYS + 7) * DAY_MS);
    const matches = await db.match.findMany({
      where: {
        activity: { orgId: org.id },
        isHistorical: false,
        OR: [{ status: { in: [...LIVE] } }, { status: "COMPLETED", date: { gte: lookbackStart } }],
      },
      select: {
        id: true,
        date: true,
        status: true,
        isHistorical: true,
        rollingSeededAt: true,
        activity: { select: { orgId: true, venue: true, dayOfWeek: true, matchDurationMins: true } },
      },
      orderBy: { date: "asc" },
    });

    for (const month of months) {
      const target = matches.find(
        (m) => (LIVE as readonly string[]).includes(m.status) && isSameRecurringFixture(m.activity, month.fixture),
      );
      if (!target || target.date.getTime() <= now.getTime()) continue;
      if (londonMonthStart(target.date) !== month.monthStart) continue;
      if (target.rollingSeededAt && target.rollingSeededAt.getTime() >= month.createdAt.getTime()) continue;
      const source = pickSeedSource(target, matches);
      if (source) {
        const sourceEnd = new Date(source.date.getTime() + source.activity.matchDurationMins * 60 * 1000);
        if (!rollingSeedDue(sourceEnd, now)) continue;
      }
      try {
        const res = await seedMonthlySquad({ matchId: target.id, actor: { kind: "scheduler" }, now });
        if (res.seeded) {
          seeded++;
          console.log(`[monthly-week] seeded ${target.id} from month ${month.id}: ${res.written} written`);
        }
      } catch (err) {
        // One club's failure must not stop the others; the claim rolled
        // back with the transaction, so the next tick retries.
        console.error(`[monthly-week] seeding ${target.id} from month ${month.id} failed:`, err);
      }
    }
  }
  return { seeded };
}

// ── After an attendance change ─────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** One writer at a time per match for slots and credits. */
async function lockWeek(tx: Tx, matchId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monthly-week:${matchId}`}))`;
}

/**
 * Somebody has just become CONFIRMED on a monthly match: give them their
 * slot number (plan 5.3). A regular takes their own; a fill-in takes the
 * lowest free one, which is the slot a regular vacated, and the offer that
 * was open for that slot is closed as claimed by them.
 * `Attendance.position` is the slot. Written with its AttendanceEvent in
 * one transaction.
 */
export async function takeMonthlySlot(matchId: string, userId: string): Promise<{ slot: number } | null> {
  const week = await loadMonthlyWeek(matchId);
  if (!week) return null;
  return db.$transaction(async (tx) => {
    await lockWeek(tx, matchId);
    const fresh = await tx.attendance.findMany({
      where: { matchId },
      select: { id: true, userId: true, status: true, position: true },
    });
    const nameOf = new Map(week.rows.map((r) => [r.userId, r.name]));
    const rows: WeekRow[] = fresh.map((a) => ({
      userId: a.userId,
      name: nameOf.get(a.userId) ?? "",
      status: a.status as WeekStatus,
      position: a.position,
    }));
    const decision = decideSlotFor({ members: week.members, rows, maxPlayers: week.maxPlayers, userId });
    if (!decision) return null;
    const mine = fresh.find((a) => a.userId === userId)!;
    if (mine.position !== decision.slot) {
      await tx.attendance.update({ where: { id: mine.id }, data: { position: decision.slot } });
      await recordAttendanceEvent(
        tx,
        {
          matchId,
          userId,
          orgId: week.orgId,
          fromStatus: "CONFIRMED",
          toStatus: "CONFIRMED",
          fromPosition: mine.position,
          toPosition: decision.slot,
        },
        {
          cause: "monthly-squad",
          actorKind: "system",
          sourceRef: week.monthId,
          note: decision.vacatedByUserId
            ? `took slot ${decision.slot}, vacated by ${decision.vacatedByUserId}`
            : `took slot ${decision.slot}`,
        },
      );
    }
    if (decision.vacatedByUserId) {
      await tx.benchSlotOffer.updateMany({
        where: { matchId, replacingUserId: decision.vacatedByUserId, resolvedAt: null },
        data: { resolvedAt: new Date(), claimedByUserId: userId, outcome: "claimed" },
      });
    }
    return { slot: decision.slot };
  });
}

/**
 * Bring a monthly match's bookkeeping in line with who is in and out.
 * Idempotent, so it runs after every attendance change and on every poll:
 *   - every regular's row carries `paymentMethod = "monthly"` (a row that
 *     has a payment of its own is left alone);
 *   - the "missed" credits are exactly the ones `decideMissedCredits` says
 *     (the club's rule, D2). A credit is one game, valued at the month it
 *     is used in.
 * A cancelled match is left alone: its credits are slice 6's.
 */
export async function syncMonthlyWeek(matchId: string, now: Date = new Date()): Promise<{ created: number; voided: number }> {
  const week = await loadMonthlyWeek(matchId);
  if (!week || week.matchStatus === "CANCELLED") return { created: 0, voided: 0 };

  const regularIds = week.members.filter((m) => m.kind === "regular").map((m) => m.userId);
  if (regularIds.length > 0) {
    await db.attendance.updateMany({
      where: { matchId, userId: { in: regularIds }, paymentMethod: null, paidAt: null },
      data: { paymentMethod: MONTHLY_PAYMENT_METHOD },
    });
  }

  return db.$transaction(async (tx) => {
    await lockWeek(tx, matchId);
    const [fresh, existing] = await Promise.all([
      tx.attendance.findMany({ where: { matchId }, select: { userId: true, status: true, position: true } }),
      tx.squadCredit.findMany({
        where: { orgId: week.orgId, earnedMatchId: matchId, reason: "missed" },
        select: { id: true, userId: true, voidedAt: true, voidedById: true, appliedMonthId: true, createdById: true },
      }),
    ]);
    const rows: WeekRow[] = fresh.map((a) => ({ userId: a.userId, name: "", status: a.status as WeekStatus, position: a.position }));
    const { create, voidIds } = decideMissedCredits({
      rule: week.creditRule,
      members: week.members,
      rows,
      maxPlayers: week.maxPlayers,
      existing,
    });
    if (create.length > 0) {
      await tx.squadCredit.createMany({
        data: create.map((userId) => ({
          orgId: week.orgId,
          userId,
          games: 1,
          reason: "missed",
          earnedMonthId: week.monthId,
          earnedMatchId: matchId,
        })),
      });
    }
    if (voidIds.length > 0) {
      await tx.squadCredit.updateMany({ where: { id: { in: voidIds }, voidedAt: null }, data: { voidedAt: now } });
    }
    return { created: create.length, voided: voidIds.length };
  });
}

/**
 * The attendance write path's one call into monthly mode, made ONLY for a
 * club on "monthly" (the caller checks the column it already loaded).
 * Never throws: a failure here must not undo or hide an attendance change.
 */
export async function afterMonthlyAttendanceChange(matchId: string, userId: string, becameConfirmed: boolean): Promise<void> {
  try {
    if (becameConfirmed) await takeMonthlySlot(matchId, userId);
    await syncMonthlyWeek(matchId);
  } catch (err) {
    console.error(`[monthly-week] bookkeeping after a change on ${matchId} failed (the poll retries):`, err);
  }
}

// ── The PAYG pool (plan 5.3) ───────────────────────────────────────────

/**
 * Who is asked when a place opens and nobody is waiting: this month's
 * PAYG players first, then anyone who played per game for this club in the
 * last three months. `selectPaygPool` applies the exclusions.
 */
export async function loadPaygPool(
  week: Pick<MonthlyWeek, "orgId" | "members" | "rows">,
  now: Date = new Date(),
): Promise<PoolCandidate[]> {
  const monthPayg = week.members.filter((m) => m.kind === "payg").map((m) => m.userId);
  const recent = await db.attendance.findMany({
    where: {
      status: "CONFIRMED",
      OR: [{ paymentMethod: null }, { paymentMethod: { not: MONTHLY_PAYMENT_METHOD } }],
      match: {
        activity: { orgId: week.orgId },
        status: "COMPLETED",
        isHistorical: false,
        date: { gte: new Date(now.getTime() - PAYG_POOL_LOOKBACK_DAYS * DAY_MS) },
      },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  const ids = [...new Set([...monthPayg, ...recent.map((r) => r.userId)])];
  if (ids.length === 0) return [];
  const memberships = await db.membership.findMany({
    where: { orgId: week.orgId, userId: { in: ids } },
    select: {
      userId: true,
      leftAt: true,
      subMatchInviteDm: true,
      user: { select: { name: true, phoneNumber: true, isActive: true } },
    },
  });
  const byId = new Map(memberships.map((m) => [m.userId, m]));
  const candidates: PoolCandidate[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    candidates.push({
      userId: id,
      name: m.user.name,
      phoneNumber: m.user.phoneNumber,
      inviteDm: m.subMatchInviteDm,
      leftAt: m.leftAt,
      isActive: m.user.isActive,
    });
  }
  return selectPaygPool({
    candidates,
    onMatchUserIds: week.rows.map((r) => r.userId),
    regularUserIds: week.members.filter((m) => m.kind === "regular").map((m) => m.userId),
  });
}

/**
 * A confirmed player dropped and NOBODY is on the waiting list. On a
 * monthly match the place then goes to the PAYG pool, through the same
 * `BenchSlotOffer` the bench uses: one offer per open slot, so one group
 * line and one DM per pool player (`bot-scheduler.ts`, section 3).
 * Called by `requestBenchConfirmationOnDrop` for a monthly club only.
 * Opens nothing for an organiser-pick club, with anyone waiting, with an
 * empty pool, or once the match has kicked off.
 */
export async function openPaygPoolOffer(matchId: string, replacingUserId: string | null, now: Date = new Date()): Promise<boolean> {
  const week = await loadMonthlyWeek(matchId);
  if (!week || !(LIVE as readonly string[]).includes(week.matchStatus)) return false;
  if (week.matchDate.getTime() <= now.getTime()) return false;
  const benchCount = week.rows.filter((r) => r.status === "BENCH").length;
  const pool = await loadPaygPool(week, now);
  if (!paygPoolOfferAllowed({ pickMode: week.pickMode, benchCount, poolSize: pool.length })) return false;
  const existing = await db.benchSlotOffer.findFirst({ where: { matchId, resolvedAt: null, replacingUserId } });
  if (existing) return false;
  await db.benchSlotOffer.create({ data: { matchId, replacingUserId } });
  return true;
}

// ── The poll's sweep ───────────────────────────────────────────────────

/**
 * Run from /api/whatsapp/due-posts before the posts are computed, for a
 * monthly club only (a weekly club returns after one read):
 *   - seed any due match (so a mid-month start shows up on the next poll,
 *     not the next cron);
 *   - `syncMonthlyWeek` for each live match of a running month, the safety
 *     net for a change that did not come through the attendance path (an
 *     admin screen, a merge);
 *   - stage the club's PAYG price as the fee to confirm once a match has
 *     ended, so the collector is asked "£8 each?" instead of "how much?"
 *     (plan 5.6). Only before the fee question has been sent.
 */
export async function sweepMonthlyWeeks(orgId: string, now: Date = new Date()): Promise<void> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      squadMode: true,
      approvalStatus: true,
      dormantAt: true,
      billingStatus: true,
      paygPricePence: true,
      paymentCollectionEnabled: true,
      paymentHolderId: true,
    },
  });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly" || !isClubOperational(org)) return;
  const months = await loadRunningMonths(orgId);
  if (months.length === 0) return;

  await seedDueMonthlySquads(now, orgId);

  const matches = await db.match.findMany({
    where: {
      activity: { orgId },
      isHistorical: false,
      OR: [{ status: { in: [...LIVE] } }, { status: "COMPLETED", date: { gte: new Date(now.getTime() - 7 * DAY_MS) } }],
    },
    select: {
      id: true,
      date: true,
      status: true,
      feePerPlayer: true,
      feePendingConfirm: true,
      postMatchEndFlow: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true, matchDurationMins: true } },
    },
  });
  for (const m of matches) {
    if (!monthForMatch(months, m)) continue;
    await syncMonthlyWeek(m.id, now);

    const endedAt = new Date(m.date.getTime() + m.activity.matchDurationMins * 60 * 1000);
    if (
      org.paygPricePence != null &&
      org.paymentCollectionEnabled &&
      org.paymentHolderId &&
      m.postMatchEndFlow !== false &&
      m.feePerPlayer == null &&
      m.feePendingConfirm == null &&
      now.getTime() >= endedAt.getTime()
    ) {
      const [asked, payers] = await Promise.all([
        db.sentNotification.findUnique({ where: { key: `${m.id}:fee-ask` }, select: { id: true } }),
        db.attendance.count({
          where: {
            matchId: m.id,
            status: "CONFIRMED",
            userId: { not: org.paymentHolderId },
            OR: [{ paymentMethod: null }, { paymentMethod: { not: MONTHLY_PAYMENT_METHOD } }],
          },
        }),
      ]);
      // Nobody played per game: there is no fee to ask about.
      if (!asked && payers > 0) {
        await db.match.updateMany({
          where: { id: m.id, feePerPlayer: null, feePendingConfirm: null },
          data: { feePendingConfirm: org.paygPricePence / 100 },
        });
      }
    }
  }
}

// ── The list, outside the scheduler ────────────────────────────────────

/** The key prefix of every "the group has seen this list" row. */
export function weekListKeyPrefix(matchId: string): string {
  return `${matchId}:month-list:`;
}

/** The week's list as MatchTime would post it now, and its hash. */
export function renderWeekList(week: MonthlyWeek): { text: string; hash: string } {
  const text = buildWeekListPost({
    list: buildWeekList({ members: week.members, rows: week.rows, maxPlayers: week.maxPlayers }),
    matchDate: week.matchDate,
    paygPricePence: week.paygPricePence,
    organiserPicks: week.pickMode === "organiser",
    lang: week.language,
  });
  return { text, hash: weekListHash(text) };
}

/**
 * The month's list for a reply the group ASKED for ("who's in?"), in
 * place of the weekly-shaped squad post. Null when the club is weekly,
 * the match has no running month or is not seeded yet, or the teams are
 * out (the team sheet is the answer then): the caller keeps its own post.
 */
export async function currentWeekListPost(matchId: string): Promise<{ text: string; hash: string } | null> {
  const week = await loadMonthlyWeek(matchId);
  if (!week || !week.seeded || week.teamsOut) return null;
  return renderWeekList(week);
}

/**
 * Record that the group has just seen the list with this hash, so the
 * scheduler does not post the same list again (plan 5.4).
 *   "group-message"    MatchTime posted it itself (a reply): it also
 *                      counts towards the 30-minute floor;
 *   "month-list-seen"  a member's paste showed it.
 * The key carries a running number, like the scheduler's own.
 */
export async function recordWeekListShown(matchId: string, hash: string, kind: "group-message" | "month-list-seen"): Promise<void> {
  const prefix = weekListKeyPrefix(matchId);
  const shown = await db.sentNotification.count({ where: { matchId, key: { startsWith: prefix } } });
  await db.sentNotification.create({ data: { key: `${prefix}${hash}:${shown}`, kind, matchId } });
}
