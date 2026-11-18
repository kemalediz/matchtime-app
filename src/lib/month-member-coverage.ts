/**
 * HOW MANY OF THE MONTH'S GAMES A REGULAR COVERS, the write (Kemal,
 * 2026-11-16). The ONE writer of `SquadMonthMember.gamesCovered` after a
 * regular is on the month; the rules are `month-coverage-rules.ts`.
 *
 * An organiser sets it on /admin/months (the coverage editor), by "Add a
 * player" in a month under way, and by tagging MatchTime in the
 * organisers' group ("Dan covers the whole month",
 * `month-coverage-words.ts`). Coverage only changes the future: never fewer
 * than the games he was covered for that are already played plus the
 * games left (`memberCoverageBounds`, the same bounds the editor offers).
 *
 * Money, with the existing pricing only:
 *   - not paid, with an amount already worked out: `settleMemberAmount`
 *     prices them again (credits included), as every change does;
 *   - paid, or says so, with an amount: the organiser is saying what that
 *     money was for, so the amount due follows the new games
 *     (`amountDuePence`, the seed's own sum); a claim with no amount is
 *     then confirmed at it, and a confirmed payment keeps what was paid
 *     (the page shows any difference);
 *   - no amount yet (no price): nothing is written but the games.
 * Nothing here records a payment, posts or calls a model.
 */
import { db } from "./db";
import {
  decideCoverage,
  memberCoverageBounds,
  monthCoverage,
  type Coverage,
  type CoverageBounds,
  type CoverageError,
  type MonthCoverage,
} from "./month-coverage-rules";
import { hasStarted, loadSignupMonth, lockMonth, type SignupMonth } from "./month-signup";
import { amountDuePence } from "./squad-month-rules";
import { freezePaidAmount } from "./month-close-rules";
import { formatLondon } from "./london-time";

export type SetCoverageError = CoverageError | "not-found" | "closed";

export type SetCoverageResult =
  | {
      ok: true;
      changed: boolean;
      gamesCovered: number;
      bounds: CoverageBounds;
      month: MonthCoverage;
      /** His credited called-off weeks, for what the reply shows (`shownCoverage`). */
      creditedCancelled: number;
    }
  | { ok: false; error: SetCoverageError; bounds?: CoverageBounds };

const MONEY_SELECT = {
  orgId: true,
  status: true,
  gamesScheduled: true,
  monthStart: true,
  sharePerGamePence: true,
  concessionPerGamePence: true,
  activityId: true,
  startedMidMonthAt: true,
  listOpenedAt: true,
  createdAt: true,
} as const;

type Client = Pick<typeof db, "attendance">;

/** When the month was counted: a seed-list row counts from the first game
 *  only while he has been on it since (review 2 of #611, item 1). */
const countedAtOf = (m: { startedMidMonthAt: Date | null; listOpenedAt: Date | null; createdAt: Date }): Date => m.startedMidMonthAt ?? m.listOpenedAt ?? m.createdAt;

/**
 * The games of this month each player paid for as pay as you go before he
 * became a regular (`before`: his join date), one per London day (review 2
 * of #611, item 4): never charged again by raising him to the whole month.
 */
async function paidPaygGames(client: Client, p: { activityId: string; monthStart: Date; userIds: string[]; before: (userId: string) => Date }): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (p.userIds.length === 0) return out;
  const rows = await client.attendance.findMany({
    where: {
      userId: { in: p.userIds },
      status: "CONFIRMED",
      OR: [{ paidAt: { not: null } }, { paidViaUserId: { not: null } }],
      match: { activityId: p.activityId, isHistorical: false, status: { not: "CANCELLED" }, date: { gte: p.monthStart } },
    },
    select: { userId: true, match: { select: { date: true } } },
  });
  const days = new Map<string, Set<string>>();
  for (const r of rows as Array<{ userId?: string; match: { date: Date } }>) {
    const uid = r.userId ?? p.userIds[0];
    if (r.match.date.getTime() >= p.before(uid).getTime()) continue;
    const set = days.get(uid) ?? new Set<string>();
    set.add(formatLondon(r.match.date, "yyyy-MM-dd"));
    days.set(uid, set);
  }
  for (const [uid, set] of days) out.set(uid, set.size);
  return out;
}

/** The month as coverage sees it: its games left, whole month and playable games. */
function monthOf(m: SignupMonth, row: { gamesScheduled: number }, now: Date): MonthCoverage {
  return monthCoverage({ gamesScheduled: row.gamesScheduled, kickoffs: m.kickoffs, now });
}

export interface CoverageView {
  started: boolean;
  month: MonthCoverage;
  /** Each regular's bounds, what he covers, and his credited called-off weeks, by user id. */
  members: Map<string, CoverageBounds & { gamesCovered: number; creditedCancelled: number }>;
}

/** A month's coverage now, and every regular's bounds (the page's editor
 *  offers exactly these). Null for no such month, or a club that is not
 *  monthly. */
export async function loadCoverageView(monthId: string, now: Date = new Date()): Promise<CoverageView | null> {
  const m = await loadSignupMonth(monthId);
  if (!m) return null;
  const row = await db.squadMonth.findUnique({
    where: { id: monthId },
    select: { ...MONEY_SELECT, members: { where: { kind: "regular", leftAt: null }, select: { userId: true, joinedAt: true, source: true, gamesCovered: true } } },
  });
  if (!row) return null;
  const month = monthOf(m, row, now);
  // Each regular's credited called-off weeks: the same floor the write checks.
  const credits = await db.squadCredit.findMany({ where: { earnedMonthId: monthId, reason: "cancelled-week", voidedAt: null }, select: { userId: true } });
  const creditedOf = (userId: string) => credits.filter((c) => c.userId === userId).length;
  const joinedOf = new Map(row.members.map((x) => [x.userId, x.joinedAt]));
  const payg = await paidPaygGames(db, { activityId: row.activityId, monthStart: row.monthStart, userIds: row.members.map((x) => x.userId), before: (u) => joinedOf.get(u) ?? now });
  const members = new Map(
    row.members.map((x) => [
      x.userId,
      {
        ...memberCoverageBounds(month, { joinedAt: x.joinedAt, source: x.source, kickoffs: m.kickoffs, now, creditedCancelled: creditedOf(x.userId), countedAt: countedAtOf(row), paidPayg: payg.get(x.userId) ?? 0 }),
        gamesCovered: x.gamesCovered,
        creditedCancelled: creditedOf(x.userId),
      },
    ]),
  );
  return { started: hasStarted(m, now), month, members };
}

/**
 * Would this coverage be allowed for him once he is a regular of the month
 * (review round 3, item 4)? Writes nothing. Somebody with no row yet, or
 * a pay-as-you-go row, is checked as a regular joining now; a returning
 * row by what it already holds, under the bounds the write uses. The web
 * add checks this FIRST, so a refusal leaves no sign-up and no claim.
 */
export async function checkMonthMemberCoverage(args: {
  squadMonthId: string;
  userId: string;
  coverage: Coverage | number;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: SetCoverageError }> {
  const now = args.now ?? new Date();
  const month = await loadSignupMonth(args.squadMonthId);
  if (!month) return { ok: false, error: "not-found" };
  if (month.status === "closed") return { ok: false, error: "closed" };
  const [m, row] = await Promise.all([
    db.squadMonth.findUnique({ where: { id: month.id }, select: MONEY_SELECT }),
    db.squadMonthMember.findUnique({
      where: { monthId_userId: { monthId: month.id, userId: args.userId } },
      select: { kind: true, leftAt: true, joinedAt: true, source: true, gamesCovered: true, gamesCommitted: true, creditsApplied: true },
    }),
  ]);
  if (!m) return { ok: false, error: "not-found" };
  if (m.status === "closed") return { ok: false, error: "closed" };
  const cover = monthOf(month, m, now);
  // A leaver back is checked as a regular joining now (review 2 of #611, item 1).
  const regular = row?.kind === "regular" && row.leftAt === null;
  const creditedCancelled = regular
    ? await db.squadCredit.count({ where: { orgId: m.orgId, userId: args.userId, earnedMonthId: month.id, reason: "cancelled-week", voidedAt: null } })
    : 0;
  const bounds = memberCoverageBounds(cover, {
    joinedAt: regular ? row!.joinedAt : now,
    source: regular ? row!.source : "admin",
    kickoffs: month.kickoffs,
    now,
    creditedCancelled,
    countedAt: countedAtOf(m),
    paidPayg: (await paidPaygGames(db, { activityId: m.activityId, monthStart: m.monthStart, userIds: [args.userId], before: () => (regular ? row!.joinedAt : now) })).get(args.userId) ?? 0,
  });
  const d = decideCoverage({
    target: args.coverage,
    bounds,
    row: {
      kind: "regular",
      out: false,
      gamesCovered: regular ? row!.gamesCovered : cover.gamesLeft,
      gamesCommitted: regular ? row!.gamesCommitted : null,
      creditsApplied: row?.creditsApplied ?? 0,
    },
  });
  return d.ok ? { ok: true } : { ok: false, error: d.error };
}

export async function setMonthMemberCoverage(args: {
  squadMonthId: string;
  userId: string;
  /** "whole", "left", or a number of games between them. */
  coverage: Coverage | number;
  /**
   * The organiser's words say his says-paid claim is for this coverage
   * ("he's paid the whole month", the web's "the whole month, already
   * paid"): a claim with no amount is not written down at the old amount
   * first. Never for a confirmed payment. Absent: the #464 freeze.
   */
  claimCovers?: boolean;
  now?: Date;
}): Promise<SetCoverageResult> {
  const now = args.now ?? new Date();
  const month = await loadSignupMonth(args.squadMonthId);
  if (!month) return { ok: false, error: "not-found" };
  if (month.status === "closed") return { ok: false, error: "closed" };

  const res = await db.$transaction(async (tx): Promise<SetCoverageResult & { monthStart?: Date }> => {
    await lockMonth(tx, month.id);
    const [m, row] = await Promise.all([
      tx.squadMonth.findUnique({ where: { id: month.id }, select: MONEY_SELECT }),
      tx.squadMonthMember.findUnique({
        where: { monthId_userId: { monthId: month.id, userId: args.userId } },
        select: {
          id: true,
          kind: true,
          tier: true,
          leftAt: true,
          joinedAt: true,
          source: true,
          gamesCovered: true,
          gamesCommitted: true,
          creditsApplied: true,
          amountDuePence: true,
          paidAt: true,
          paidClaimedAt: true,
          paidAmountPence: true,
          paidClaimedAmountPence: true,
        },
      }),
    ]);
    if (!m) return { ok: false, error: "not-found" };
    if (m.status === "closed") return { ok: false, error: "closed" };
    const cover = monthOf(month, m, now);
    // The called-off weeks he holds a credit for (round 2, item 1): read
    // under the lock, only counted; nothing here creates or takes one back.
    const creditedCancelled = row
      ? await tx.squadCredit.count({ where: { orgId: m.orgId, userId: args.userId, earnedMonthId: month.id, reason: "cancelled-week", voidedAt: null } })
      : 0;
    const paidPayg = row ? ((await paidPaygGames(tx, { activityId: m.activityId, monthStart: m.monthStart, userIds: [args.userId], before: () => row.joinedAt })).get(args.userId) ?? 0) : 0;
    const bounds = row
      ? memberCoverageBounds(cover, { joinedAt: row.joinedAt, source: row.source, kickoffs: month.kickoffs, now, creditedCancelled, countedAt: countedAtOf(m), paidPayg })
      : { min: cover.gamesLeft, max: cover.whole };
    const d = decideCoverage({
      target: args.coverage,
      bounds,
      row: row && { kind: row.kind === "payg" ? "payg" : "regular", out: row.leftAt !== null, gamesCovered: row.gamesCovered, gamesCommitted: row.gamesCommitted, creditsApplied: row.creditsApplied },
    });
    if (!d.ok) return { ok: false, error: d.error, bounds };
    if (!d.changed || !row) return { ok: true, changed: false, gamesCovered: d.gamesCovered, bounds, month: cover, creditedCancelled };

    const priced = row.amountDuePence !== null && m.sharePerGamePence != null;
    const paid = row.paidAt !== null || row.paidClaimedAt !== null;
    const share = row.tier === "concession" && m.concessionPerGamePence != null ? m.concessionPerGamePence : m.sharePerGamePence;
    // What he paid, or says he paid, with no amount written down was what he
    // was asked for THEN: written down first, so the change shows as "owes
    // more" or "to give back", never lost (review of #611, round 4, item 1;
    // the #464 rule, as `setMonthMemberGames` does). The one exception: the
    // organiser's own words say his claim, with no amount and not yet
    // confirmed, is for this new coverage ("he's paid the whole month").
    const claimForThis = !!args.claimCovers && row.paidAt === null && row.paidClaimedAt !== null && row.paidClaimedAmountPence === null;
    const freeze = priced && paid && !claimForThis ? freezePaidAmount(row) : {};
    await tx.squadMonthMember.update({
      where: { id: row.id },
      data: {
        ...freeze,
        gamesCovered: d.gamesCovered,
        gamesCommitted: d.gamesCommitted,
        ...(priced && paid
          ? { amountDuePence: amountDuePence({ sharePence: share, gamesCovered: d.gamesCovered, gamesCommitted: d.gamesCommitted, creditsApplied: row.creditsApplied }) }
          : {}),
      },
    });
    // Not paid and priced: priced again HERE, in this transaction, so a
    // failure rolls the change back (review 2 of #611, item 5).
    if (priced && !paid) {
      const { settleMemberAmountTx } = await import("./month-payment");
      await settleMemberAmountTx(tx, month.id, args.userId, now);
    }
    return { ok: true, changed: true, gamesCovered: d.gamesCovered, bounds, month: cover, creditedCancelled, monthStart: m.monthStart };
  });

  if (!res.ok) return res;
  const { monthStart, ...out } = res;
  if (!out.changed) return out;
  if (monthStart) {
    const { afterMemberGamesChanged } = await import("./month-member-games");
    await afterMemberGamesChanged({ orgId: month.orgId, monthId: month.id, monthStart, userId: args.userId, now });
  }
  console.log(`[month-member-coverage] ${args.userId} on ${month.id} now covers ${out.gamesCovered} of ${out.bounds.max}`);
  return out;
}
