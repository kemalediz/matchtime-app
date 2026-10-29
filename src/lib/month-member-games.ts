/**
 * "4 only" (2026-10-29, Vets MNF): a regular who commits to fewer games
 * than the month has. The ONE writer of `SquadMonthMember.gamesCommitted`.
 *
 * What the count means (the rules are in `squad-month-rules.ts`
 * `chargedGames` and `monthly-week-rules.ts` `commitmentForMatch`):
 *   - they pay share x the games they committed to (minus credits);
 *   - once they have played that many games of the month, its other weeks
 *     are away weeks WITHOUT a credit: they never paid for them;
 *   - a game they play beyond them is pay-as-you-go, at the club's PAYG
 *     price, through the ordinary per-match payment;
 *   - NULL is every game, as for every regular before this.
 *
 * Callers: /admin/months (the seed draft's games column, and a member's
 * row), the member's /month page, and the list reader (agent B's), which
 * reads "4 only" beside a name. Nothing here posts or calls a model.
 *
 * Under the club-month's lock and the club's credits lock, like every
 * other money write: what they owe is worked out again at once when the
 * month has a price.
 */
import { db } from "./db";
import { lockMonth } from "./month-signup";
import { lockClubCredits, usableCredits } from "./month-payment";
import { planPricing } from "./month-payment-rules";
import { chargedGames, checkGamesCommitted, normaliseSquadMode } from "./squad-month-rules";

export type SetMonthMemberGamesError =
  | "bad-games"
  | "more-than-the-month"
  | "not-found"
  | "not-monthly"
  | "closed"
  | "not-a-member"
  | "not-a-regular"
  | "locked";

export async function setMonthMemberGames(args: {
  squadMonthId: string;
  userId: string;
  /** NULL: every game. */
  games: number | null;
  /** "organiser": an owner or admin (the page). "reader": read from a list
   *  a member pasted; never changes a CONFIRMED payment's games. */
  by: "organiser" | "reader";
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = args.now ?? new Date();
  if (args.games !== null && checkGamesCommitted(args.games, Number.MAX_SAFE_INTEGER).ok === false) return { ok: false, error: "bad-games" };
  const month = await db.squadMonth.findUnique({
    where: { id: args.squadMonthId },
    select: { id: true, orgId: true, status: true, org: { select: { squadMode: true } } },
  });
  if (!month) return { ok: false, error: "not-found" };
  if (normaliseSquadMode(month.org.squadMode) !== "monthly") return { ok: false, error: "not-monthly" };
  if (month.status === "closed") return { ok: false, error: "closed" };

  return db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    await lockClubCredits(tx, month.orgId);
    const [m, row] = await Promise.all([
      tx.squadMonth.findUnique({
        where: { id: month.id },
        select: { status: true, sharePerGamePence: true, concessionPerGamePence: true, pricedAt: true },
      }),
      tx.squadMonthMember.findUnique({
        where: { monthId_userId: { monthId: month.id, userId: args.userId } },
        select: {
          id: true,
          kind: true,
          tier: true,
          leftAt: true,
          gamesCovered: true,
          gamesCommitted: true,
          creditsApplied: true,
          paidAt: true,
          paidClaimedAt: true,
        },
      }),
    ]);
    if (!m || m.status === "closed") return { ok: false as const, error: "closed" };
    if (!row || row.leftAt !== null) return { ok: false as const, error: "not-a-member" };
    if (row.kind !== "regular") return { ok: false as const, error: "not-a-regular" };
    // A confirmed payment was for a number of games: only an organiser
    // changes that (the collector then sees the difference).
    if (args.by === "reader" && row.paidAt) return { ok: false as const, error: "locked" };
    const checked = checkGamesCommitted(args.games, row.gamesCovered);
    if (!checked.ok) return { ok: false as const, error: checked.error };
    if (checked.value === row.gamesCommitted) return { ok: true as const };

    const committed = checked.value;
    const charged = chargedGames({ gamesCovered: row.gamesCovered, gamesCommitted: committed });
    let creditsApplied = row.creditsApplied;
    let amountDuePence: number | null | undefined;
    const share = m.sharePerGamePence;

    if (share != null) {
      // Fewer games than the credits used against the month: the extra
      // credits go back to the ledger for a later month, newest first.
      // Never one the organiser said they came into the month with, and
      // never a confirmed payment's (that money was paid net of them).
      if (creditsApplied > charged && !row.paidAt) {
        const applied = await tx.squadCredit.findMany({
          where: { orgId: month.orgId, userId: args.userId, appliedMonthId: month.id, voidedAt: null, reason: { not: "carried-in" } },
          select: { id: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: creditsApplied - charged,
        });
        if (applied.length > 0) {
          const released = await tx.squadCredit.updateMany({
            where: { id: { in: applied.map((c) => c.id) }, appliedMonthId: month.id },
            data: { appliedMonthId: null, appliedAt: null },
          });
          creditsApplied -= released.count;
        }
      }
      const concession = row.tier === "concession" && m.concessionPerGamePence != null ? m.concessionPerGamePence : share;
      if (row.paidAt === null && row.paidClaimedAt === null) {
        // Not paid: more games may take more of their usable credits, the
        // same way pricing does.
        const credits = await usableCredits(tx, month.orgId, [args.userId], now, m.pricedAt);
        const [plan] = planPricing({
          members: [
            { userId: args.userId, kind: "regular", tier: row.tier === "concession" ? "concession" : "standard", waiting: false, out: false, gamesCovered: charged, creditsApplied, paid: "none" },
          ],
          credits,
          sharePence: share,
          concessionPence: m.concessionPerGamePence,
        });
        if (plan && plan.creditIds.length > 0) {
          const taken = await tx.squadCredit.updateMany({
            where: { id: { in: plan.creditIds }, appliedMonthId: null, voidedAt: null },
            data: { appliedMonthId: month.id, appliedAt: now },
          });
          creditsApplied += taken.count;
        }
      }
      amountDuePence = concession * Math.max(0, charged - creditsApplied);
    }

    await tx.squadMonthMember.update({
      where: { id: row.id },
      data: {
        gamesCommitted: committed,
        // The CHECK holds credits to the games covered, whatever is committed.
        creditsApplied: Math.max(0, Math.min(row.gamesCovered, creditsApplied)),
        ...(amountDuePence !== undefined ? { amountDuePence } : {}),
      },
    });
    return { ok: true as const };
  });
}
