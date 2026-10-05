/**
 * Monthly squad: the database side (slice 2, 2026-10-05).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 3, 4.5 and 9.2.
 *
 * The ONLY writer of "SquadMonth", "SquadMonthMember" and "SquadCredit".
 * Slice 2 has one write: an organiser starting the CURRENT month part-way
 * through, from their own list (ticked on the page, or pasted and read by
 * the slice 1 reader, `monthly-list.ts`). The rules are in
 * `squad-month-rules.ts`.
 *
 * Nothing here posts to WhatsApp, queues a job or calls a model, and a
 * club on "weekly" (every club today, Sutton FC included) is refused
 * before anything is read.
 */
import { db } from "./db";
import { parseMonthlyList } from "./monthly-list";
import {
  draftSeedFromList,
  gamesPlayedBy,
  londonMonthStart,
  monthFixtureDates,
  monthStartToDate,
  normaliseSquadMode,
  planMonthSeed,
  type MemberKind,
  type MemberTier,
  type MonthSeedError,
  type MonthSeedInput,
  type SeedDraftRow,
  type SeedDraftUnmatched,
} from "./squad-month-rules";

export type StartMonthError = MonthSeedError | "not-monthly" | "already-started";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Start the current London month for one fixture, already under way.
 * Idempotent on (club, fixture, month): a second press, or a second
 * organiser pressing at the same moment, gets "already-started" and
 * writes nothing.
 */
export async function startMonth(
  orgId: string,
  actorUserId: string,
  input: MonthSeedInput,
  now: Date = new Date(),
): Promise<{ ok: true; monthId: string } | { ok: false; error: StartMonthError }> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return { ok: false, error: "not-monthly" };

  const activityId = typeof input?.activityId === "string" ? input.activityId : "";
  const activity = activityId
    ? await db.activity.findFirst({ where: { id: activityId, orgId, isActive: true }, select: { id: true } })
    : null;
  if (!activity) return { ok: false, error: "bad-fixture" };

  const monthStart = monthStartToDate(londonMonthStart(now));
  const existing = await db.squadMonth.findUnique({
    where: { orgId_activityId_monthStart: { orgId, activityId, monthStart } },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "already-started" };

  const members = await db.membership.findMany({
    where: { orgId, leftAt: null, user: { isActive: true } },
    select: { userId: true },
  });
  const plan = planMonthSeed(input, { memberUserIds: new Set(members.map((m) => m.userId)), actorUserId, now });
  if (!plan.ok) return { ok: false, error: plan.error };

  try {
    const monthId = await db.$transaction(async (tx) => {
      const month = await tx.squadMonth.create({ data: { orgId, monthStart, ...plan.month }, select: { id: true } });
      await tx.squadMonthMember.createMany({ data: plan.members.map((m) => ({ monthId: month.id, ...m })) });
      if (plan.credits.length > 0) {
        await tx.squadCredit.createMany({
          data: plan.credits.map((c) => ({
            orgId,
            userId: c.userId,
            games: c.games,
            reason: c.reason,
            appliedMonthId: month.id,
            appliedAt: c.appliedAt,
            createdById: c.createdById,
          })),
        });
      }
      return month.id;
    });
    return { ok: true, monthId };
  } catch (err) {
    // The unique (orgId, activityId, monthStart): somebody else got there first.
    if (isUniqueViolation(err)) return { ok: false, error: "already-started" };
    throw err;
  }
}

// ── A pasted list, read into a draft ───────────────────────────────────

/** Far longer than any group's list; a paste beyond it is not one. */
const MAX_LIST_CHARS = 8000;

export type ReadListError = "not-monthly" | "not-a-list";

/**
 * Read the organiser's pasted list with the slice 1 reader and match its
 * names to this club's current players (names and known aliases). Returns
 * a DRAFT for the organiser to check on the page. Writes nothing: the
 * month is only started by `startMonth`, with what the organiser submits.
 */
export async function readListForSeed(
  orgId: string,
  text: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; rows: SeedDraftRow[]; unmatched: SeedDraftUnmatched[]; monthMismatch: boolean }
  | { ok: false; error: ReadListError }
> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return { ok: false, error: "not-monthly" };
  if (typeof text !== "string" || text.length > MAX_LIST_CHARS) return { ok: false, error: "not-a-list" };
  const list = parseMonthlyList(text);
  if (!list) return { ok: false, error: "not-a-list" };

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId, leftAt: null, user: { isActive: true } },
      select: { user: { select: { id: true, name: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const roster = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias),
  }));
  const month = Number(londonMonthStart(now).slice(5, 7));
  return { ok: true, ...draftSeedFromList(list, roster, { month }) };
}

// ── Merging two player records ─────────────────────────────────────────

/** How much a member row knows about a payment: confirmed, claimed, nothing. */
const paymentWeight = (r: { paidAt: Date | null; paidClaimedAt: Date | null }): number => (r.paidAt ? 2 : r.paidClaimedAt ? 1 : 0);

/** The slice of a transaction client the merge needs. */
interface SquadMergeTx {
  squadMonthMember: {
    findMany(args: { where: { userId: string } }): Promise<Array<{ id: string; monthId: string; paidAt: Date | null; paidClaimedAt: Date | null }>>;
    findUnique(args: {
      where: { monthId_userId: { monthId: string; userId: string } };
    }): Promise<{ id: string; paidAt: Date | null; paidClaimedAt: Date | null } | null>;
    update(args: { where: { id: string }; data: { userId: string } }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  squadCredit: { updateMany(args: { where: { userId: string }; data: { userId: string } }): Promise<unknown> };
}

/**
 * Called by `mergePlayersCore`, inside its transaction, BEFORE the dropped
 * user row is deleted: both tables reference "User" ON DELETE CASCADE, so
 * anything not moved here would be deleted with it.
 *
 * One row per person per month. Where both records are in the same month
 * the keeper's row stays, unless only the dropped one knows more about a
 * payment (confirmed beats claimed beats nothing): then that row is the
 * one kept. Credits always move.
 */
export async function repointSquadMonthRows(tx: SquadMergeTx, keepUserId: string, dropUserId: string): Promise<void> {
  const dropRows = await tx.squadMonthMember.findMany({ where: { userId: dropUserId } });
  for (const d of dropRows) {
    const k = await tx.squadMonthMember.findUnique({ where: { monthId_userId: { monthId: d.monthId, userId: keepUserId } } });
    if (k && paymentWeight(k) >= paymentWeight(d)) {
      await tx.squadMonthMember.delete({ where: { id: d.id } });
      continue;
    }
    if (k) await tx.squadMonthMember.delete({ where: { id: k.id } });
    await tx.squadMonthMember.update({ where: { id: d.id }, data: { userId: keepUserId } });
  }
  await tx.squadCredit.updateMany({ where: { userId: dropUserId }, data: { userId: keepUserId } });
}

// ── /admin/months ──────────────────────────────────────────────────────

export type PaidState = "none" | "claimed" | "confirmed";

export interface MonthMemberView {
  userId: string;
  name: string;
  slot: number | null;
  kind: MemberKind;
  tier: MemberTier;
  gamesCovered: number;
  creditsApplied: number;
  amountDuePence: number | null;
  paid: PaidState;
  /** What was confirmed, or else what was claimed. */
  paidPence: number | null;
}

export interface MonthFixtureView {
  activityId: string;
  name: string;
  /** The month's dates on this fixture's weekday, "YYYY-MM-DD". */
  dates: string[];
  /** How many of them have kicked off. */
  gamesPlayed: number;
  /** null: this month has not been started for this fixture. */
  month: {
    id: string;
    status: string;
    gamesScheduled: number;
    gamesPlayedBeforeStart: number;
    sharePerGamePence: number | null;
    startedMidMonth: boolean;
    members: MonthMemberView[];
  } | null;
}

export interface MonthPageData {
  /** "2026-10-01". */
  monthStart: string;
  fixtures: MonthFixtureView[];
  /** The club's current players, for the ticks. */
  players: { userId: string; name: string }[];
}

/**
 * Everything /admin/months shows for the current London month: each
 * active fixture with its month (or none yet), and the club's players.
 * Read only. The caller has already checked the club is monthly and the
 * viewer an admin.
 */
export async function loadMonthPage(orgId: string, now: Date = new Date()): Promise<MonthPageData> {
  const monthStart = londonMonthStart(now);
  const [activities, months, memberships] = await Promise.all([
    db.activity.findMany({
      where: { orgId, isActive: true },
      select: { id: true, name: true, dayOfWeek: true, time: true },
      orderBy: { createdAt: "asc" },
    }),
    db.squadMonth.findMany({
      where: { orgId, monthStart: monthStartToDate(monthStart) },
      select: {
        id: true,
        activityId: true,
        status: true,
        gamesScheduled: true,
        gamesPlayedBeforeStart: true,
        sharePerGamePence: true,
        startedMidMonthAt: true,
        members: {
          where: { leftAt: null },
          orderBy: [{ slot: "asc" }, { createdAt: "asc" }],
          select: {
            userId: true,
            slot: true,
            kind: true,
            tier: true,
            gamesCovered: true,
            creditsApplied: true,
            amountDuePence: true,
            paidAt: true,
            paidAmountPence: true,
            paidClaimedAt: true,
            paidClaimedAmountPence: true,
            user: { select: { name: true } },
          },
        },
      },
    }),
    db.membership.findMany({
      where: { orgId, leftAt: null, user: { isActive: true } },
      select: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
  ]);

  const fixtures: MonthFixtureView[] = activities.map((a) => {
    const dates = monthFixtureDates(monthStart, a.dayOfWeek);
    const m = months.find((x) => x.activityId === a.id) ?? null;
    return {
      activityId: a.id,
      name: a.name,
      dates,
      gamesPlayed: gamesPlayedBy(dates, a.time, now),
      month: m && {
        id: m.id,
        status: m.status,
        gamesScheduled: m.gamesScheduled,
        gamesPlayedBeforeStart: m.gamesPlayedBeforeStart,
        sharePerGamePence: m.sharePerGamePence,
        startedMidMonth: m.startedMidMonthAt !== null,
        members: m.members.map((r) => ({
          userId: r.userId,
          name: r.user.name ?? "",
          slot: r.slot,
          kind: r.kind === "payg" ? "payg" : "regular",
          tier: r.tier === "concession" ? "concession" : "standard",
          gamesCovered: r.gamesCovered,
          creditsApplied: r.creditsApplied,
          amountDuePence: r.amountDuePence,
          paid: r.paidAt ? "confirmed" : r.paidClaimedAt ? "claimed" : "none",
          paidPence: r.paidAt ? r.paidAmountPence : r.paidClaimedAt ? r.paidClaimedAmountPence : null,
        })),
      },
    };
  });

  return {
    monthStart,
    fixtures,
    players: memberships.map((m) => ({ userId: m.user.id, name: m.user.name ?? "" })),
  };
}
