/**
 * APPROVED BUT SETTING UP: the database half, and the ONLY module that may
 * write `Organisation.setupStage` (2026-10-12, go-live plan 2.1 and 2.2).
 * The design, the fragments and the predicates are in the pure half,
 * `club-setup-rules.ts`, re-exported here; import from this file unless
 * the caller must stay free of the database.
 *
 * Slice S1 builds the rails, not the flow. Nothing here moves a club yet:
 *
 *   pending -> approved and setting up   slice S3, inside `decideClub`'s
 *       one compare-and-set, by spreading `settingUpClubFields()`.
 *   setting up -> live                   slice S4, `goLiveClub`, which
 *       belongs in THIS file: one compare-and-set on
 *       `SETTING_UP_CLUB_WHERE` that also switches the bot on and stamps
 *       `liveAt` and `liveBy`, and calls `closeUnfinishedSetupLearning`
 *       (below) in the same transaction. `liveAt` MUST be stamped: it is
 *       what keeps the setup-learning sweep away from the club for good.
 *
 * What keeps a setting-up club silent, and where each rail lives:
 *   - the CHECK constraint (prisma/sql/org-setup-check.sql): the bot is
 *     never on, so analyze, due-posts, the scheduler, group-join,
 *     group-leave, sync-participants and the Pi's monitored set are all
 *     blind to it;
 *   - `loadSilentGroupIds` (club-approval.ts): its group is SILENT, so the
 *     Pi drops its messages, the in-group setup can never start there, and
 *     MatchTime's removal from it is still reported;
 *   - `aiAllowanceUsd` (ai-budget.ts): $0, except the one setup reading;
 *   - `settingUpClubsReason` below: a DM from its organiser stops before
 *     any model path; and for someone who is also in a live club, every
 *     club pick in the DM path spreads `IN_LIVE_STAGE_CLUB_WHERE`, so the
 *     setting-up club is never the one chosen;
 *   - `linkAdminGroup` (admin-group-link.ts): no reply in its players'
 *     group.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { servingClubWhere } from "./club-approval-state";
import { SETTING_UP_CLUB_WHERE, SETUP_STAGE_SELECT, settingUpOnly } from "./club-setup-rules";

export {
  SETTING_UP_CLUB_WHERE,
  LIVE_STAGE_WHERE,
  IN_LIVE_STAGE_CLUB_WHERE,
  NEVER_HELD_WHERE,
  SETUP_READABLE_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  isSetupHoldEnabled,
  isClubSettingUp,
  hasGoneLive,
  preferLiveClubs,
  settingUpClubFields,
  settingUpOnly,
  type SetupStageColumns,
} from "./club-setup-rules";

/**
 * The dm-reply rail (go-live plan 2.2 point 4): is every club MatchTime
 * serves for this DM sender still setting up? "club-setting-up" means the
 * DM must go nowhere near a model path (the admin-command classifier, Q&A,
 * ...). null means carry on.
 *
 * It reads the sender's CURRENT memberships itself (`leftAt` null). The
 * route's own list also holds clubs the person has left, and a live club
 * somebody left must not shield them: a person who left Sutton FC and is
 * now only in a setting-up club is caught (review of PR #232, fix 2).
 *
 * Call it AFTER `nonServingClubsReason` (a sender with no served club at
 * all is that rail's) and after the deterministic help. A sender who also
 * belongs to a live club is not caught: they carry on, and every handler
 * below selects clubs with `IN_LIVE_STAGE_CLUB_WHERE`, so they are
 * handled for the live club only. One small query.
 */
export async function settingUpClubsReason(userId: string): Promise<"club-setting-up" | null> {
  const current = await db.membership.findMany({
    where: { userId, leftAt: null, org: servingClubWhere() },
    select: { org: { select: SETUP_STAGE_SELECT } },
  });
  return settingUpOnly((current ?? []).map((m) => m.org)) ? "club-setting-up" : null;
}

/** What `closeUnfinishedSetupLearning` needs: `db`, or a transaction client. */
type RawClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * FOR THE GO-LIVE TRANSACTION (slice S4; nothing calls it yet). Close the
 * club's setup reading for good, so no sweep can ever apply one after the
 * hello has gone out:
 *
 *   "closed"          an unfinished row (running, deferred) is now
 *                     "skipped", reason "went-live";
 *   "created-closed"  the club had no row: a final one now exists, so the
 *                     sweep's "not read yet" can never match it;
 *   "already-final"   the reading had finished: left exactly as it was.
 *
 * ONE statement, with no error to catch: inside an interactive transaction
 * a caught unique violation would still have aborted the transaction. On
 * the first two outcomes the stored chat is deleted as well, as it is
 * after any final outcome. Throws only when the database does, which rolls
 * the caller's transaction back.
 *
 * Belt and braces with the sweep's own rule: the sweep never selects, and
 * `learnClubSetup` never reads, a club whose `liveAt` is set. A reading
 * still in flight at go-live may write its record over this row
 * afterwards; its settings write is refused by the stage compare-and-set,
 * so that record says "nothing applied".
 */
export async function closeUnfinishedSetupLearning(
  orgId: string,
  tx: RawClient,
  now: Date = new Date(),
): Promise<"closed" | "created-closed" | "already-final"> {
  const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
    INSERT INTO "ClubSetupLearning" ("id", "orgId", "status", "reason", "updatedAt")
    VALUES (${`csl-${randomUUID()}`}, ${orgId}, 'skipped', 'went-live', ${now})
    ON CONFLICT ("orgId") DO UPDATE SET
      "status" = 'skipped',
      "reason" = 'went-live',
      "updatedAt" = ${now}
    WHERE "ClubSetupLearning"."status" IN ('running', 'deferred')
    RETURNING (xmax = 0) AS "inserted"`;
  if (rows.length === 0) return "already-final";
  await tx.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "orgId" = ${orgId}`;
  return rows[0].inserted ? "created-closed" : "closed";
}

// ════ BEGIN the setup DM's stamp (go-live slice S3, 2026-10-12) ════

/**
 * "This club's setup DM is due": approved, setting up, never asked, and
 * MatchTime still in its group (a club it was removed from during setup
 * is not told "I'm in your group"). The reading's state is the caller's
 * to add (club-setup-dm.ts).
 */
export const SETUP_DM_DUE_WHERE = { ...SETTING_UP_CLUB_WHERE, setupAskedAt: null, setupRemovedAt: null } as const;

/** What `markSetupAsked` needs: `db`, or a transaction client. */
type OrgStampClient = {
  organisation: { updateMany(args: { where: object; data: object }): Promise<{ count: number }> };
};

/**
 * THE ONE WRITER OF `setupAskedAt`: the moment the organiser's setup DM is
 * due (now, or the next 09:00 London for a night run). It is the clock the
 * 24-hour reminder runs on (slice S6).
 *
 * A compare-and-set on `SETUP_DM_DUE_WHERE`, so it is also the claim that
 * makes the setup DM once per club: of two runs racing (two crons, or the
 * cron and the run that follows an approval) exactly one gets `true`, and
 * only that one queues the DM, in the same transaction. Postgres makes the
 * second writer wait for the first one's row lock and then re-checks the
 * WHERE, which no longer matches.
 */
export async function markSetupAsked(orgId: string, dueAt: Date, client: OrgStampClient = db): Promise<boolean> {
  const { count } = await client.organisation.updateMany({
    where: { id: orgId, ...SETUP_DM_DUE_WHERE },
    data: { setupAskedAt: dueAt },
  });
  return count === 1;
}

// ════ END the setup DM's stamp ════
