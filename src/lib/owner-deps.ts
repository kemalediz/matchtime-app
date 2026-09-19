/**
 * §10 STEP 8 — THE PRODUCTION HALF OF THE APPLY LAYERS.
 *
 * `score-engine.ts` and `admin-ops-engine.ts` shipped in PR #52 as apply
 * layers taking INJECTED dependencies, and PR #52 said so plainly:
 * "Nothing is wired into `analyze/route.ts`." So every implementation of
 * `ScoreApplyDeps` and `AdminOpsApplyDeps` in the repo was a test fake
 * or the corpus harness's SQL shim. Nothing spoke to Prisma, because
 * nothing had a caller.
 *
 * This file is the caller's half. Each function below is the SAME query
 * `executeVerdict` ran, moved rather than rewritten, so that deleting
 * the mega-prompt does not quietly change what the database is asked
 * for. Where a clause looks arbitrary it is cited: `isHistorical: false`,
 * `leftAt: null`, `paidAt: null`, the ended-match window. Those are the
 * things a reimplementation drops without noticing, and
 * `__tests__/owner-deps.test.ts` pins each of them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY IT IS HERE AND NOT IN `pipeline/`
 * ─────────────────────────────────────────────────────────────────────
 * `pipeline/__tests__/zero-writes.test.ts` scans every file in
 * `src/lib/pipeline/` for a mutation on every build. This file is
 * nothing but mutations. It lives beside the two apply layers it serves,
 * which is where `score-engine.ts` and `admin-ops-engine.ts` already
 * live and for the same reason.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ONE PLACE THIS IS NOT A STRAIGHT LIFT: `markPaid`
 * ─────────────────────────────────────────────────────────────────────
 * `route.ts:3867-3872` read the row, checked `if (!att.paidAt)`, then
 * updated by id. Two statements with a gap between them, and two admins
 * crediting the same player in the same minute both see `paidAt: null`
 * and both write. That is harmless today (the second write only moves a
 * timestamp) but it is a read-modify-write on a money column, and it
 * does not need to be.
 *
 * The `paidAt: null` moves INTO the WHERE and the pair becomes one
 * `updateMany`, so the database decides. Same outcome, one statement,
 * and the idempotence is now a property of the query rather than of the
 * order two requests happen to arrive in. This is a strengthening, and
 * it is called out rather than slipped in because §13's rule is that
 * moving a guard must not lose it — here it moves and gets stricter.
 */
import { db as defaultDb } from "./db";
import type { EloDelta, PlayerEloInput } from "./elo";
import type { ScoreApplyDeps } from "./score-engine";
import type { AdminOpsApplyDeps, PaidState } from "./admin-ops-engine";
import type { TeamOpsApplyDeps } from "./team-ops-engine";
import {
  applyMembershipEloDeltas,
  loadMembershipEloInputs,
  orgIdForMatch,
} from "./membership-elo";
import { recordAttendanceEvent } from "./attendance-events";
import { generateTeamsForMatch } from "./team-generation";
import { guestNameAskKey, GUEST_NAME_ASK_KIND } from "./guest-name-ask";

/** The Prisma surface these deps touch. Typed as the real client by
 *  default; widened only so a unit test can hand in a stub without a
 *  database. */
type Db = typeof defaultDb;

/**
 * `ScoreApplyDeps`, backed by Prisma.
 *
 * Lifted from `route.ts:3511-3533`. Note what is NOT here: the match
 * SELECTION and the authorisation check. Both moved into the engine in
 * PR #52 (`SquadState.completedMatch` and `handleScore`'s participant /
 * admin gate), which is the point of an apply layer — it applies a
 * decision, it does not make one.
 */
export function buildScoreApplyDeps(args: { db?: Db } = {}): ScoreApplyDeps {
  const db = args.db ?? defaultDb;
  return {
    async recordScore({ matchId, red, yellow }) {
      // One update, exactly as `route.ts:3511`: the two scores and the
      // status move together, because a match with a score that is not
      // COMPLETED is a state the rest of the system does not model.
      await db.match.update({
        where: { id: matchId },
        data: { redScore: red, yellowScore: yellow, status: "COMPLETED" },
      });
    },

    async loadEloInputs(matchId): Promise<PlayerEloInput[]> {
      // The player's CURRENT rating AT THIS CLUB, read at apply time
      // rather than carried from the state load. `route.ts:3520-3524`
      // read it off the same include for the same reason. A rating that
      // moved between the two would make the delta compound.
      //
      // Since 2026-09-19 the rating is `Membership.matchRating`, so the
      // club has to be resolved first. A match with no org left (it was
      // deleted under us) has no club Elo to move, and the derived half
      // of a score write must never unmake the score.
      const orgId = await orgIdForMatch(db, matchId);
      if (!orgId) return [];
      const rows = await db.teamAssignment.findMany({
        where: { matchId },
        select: { userId: true, team: true },
      });
      const { inputs } = await loadMembershipEloInputs({ db, orgId, assignments: rows });
      return inputs;
    },

    async applyEloDeltas(matchId: string, deltas: EloDelta[]) {
      // `computeEloDeltas` returns [] for a match whose teams were never
      // generated, and an empty `$transaction([])` is a pointless round
      // trip. `route.ts` did not guard this because it was inside a
      // try/catch nobody read; the guard now lives in
      // `applyMembershipEloDeltas` so all four call sites share it.
      const orgId = await orgIdForMatch(db, matchId);
      if (!orgId) return;
      await applyMembershipEloDeltas({ db, orgId, deltas });
    },
  };
}

/**
 * `AdminOpsApplyDeps`, backed by Prisma.
 *
 * Lifted from `route.ts:3804-3901` (payment) and `:3950-3987`
 * (reminder). `orgId` is bound at construction because a `BotJob` is
 * tenant-scoped and passing it per call is one signature away from a DM
 * queued against the wrong club.
 */
export function buildAdminOpsApplyDeps(args: {
  orgId: string;
  db?: Db;
}): AdminOpsApplyDeps {
  const db = args.db ?? defaultDb;
  const { orgId } = args;
  return {
    async loadPaidState(matchId): Promise<PaidState> {
      // `status: "CONFIRMED"` on the attendances is load-bearing and is
      // the shipped filter (`route.ts:3810`): a bench player owes
      // nothing, so counting them would make "Unpaid: 4/14" wrong in
      // the direction that chases people for money they do not owe.
      const m = await db.match.findUnique({
        where: { id: matchId },
        include: {
          activity: { select: { name: true } },
          attendances: {
            where: { status: "CONFIRMED" },
            include: { user: { select: { id: true, name: true } } },
          },
          paymentCredits: true,
        },
      });
      if (!m) {
        // The engine chose this match id off the state load moments ago,
        // so this is the row disappearing underneath us. Report an empty
        // state rather than throw: the engine's own arithmetic then
        // credits nobody, which is the safe direction on a money path.
        return { matchName: "", confirmed: [], creditTotal: 0 };
      }
      return {
        matchName: m.activity.name,
        confirmed: m.attendances.map((a) => ({
          userId: a.userId,
          name: a.user.name ?? "",
          paid: a.paidAt != null,
        })),
        creditTotal: m.paymentCredits.reduce((s, c) => s + c.count, 0),
      };
    },

    async markPaid({ matchId, userId, payerUserId }) {
      // `paidAt: null` in the WHERE — see the header. One statement, and
      // a player who is already paid is untouched.
      await db.attendance.updateMany({
        where: { matchId, userId, paidAt: null },
        data: { paidAt: new Date(), paidViaUserId: payerUserId },
      });
    },

    async createPaymentCredit({ matchId, payerUserId, recordedByUserId, count }) {
      // The note is shipped copy (`route.ts:3883`) and it names the
      // admin, so the name is looked up rather than dropped. `recordedById`
      // carries the truth either way; the note is what a human reads in
      // the dashboard, and "Recorded via WhatsApp by Kemal Ediz" is the
      // sentence that has been in that column since April.
      const who = await db.user.findUnique({
        where: { id: recordedByUserId },
        select: { name: true },
      });
      await db.paymentCredit.create({
        data: {
          matchId,
          payerUserId,
          count,
          recordedById: recordedByUserId,
          note: `Recorded via WhatsApp by ${who?.name ?? "admin"}`,
        },
      });
    },

    async loadPhone(userId) {
      const u = await db.user.findUnique({
        where: { id: userId },
        select: { phoneNumber: true },
      });
      return u?.phoneNumber ?? null;
    },

    async queueReminderDm({ phone, text, sendAt }) {
      // `sendAfter` is the whole mechanism: the scheduler's BotJob block
      // only emits rows whose `sendAfter` has passed, so a reminder for
      // Monday needs no second timer and no cron of its own.
      //
      // The leading `+` is stripped here rather than at the call site
      // because every other DM queue in this codebase strips it
      // (`route.ts:352`, `:459`, `:522`) and one that did not would fail
      // silently on the Pi.
      await db.botJob.create({
        data: {
          orgId,
          kind: "dm",
          phone: phone.replace(/^\+/, ""),
          text,
          sendAfter: sendAt,
        },
      });
    },
  };
}

/**
 * `TeamOpsApplyDeps`, backed by Prisma.
 *
 * Lifted from `route.ts:3553-3665`. Three things, and the first is the
 * one worth reading twice.
 *
 * ─────────────────────────────────────────────────────────────────────
 * `selectTeamsMatch` IS NOT `selectRegistrationMatch`, AND MUST NOT BE
 * ─────────────────────────────────────────────────────────────────────
 * They answer different questions and they disagree on exactly the
 * evening this matters.
 *
 * `selectRegistrationMatch` answers "where does an IN land?", and it
 * deliberately returns NOTHING while a previously-scheduled match is
 * still in flight — the 2026-05-06 rule that stops a casual "in" at
 * 23:00 landing on next week's empty match before the cron has
 * completed tonight's. That is correct for a registration and wrong for
 * a team sheet: "generate the teams" is asked at 20:00 on match night,
 * with the match in flight, which is the state that selector refuses.
 *
 * So this is the SHIPPED team selector verbatim (`route.ts:3553-3560`):
 * status in the three live states, `attendanceDeadline` within the last
 * 24 hours, soonest first. `team-ops-engine.ts`'s own header says the
 * two must be kept apart and that the runner never substitutes one for
 * the other; this is that separation made real.
 */
export function buildTeamOpsApplyDeps(args: {
  /** Bound at construction, like the admin-ops deps: `AttendanceEvent`
   *  is tenant-scoped and `forceConfirm`'s signature does not carry one,
   *  so taking it per call would mean threading it through the engine
   *  for no reason and giving a future caller somewhere to get it
   *  wrong. */
  orgId: string;
  db?: Db;
}): TeamOpsApplyDeps {
  const db = args.db ?? defaultDb;
  const { orgId } = args;
  return {
    async selectTeamsMatch(orgId, now) {
      return db.match.findFirst({
        where: {
          activity: { orgId },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          attendanceDeadline: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { date: "asc" },
        select: { id: true },
      });
    },

    async forceConfirm({ matchId, userId, ref, sourceRef, actorUserId }) {
      // The row is read INSIDE the transaction and the update is
      // conditional on it not already being CONFIRMED — the shipped
      // `if (target.status !== "CONFIRMED")` guard (`route.ts:3588`),
      // kept because it is what makes this idempotent: re-running
      // "generate the teams including Ibrahim" must not write a second
      // AttendanceEvent claiming he moved when he did not.
      await db.$transaction(async (tx) => {
        const row = await tx.attendance.findUnique({
          where: { matchId_userId: { matchId, userId } },
          select: { id: true, status: true, position: true },
        });
        if (!row || row.status === "CONFIRMED") return;
        await tx.attendance.update({
          where: { id: row.id },
          data: { status: "CONFIRMED" },
        });
        await recordAttendanceEvent(
          tx,
          {
            matchId,
            userId,
            orgId,
            fromStatus: row.status,
            toStatus: "CONFIRMED",
            fromPosition: row.position,
            toPosition: row.position,
          },
          {
            cause: "admin-message",
            actorKind: "admin",
            actorUserId,
            sourceRef,
            note: `force-included in a team-generation request as "${ref}"`,
          },
        );
      });
    },

    generateTeams: (matchId, opts) => generateTeamsForMatch(matchId, opts),
  };
}

/**
 * THE UNNAMED-GUEST NAME ASK'S ONE-PER-PLAYER-PER-MATCH SLOT.
 *
 * `attendance-engine-batch.ts` calls this between `decide()` and
 * `compose()`; `pipeline/load-state.ts` reads the rows back into
 * `SquadState.guestAskedUserIds` and `pipeline/engine.ts` passes them to
 * `shouldAskForGuestName` as `alreadyAsked`.
 *
 * ── Why it is here and not in `pipeline/` ────────────────────────────
 * Same reason as everything else in this file: it is a WRITE, and
 * `pipeline/__tests__/zero-writes.test.ts` scans that directory for
 * mutations on every build.
 *
 * ── Why `create` and not `upsert` ────────────────────────────────────
 * `SentNotification.key` is `@unique`, so the database — not a
 * read-then-write in application code — decides who got the slot. A
 * loser gets a constraint violation, returns `false`, and the caller
 * drops the ask. An `upsert` would report success to both batches and
 * both would speak, which is the nagging this whole gate exists to
 * prevent. It is the same reasoning, and the same shape, as the row PR
 * #29 wrote from the route before §10 step 8 lost the writer.
 *
 * Key and kind are `guest-name-ask.ts`'s own exports, never strings
 * typed here: the reader matches on both, and a typo would be a gate
 * that silently never closes — which is exactly the bug this restores.
 */
export function buildClaimGuestNameAsk(args: { db?: Db } = {}) {
  const db = args.db ?? defaultDb;
  return async ({ matchId, userId }: { matchId: string; userId: string }): Promise<boolean> => {
    try {
      await db.sentNotification.create({
        data: {
          key: guestNameAskKey(matchId, userId),
          kind: GUEST_NAME_ASK_KIND,
          matchId,
          targetUser: userId,
        },
      });
      return true;
    } catch {
      // The unique key did its job, or the write failed. Either way this
      // batch does not have the slot and must not speak.
      return false;
    }
  };
}
