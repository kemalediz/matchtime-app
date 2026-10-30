/**
 * APPROVED BUT SETTING UP: the database half, and the ONLY module that may
 * write `Organisation.setupStage` (2026-10-12, go-live plan 2.1 and 2.2).
 * The design, the fragments and the predicates are in the pure half,
 * `club-setup-rules.ts`, re-exported here; import from this file unless
 * the caller must stay free of the database.
 *
 * The two moves:
 *
 *   pending -> approved and setting up   slice S3, inside `decideClub`'s
 *       one compare-and-set, by spreading `settingUpClubFields()`.
 *   setting up -> live                   slice S4, `goLiveClub` below: one
 *       compare-and-set on `SETTING_UP_CLUB_WHERE` that also switches the
 *       bot on and stamps `liveAt` and `liveBy`, and calls
 *       `closeUnfinishedSetupLearning` in the same transaction. `liveAt`
 *       MUST be stamped: it is what keeps the setup-learning sweep away
 *       from the club for good.
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
 *
 * ── THE LOCK ORDER FOR A CLUB'S SETUP STATE (the one place it is written) ──
 *
 * Several transactions change a club's setup state at once: the setup
 * reading applying what it read (`applyAndRecord`, setup-learning/run.ts),
 * going live (`goLiveClub`, below), the setup DM's two-hour cap and its
 * stamp (`closeReadingForGood`, `sendSetupDm`, club-setup-dm.ts), the
 * 24-hour reminder (`sendSetupReminder`, club-setup-reminder.ts), the
 * owner's suspension (`decideClub`, club-approval.ts), and the billing
 * writer (`applyBillingEventTx` and `setClubPlan`, club-billing.ts), which
 * go-live runs INSIDE its own transaction to start the free period. The
 * rule:
 *
 *   1. THE CLUB FIRST. Before any other row, the transaction locks the
 *      club's `Organisation` row FOR NO KEY UPDATE and holds it to its
 *      commit. An ordinary `UPDATE "Organisation"` takes exactly that
 *      lock, so a transaction whose first write is its compare-and-set on
 *      the club has it already (go-live, the stamp, the suspension, the
 *      approval). One whose first write is something else calls
 *      `lockClubSetup` below first (the reading's apply, the cap's close,
 *      the reminder). The billing writer takes the same lock with its own
 *      SELECT, because it reads the row it locks.
 *   2. THEN ITS OTHER ROWS, in this order where it takes more than one:
 *      the club's billing row (`ClubBilling`, FOR UPDATE: the billing
 *      writer), the reading (`ClubSetupLearning`: an UPDATE, or the INSERT
 *      ... ON CONFLICT of the two closers), then the connect rows
 *      (`ClubConnect`: clearing the stored chat). Rows it only inserts (BotJob,
 *      PlatformJob, SentNotification) and the rows of the club's own games
 *      and queued posts that go-live tidies may come anywhere after the
 *      club.
 *
 * Step 1 is what makes it safe: these transactions hold the club's row
 * from their first lock to their commit, so for one club they run ONE AT
 * A TIME, and no order of what follows can make a cycle among them. Step 2
 * is kept anyway, so that a later transaction that has good reason not to
 * take the club still cannot meet one of these the wrong way round.
 * NEVER the reverse: no transaction may hold a club's reading row or its
 * connect row and then ask for the club. (The reading once took its row
 * first; go-live took the club first; they deadlocked.)
 *
 * FOR NO KEY UPDATE, NEVER FOR UPDATE, on the club. A row that references
 * a club (a new `ClubSetupLearning`, a BotJob, a membership, a game)
 * makes Postgres take FOR KEY SHARE on the club's row to check the foreign
 * key. FOR KEY SHARE conflicts with FOR UPDATE and with nothing weaker.
 * So a plain `SELECT ... FOR UPDATE` on the club turns every insert of a
 * child row into a wait for the club, and that is a cycle the moment the
 * inserter is itself being waited for. It happened: the reading's claim
 * INSERTs its row outside any transaction (it holds the new row and waits
 * for the club's key share), while the cap's close held the club FOR
 * UPDATE and waited for that new row (its INSERT ... ON CONFLICT met the
 * uncommitted row). Postgres killed one of them, 2 runs in 20 of
 * e2e/api/setup-hold-approval.spec.ts. The billing writer's FOR UPDATE
 * made the same cycle on the go-live path, with billing on. A source
 * guard now refuses FOR UPDATE on `Organisation` anywhere in `src/`
 * (__tests__/club-setup-lock-order.test.ts). FOR NO KEY UPDATE is the weakest
 * lock that still does step 1's job: it conflicts with itself and with
 * every UPDATE of the club, and with no insert of a child row. Nothing
 * here changes a key column, so nothing here needs more.
 *
 * WHAT IS NOT IN A TRANSACTION holds one row for one statement, and so
 * can be waited for but can never be half of a cycle with these: the
 * reading's claim (its INSERT, or its retake UPDATE), every write of the
 * reading row outside `applyAndRecord`, the undo on the settings page,
 * the "no organiser" stamp, the captured-chat expiry, and every step of
 * a removal from the group and of a re-add (club-setup-removal.ts: the
 * stamp on the club first, then the DMs, then the stored chat, each its
 * own statement). ONE EXCEPTION, which follows the rule: the removal
 * queues the organiser's DM in a small transaction that takes the club
 * first (`lockClubSetup`), re-reads the stamp, and then only inserts the
 * DM, so a re-add cannot slip between "still removed" and the DM.
 *
 * A CLUB THAT IS NOT APPROVED is another world: the group add and the
 * bot's removal while pending take the connect row and then the club.
 * They never meet the transactions above, every one of which needs the
 * club approved; `decideClub` is the only step between the two, and it
 * takes the club first (approve, reject and suspend alike).
 *
 * Proved by races against a real Postgres, 200 rounds each, in
 * e2e/helpers/setup-hold-lib-tests.ts (checks 7 to 16): the reading
 * against the close, against go-live (billing off, and on), against the
 * whole cap, against a suspension, against a removal and against the
 * reminder; a removal against go-live and against the cap; a re-add
 * against the setup DM sweep; and a never-held club's reading against a
 * second reading and other writes for the club.
 */
import { randomUUID } from "node:crypto";
import type { MatchStatus } from "@/generated/prisma/enums";
import { db } from "./db";
import { clearCapturedChatForClub } from "./captured-chat";
import { isClubApproved, servingClubWhere } from "./club-approval-state";
import { loadClubFeeTip, logBillingMove, startFreePeriodAtGoLiveTx } from "./club-billing";
import { goLiveFreePeriodNote } from "./club-billing-view";
import { BILLING_NOT_PAUSED_WHERE, isBillingEnabled } from "./club-billing-rules";
import {
  SETTING_UP_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  hasGoneLive,
  isClubSettingUp,
  settingUpOnly,
  readingBlocksGoLive,
  SETUP_STATUS_SELECT,
  setupMessageState,
  setupStatusOf,
  type SetupMessageState,
  type SetupStatus,
  type SetupStatusRow,
} from "./club-setup-rules";
import { SETUP_ASK_DM_PURPOSE, setupAskRefId } from "./club-setup-dm-rules";
import { buildGroupHello } from "./group-hello";
import { loadHelloInput, type HelloReadClient } from "./group-hello-load";
import { normaliseLang } from "./i18n/lang";
import {
  PAYMENTS_LIVE_KIND,
  buildPaymentsLiveAnnouncement,
  isPaymentCollectionLive,
  paymentsLiveKey,
} from "./payments-live-announce";
import { isSetupLearningEnabled } from "./setup-learning/flag";
import { cancelSetupDm } from "./club-setup-dm-cancel";
import { queueGettingReady } from "./admin-onboarding";
import { generateUpcomingMatches } from "./generate-upcoming-matches";

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
  WENT_LIVE_CLUB_WHERE,
  STILL_READING_WINDOW_MS,
  SETUP_LEARNING_FINAL_STATUSES,
  isSetupLearningFinal,
  liveByOwner,
  liveByUser,
  readingBlocksGoLive,
  // The go-live pages (slice S5).
  SETUP_STATUS_SELECT,
  parseLiveBy,
  setupMessageState,
  setupStatusOf,
  type LiveBy,
  type SetupMessageState,
  type SetupStatus,
  type SetupStatusRow,
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
 * all is that rail's) and BEFORE the deterministic help: a sender it
 * catches has their help answered by `handleSettingUpDm` (setup-go-dm.ts),
 * on the platform channel. A sender who also belongs to a live club is not
 * caught: they carry on, and every handler below selects clubs with
 * `IN_LIVE_STAGE_CLUB_WHERE`, so they are handled for the live club only.
 * One small query.
 */
export async function settingUpClubsReason(userId: string): Promise<"club-setting-up" | null> {
  const current = await db.membership.findMany({
    where: { userId, leftAt: null, org: servingClubWhere() },
    select: { org: { select: SETUP_STAGE_SELECT } },
  });
  return settingUpOnly((current ?? []).map((m) => m.org)) ? "club-setting-up" : null;
}

/**
 * STEP 1 OF THE LOCK ORDER (see the header), for a transaction whose first
 * write is not the club's row: lock the club FOR NO KEY UPDATE until the
 * transaction ends. It waits for, and then holds off, every other writer
 * of this club's setup state, and it does not block (or wait for) anybody
 * inserting a row that references the club.
 */
export async function lockClubSetup(
  tx: { $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> },
  orgId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${orgId} FOR NO KEY UPDATE`;
}

/** What `closeUnfinishedSetupLearning` needs: `db`, or a transaction client. */
type RawClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * FOR THE GO-LIVE TRANSACTION (`goLiveClub` below calls it). Close the
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
  // The group description goes with the chat (captured-chat.ts).
  await clearCapturedChatForClub(tx, orgId);
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
 * THE WRITER OF `setupAskedAt` (`unaskCancelledSetupDm` below is the one
 * way it is ever taken back): the moment the organiser's setup DM is
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

/**
 * THE ONE OTHER WRITER OF `setupAskedAt`: the setup DM was queued, had not
 * gone, and has just been CANCELLED because MatchTime was removed from the
 * group (club-setup-removal.ts). The club was told nothing, so it is "never
 * asked" again: once MatchTime is back in the group (`clearSetupRemoved`)
 * `SETUP_DM_DUE_WHERE` matches it and the 15-minute sweep sends the DM
 * afresh, saying what is true then.
 *
 * Only for a club that is setting up AND removed, so it can never make a
 * club due while MatchTime is in its group (which could send a second DM).
 * The caller calls it only when the cancel took back a job that had not
 * been claimed: a DM that was sent, or may be on its way, keeps its stamp
 * and is never sent twice.
 */
export async function unaskCancelledSetupDm(orgId: string, client: OrgStampClient = db): Promise<boolean> {
  const { count } = await client.organisation.updateMany({
    where: { id: orgId, ...SETTING_UP_CLUB_WHERE, setupRemovedAt: { not: null }, setupAskedAt: { not: null } },
    data: { setupAskedAt: null },
  });
  return count === 1;
}

// ════ END the setup DM's stamp ════

// ════ BEGIN the setup follow-ups' reads (go-live slices S6 and S7, 2026-10-12) ════
// The 24-hour reminder (club-setup-reminder.ts) and the 72-hour note to
// the owner (club-setup-stuck.ts) read the setup columns through these, so
// the columns stay named in this one file. Nothing here writes.

/**
 * "Setting up, MatchTime still in its group, and its setup DM was due at
 * or before `cutoff`". The reminder passes now minus 24 hours. A club
 * whose setup DM was never stamped is never matched.
 */
export function settingUpAskedBy(cutoff: Date) {
  return { ...SETTING_UP_CLUB_WHERE, setupRemovedAt: null, setupAskedAt: { lte: cutoff } } as const;
}

/** Oldest setup DM first. */
export const SETUP_ASKED_ORDER = { setupAskedAt: "asc" } as const;

/** The column `setupAskedAtOf` reads. Spread into a `select`. */
export const SETUP_ASKED_SELECT = { setupAskedAt: true } as const;

/**
 * When this club's CURRENT setup DM was due, or null when it has not been
 * asked. A club that is removed from, added back and sent a new setup DM
 * has a new due time; the reminder is keyed on it, so its clock restarts.
 */
export function setupAskedAtOf(org: { setupAskedAt?: Date | null | undefined }): Date | null {
  return org.setupAskedAt ?? null;
}

/**
 * "Setting up, and approved at or before `cutoff`", in its group or not
 * (the caller reads `wasRemovedDuringSetup`). The owner's note passes now
 * minus 72 hours.
 */
export function settingUpApprovedBy(cutoff: Date) {
  return { ...SETTING_UP_CLUB_WHERE, approvedAt: { lte: cutoff } } as const;
}

/** The column `wasRemovedDuringSetup` reads. Spread into a `select`. */
export const SETUP_REMOVED_SELECT = { setupRemovedAt: true } as const;

/**
 * Was MatchTime removed from this club's group while it was setting up
 * (and not added back since)? THE ONE READER of the removal stamp outside
 * the go-live guard; the removal handling writes it.
 */
export function wasRemovedDuringSetup(org: { setupRemovedAt?: Date | null | undefined }): boolean {
  return org.setupRemovedAt !== null && org.setupRemovedAt !== undefined;
}

// ════ END the setup follow-ups' reads ════
// ════ BEGIN removed from the group while setting up (2026-10-12) ════
//
// `Organisation.setupRemovedAt`: MatchTime was taken out of the group of a
// club that is approved and still setting up. While it is set the club
// cannot go live (`goLiveRefusal`, and the go-live compare-and-set), so no
// hello is queued for a group MatchTime is not in and NO FREE PERIOD
// STARTS for it; and its setup DM is not due (`SETUP_DM_DUE_WHERE`). The
// club stays approved and setting up. THE TWO WRITERS ARE HERE; the
// handling round them (the organiser's DM, the owner's event) is
// club-setup-removal.ts.

/** A setting-up club by its group, with whether MatchTime was removed. */
export async function findSettingUpClubByGroup(
  groupId: string,
): Promise<{ id: string; name: string; language: string; removedAt: Date | null } | null> {
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, ...SETTING_UP_CLUB_WHERE },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, language: true, setupRemovedAt: true },
  });
  return org ? { id: org.id, name: org.name, language: org.language, removedAt: org.setupRemovedAt } : null;
}

/**
 * STAMP the removal. A compare-and-set on "setting up, not already
 * removed", so of two reports of the same removal exactly one gets `true`
 * and only that one tells anybody. A club that is live, or not approved,
 * is never touched.
 */
export async function markSetupRemoved(orgId: string, now: Date = new Date(), client: OrgStampClient = db): Promise<boolean> {
  const { count } = await client.organisation.updateMany({
    where: { id: orgId, ...SETTING_UP_CLUB_WHERE, setupRemovedAt: null },
    data: { setupRemovedAt: now },
  });
  return count === 1;
}

/**
 * CLEAR the removal: MatchTime is back in THE SAME group (`groupId` is
 * part of the compare-and-set, so an add to any other group can never
 * clear it). Who added it back is the caller's check.
 */
export async function clearSetupRemoved(orgId: string, groupId: string, client: OrgStampClient = db): Promise<boolean> {
  const { count } = await client.organisation.updateMany({
    where: { id: orgId, whatsappGroupId: groupId, ...SETTING_UP_CLUB_WHERE, setupRemovedAt: { not: null } },
    data: { setupRemovedAt: null },
  });
  return count === 1;
}

/** What `isSetupRemovedNow` needs: `db`, or a transaction client. */
type OrgCountClient = { organisation: { count(args: { where: object }): Promise<number> } };

/**
 * Is this club STILL setting up and removed from its group, right now? For
 * the removal handling, which reads it under the club's row lock
 * (`lockClubSetup`) immediately before it queues the organiser's "I was
 * removed, add me back" DM: a re-add that cleared the stamp a moment
 * earlier must mean no such DM.
 */
export async function isSetupRemovedNow(orgId: string, client: OrgCountClient = db): Promise<boolean> {
  return (await client.organisation.count({ where: { id: orgId, ...SETTING_UP_CLUB_WHERE, setupRemovedAt: { not: null } } })) === 1;
}

// ════ END removed from the group while setting up ════

// ── Going live (slice S4) ───────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

const GO_LIVE_TX_TIMEOUT_MS = 20_000;
const OPEN_MATCH_STATUSES: MatchStatus[] = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

const GO_LIVE_ORG_SELECT = {
  id: true,
  name: true,
  language: true,
  approvedAt: true,
  whatsappGroupId: true,
  liveAt: true,
  liveBy: true,
  setupRemovedAt: true,
  billingStatus: true,
  clubBilling: { select: { pausedReason: true } },
  ...SETUP_STAGE_SELECT,
} as const;

interface GoLiveOrgRow {
  id: string;
  name: string;
  language: string;
  approvalStatus: string;
  setupStage: string;
  approvedAt: Date | null;
  whatsappGroupId: string | null;
  liveAt: Date | null;
  liveBy: string | null;
  setupRemovedAt: Date | null;
  billingStatus: string;
  clubBilling: { pausedReason: string | null } | null;
}

/** What every outcome that names a club carries, for the reply. */
export interface GoLiveClubInfo {
  orgId: string;
  club: string;
  /** The WhatsApp group's own name when MatchTime knows it, else the club's. */
  group: string;
  language: string;
}

export type GoLiveResult =
  /** The club is live: the bot is on and the hello is queued for the group. */
  | (GoLiveClubInfo & {
      outcome: "went-live";
      liveAt: Date;
      liveBy: string;
      /** The hello, exactly as queued. */
      hello: string;
      purgedJobs: number;
      quietedMatches: number;
      /** The club's free period started with this go-live (billing on, plan
       *  not Free, none had before). */
      freePeriodStarted: boolean;
      /**
       * What the organiser is told about it, in the club's language: the
       * free period sentence and the club fee tip paragraph
       * (`goLiveFreePeriodNote`). The WhatsApp reply appends it to "Done";
       * the Go live button's result carries it for the page to show. Null
       * when no free period started.
       */
      freePeriodNote: string | null;
    })
  /** Somebody already took it live (the loser of a race lands here too). */
  | (GoLiveClubInfo & { outcome: "already-live"; liveAt: Date | null; liveBy: string | null })
  /** MatchTime was removed from the group while the club was setting up. */
  | (GoLiveClubInfo & { outcome: "removed-from-group" })
  /** The setup reading has not finished (owner decision 4). */
  | (GoLiveClubInfo & { outcome: "still-reading" })
  /** The club is paused for the club fee (not because it was removed from
   *  its group: that is "removed-from-group"). Nothing would be delivered. */
  | (GoLiveClubInfo & { outcome: "billing-paused" })
  /** Not approved, never held, or no such club. Nothing to do. */
  | { outcome: "not-setting-up"; orgId: string };

export interface GoLiveOptions {
  /** SETUP_LEARNING_ENABLED as the caller reads it (a route passes its
   *  per-request value). Default: the environment. */
  learningEnabled?: boolean;
  /** Who the hello names. Default: whoever connected the club, else its owner. */
  organiserUserId?: string | null;
  /** BILLING_ENABLED as the caller reads it. Default: the environment. */
  billingEnabled?: boolean;
  /**
   * Go live even while the setup reading is unfinished (slice S5, owner
   * decision 7). ONLY the MatchTime owner's "Go live now" on /admin/clubs
   * sets it (`ownerGoLiveNowAction`): the organiser's button and the GO DM
   * keep the "still reading" block (owner decision 4). The reading is
   * closed in the same transaction as always, so it can never apply
   * afterwards. Every other refusal still stands.
   */
  skipReadingCheck?: boolean;
}

/** Why a club that is not a plain "setting up, in its group" cannot go live. */
function goLiveRefusal(org: GoLiveOrgRow, info: GoLiveClubInfo, billingOn: boolean): GoLiveResult | null {
  if (!isClubSettingUp(org)) {
    return isClubApproved(org) && hasGoneLive(org)
      ? { ...info, outcome: "already-live", liveAt: org.liveAt, liveBy: org.liveBy }
      : { outcome: "not-setting-up", orgId: org.id };
  }
  // Removed from its group while setting up (`markSetupRemoved`, stamped
  // by POST /api/whatsapp/bot-removed; cleared by `clearSetupRemoved` when
  // a member of the club adds MatchTime back to the same group): no hello
  // for a group MatchTime is not in, and no free period for it. Every
  // door ends here: GO by DM, the Go live button, the owner's Go live now.
  if (org.setupRemovedAt || !org.whatsappGroupId) return { ...info, outcome: "removed-from-group" };
  // Paused for the club fee (PR #234 review, fix 2). due-posts refuses a
  // paused club, and the resume marks every due unsent job as sent, so a
  // hello queued now would be lost for good, with the intro key already
  // spent. Going live waits until the club is served again.
  if (billingOn && org.billingStatus === "paused") {
    return org.clubBilling?.pausedReason === "removed"
      ? { ...info, outcome: "removed-from-group" }
      : { ...info, outcome: "billing-paused" };
  }
  return null;
}

async function readGoLiveOrg(
  tx: Tx,
  orgId: string,
): Promise<{ org: GoLiveOrgRow; info: GoLiveClubInfo; connected: boolean } | null> {
  const org = (await tx.organisation.findUnique({ where: { id: orgId }, select: GO_LIVE_ORG_SELECT })) as GoLiveOrgRow | null;
  if (!org) return null;
  const link = await tx.clubConnect.findFirst({
    where: { orgId, linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { groupSubject: true },
  });
  return {
    org,
    info: { orgId, club: org.name, group: link?.groupSubject?.trim() || org.name, language: org.language },
    connected: !!link,
  };
}

/**
 * No catch-up after go-live (the rule `resumeClubTx` in club-billing.ts
 * applies after a pause). The crons generate and complete a setting-up
 * club's fixtures like anybody's, so at the first poll after GO a game
 * that kicked off BEFORE go-live would otherwise get its score ask,
 * payment poll, fee ask, unpaid reminders, rating DMs, Man of the Match
 * and badges. Every such match is completed and quieted, its score ask is
 * marked sent, and its pick rounds and bench offers are closed. A game
 * still to come is untouched.
 */
async function quietMatchesBeforeGoLive(tx: Tx, orgId: string, now: Date): Promise<number> {
  const stale = await tx.match.findMany({
    where: {
      activity: { orgId },
      date: { lte: now },
      OR: [{ status: { in: OPEN_MATCH_STATUSES } }, { status: "COMPLETED", postMatchEndFlow: true }],
    },
    select: { id: true },
  });
  let quieted = 0;
  if (stale.length > 0) {
    const res = await tx.match.updateMany({
      where: { id: { in: stale.map((m) => m.id) }, status: { in: [...OPEN_MATCH_STATUSES, "COMPLETED"] } },
      data: { status: "COMPLETED", postMatchEndFlow: false },
    });
    quieted = res.count;
  }
  // The score ask is keyed on the clock alone, so it is claimed for every
  // match that has kicked off, quieted just now or not.
  const kickedOff = await tx.match.findMany({ where: { activity: { orgId }, date: { lte: now } }, select: { id: true } });
  if (kickedOff.length > 0) {
    await tx.sentNotification.createMany({
      data: kickedOff.map((m) => ({ key: `${m.id}:ask-score`, kind: "go-live-skip", matchId: m.id })),
      skipDuplicates: true,
    });
  }
  await tx.organiserPickRound.updateMany({
    where: { orgId, resolvedAt: null, match: { date: { lte: now } } },
    data: { resolvedAt: now, outcome: "closed-at-kickoff" },
  });
  await tx.benchSlotOffer.updateMany({
    where: { resolvedAt: null, match: { activity: { orgId }, date: { lte: now } } },
    data: { resolvedAt: now, outcome: "closed-at-kickoff" },
  });
  return quieted;
}

/**
 * Payments switched on while the club was setting up were never announced
 * (`announcePaymentsLiveIfJustLive` says nothing while the bot is off, and
 * afterwards the club "was already live"). The hello is that announcement
 * when it carries the pay-link line, so the ledger key is claimed here and
 * a later toggle can never post it late. When the hello has no such line
 * (a monthly club, or one with card and bank both off) the announcement
 * itself is queued, once, straight after the hello.
 */
async function settlePaymentsAnnouncement(
  tx: Tx,
  orgId: string,
  hello: { lang: string; coversPayLinks: boolean },
  now: Date,
): Promise<void> {
  const pay = await tx.organisation.findUnique({
    where: { id: orgId },
    select: {
      paymentCollectionEnabled: true,
      stripeConnectAccountId: true,
      stripeChargesEnabled: true,
      payMethodCard: true,
      payMethodPayByBank: true,
      payMethodDirect: true,
      paymentHolderId: true,
    },
  });
  if (!pay || !isPaymentCollectionLive(pay)) return;
  const claimed = await tx.sentNotification.createMany({
    data: [{ key: paymentsLiveKey(orgId, pay.stripeConnectAccountId!), kind: PAYMENTS_LIVE_KIND }],
    skipDuplicates: true,
  });
  if (hello.coversPayLinks || claimed.count !== 1) return;
  const holder = pay.paymentHolderId
    ? await tx.user.findUnique({ where: { id: pay.paymentHolderId }, select: { name: true } })
    : null;
  await tx.botJob.create({
    data: {
      orgId,
      kind: "group",
      text: buildPaymentsLiveAnnouncement({
        lang: normaliseLang(hello.lang),
        collector: (holder?.name ?? "").trim().split(/\s+/)[0] || null,
        card: pay.payMethodCard,
        bank: pay.payMethodPayByBank,
        direct: pay.payMethodDirect,
      }),
      // After the hello, whatever order the rows were written in.
      createdAt: new Date(now.getTime() + 1),
    },
  });
}

/**
 * SETTING UP -> LIVE. The only way a held club starts speaking, for every
 * door: the organiser's GO by WhatsApp, the Go live button on the settings
 * page, and the MatchTime owner's "Go live now".
 *
 * ONE transaction around ONE compare-and-set on
 * { id, approved, setting up, not removed from its group }. With it:
 *   - the stage is live, the bot is on, `liveAt` and `liveBy` are stamped
 *     (`by`: `liveByUser` for the club's own owner or admin, by WhatsApp
 *     or on the website, or `liveByOwner` for the MatchTime owner);
 *   - every unsent BotJob queued while the club was setting up is DELETED.
 *     Website actions (a player tapping In, a cancelled game, a format
 *     switch) and help replies queue posts and DMs that would otherwise
 *     all go out on the first poll after the bot comes on;
 *   - fixtures that kicked off before go-live are quieted
 *     (`quietMatchesBeforeGoLive`);
 *   - the setup reading is closed (`closeUnfinishedSetupLearning`);
 *   - the hello is built from the settings AS THEY ARE INSIDE this
 *     transaction and queued for the group, and the scheduler's older
 *     intro key is claimed so it never follows;
 *   - the payments announcement is settled (`settlePaymentsAnnouncement`).
 *
 * Two calls at the same instant: the second blocks on the row, finds the
 * stage no longer matches, and returns "already-live" with the winner's
 * `liveAt` and `liveBy`. It queues nothing.
 *
 * Refusals change nothing: "still-reading" (owner decision 4; never
 * returned with `skipReadingCheck`, the MatchTime owner's door),
 * "removed-from-group", "billing-paused", "not-setting-up".
 *
 * AFTER the transaction has committed, and only when this call took the
 * club live: when its free period started with it, `freePeriodNote` is
 * built (the free period sentence and the club fee tip) for the reply and
 * the page; and the organiser's setup DM is cancelled if it is still waiting
 * (`cancelSetupDm`: a DM queued at night is held for 09:00 London, and
 * "reply GO" would be false by then); and the club's upcoming games are
 * made by the nightly cron's own generator (`generateUpcomingMatches`,
 * 2026-10-15), so a pasted squad has a game to go on at once. Here, in the one function every
 * door goes through, so no door can forget it. A failure is logged and
 * never undoes the go-live.
 *
 * LOCK ORDER (the header of this file): the club's row (its
 * compare-and-set is the transaction's first write), then the reading row
 * and the connect rows (`closeUnfinishedSetupLearning`), then inserts.
 */
export async function goLiveClub(
  orgId: string,
  by: string,
  now: Date = new Date(),
  opts: GoLiveOptions = {},
): Promise<GoLiveResult> {
  const result = await goLiveClubTx(orgId, by, now, opts);
  if (result.outcome === "went-live") {
    try {
      await cancelSetupDm(orgId, "went-live", now);
    } catch (err) {
      console.error(`[club-setup] ${orgId}: live, but its waiting setup DM was NOT cancelled: ${(err as Error)?.name ?? "error"}`);
    }
    // The club's upcoming games, NOW (2026-10-15). Until then only the
    // nightly cron (00:00 UTC) made them, so a club that went live in the
    // evening had no game until after midnight: FNF's organiser pasted the
    // squad at 22:13 and got no reply. The cron's own generator, for this
    // club only: the same slot dedupe (a game the cron already made while
    // the club was setting up is not made twice) and the same skips.
    // After the commit, so a failure here never undoes the go-live; the
    // cron makes the game that night as before.
    try {
      const gen = await generateUpcomingMatches({ orgId, now });
      if (gen.created > 0) console.log(`[club-setup] ${orgId}: live, ${gen.created} upcoming game(s) made`);
    } catch (err) {
      console.error(`[club-setup] ${orgId}: live, but its upcoming games were NOT made (the nightly cron will): ${(err as Error)?.name ?? "error"}`);
    }
    // After the games are made, so its paste line knows whether this
    // week's game exists yet.
    // "Getting <club> ready" for the admins (2026-10-15,
    // admin-onboarding-rules.ts): AFTER the commit, so the go-live purge
    // above never deletes it. Once per club; never throws.
    await queueGettingReady(orgId, now);
    if (result.freePeriodStarted) {
      // Committed: only now is the billing move a fact worth a log line.
      logBillingMove(orgId, "went-live", { from: "exempt", to: "trial" });
      // What the organiser is told about the free period that has just
      // started: the sentence and the club fee tip, from the same numbers
      // the approval's "you're live" DM uses. A failure to read the
      // numbers costs the tip paragraph, never the go-live.
      let tip: Awaited<ReturnType<typeof loadClubFeeTip>> = null;
      try {
        tip = await loadClubFeeTip(orgId);
      } catch (err) {
        console.error(`[club-setup] ${orgId}: live and in its free period, but the club fee tip could not be read: ${(err as Error)?.name ?? "error"}`);
      }
      return { ...result, freePeriodNote: goLiveFreePeriodNote(result.language, tip) };
    }
  }
  return result;
}

/** The go-live transaction itself. Only `goLiveClub` calls it. */
async function goLiveClubTx(orgId: string, by: string, now: Date, opts: GoLiveOptions): Promise<GoLiveResult> {
  const learningEnabled = opts.learningEnabled ?? isSetupLearningEnabled();
  const billingOn = opts.billingEnabled ?? isBillingEnabled();
  return db.$transaction(
    async (tx): Promise<GoLiveResult> => {
      const read = await readGoLiveOrg(tx, orgId);
      if (!read) return { outcome: "not-setting-up", orgId };
      const refusal = goLiveRefusal(read.org, read.info, billingOn);
      if (refusal) return refusal;

      const learning = await tx.clubSetupLearning.findUnique({ where: { orgId }, select: { status: true } });
      if (
        !opts.skipReadingCheck &&
        readingBlocksGoLive({
          learningEnabled,
          learningStatus: learning?.status ?? null,
          readingExpected: read.connected,
          approvedAt: read.org.approvedAt,
          now,
        })
      ) {
        return { ...read.info, outcome: "still-reading" };
      }

      // The compare-and-set. Bot on and stage live in ONE write: the CHECK
      // constraint refuses the bot on a club that is still setting up.
      const { count } = await tx.organisation.updateMany({
        where: { id: orgId, ...SETTING_UP_CLUB_WHERE, setupRemovedAt: null, ...(billingOn ? BILLING_NOT_PAUSED_WHERE : {}) },
        data: { setupStage: "live", whatsappBotEnabled: true, liveAt: now, liveBy: by },
      });
      if (count !== 1) {
        // Lost a race: somebody went live, or the club was removed, paused
        // or suspended, between the read above and this write.
        const after = await readGoLiveOrg(tx, orgId);
        return (after && goLiveRefusal(after.org, after.info, billingOn)) ?? { outcome: "not-setting-up", orgId };
      }

      // FREE PERIOD HOOK (the money slice, S4b; owner decision 2). The
      // club's two free months start HERE, at go-live, not at approval: it
      // was silent in its group until this write. On `tx`, so the go-live
      // and the start commit together or not at all (a failure here rolls
      // the go-live back and the organiser's GO can simply be said again),
      // and the window runs from `now`, which is the `liveAt` just
      // stamped. Once per club: a club whose free period an approval had
      // already started is left exactly as it is. With billing off nothing
      // starts, as at an approval.
      const freePeriod = billingOn ? await startFreePeriodAtGoLiveTx(tx, orgId, now) : { started: false };

      // THE PURGE RUNS UNDER THE CLUB'S ROW LOCK (PR #234 review, fix 8).
      // The compare-and-set above is the transaction's first WRITE, so
      // from there to the commit this transaction holds the club's row
      // lock: no second go-live, and no other write to the club, can
      // interleave. What the lock does NOT cover is a BotJob insert, which
      // never touches the club's row; `SELECT ... FOR UPDATE` on the club
      // would not either. A job another transaction commits after this
      // statement and before our commit therefore survives. That is the
      // right outcome, not a leak: it was queued by an action taken while
      // the club was going live, and is no different from one taken a
      // millisecond after the commit. Everything queued BEFORE the GO was
      // committed before this statement ran, and is deleted here.
      const purged = await tx.botJob.deleteMany({ where: { orgId, sentAt: null } });
      const quietedMatches = await quietMatchesBeforeGoLive(tx, orgId, now);
      await closeUnfinishedSetupLearning(orgId, tx, now);

      // The hello: read INSIDE the transaction, so it says what the club
      // is set to at this instant, not at approval. `now` is the go-live
      // instant: a rolling club's hello asks whether the seeding will have
      // a squad to carry, and reads the fixtures as they stand after the
      // quieting just above.
      const input = await loadHelloInput(orgId, {
        client: tx as unknown as HelloReadClient,
        organiserUserId: opts.organiserUserId ?? null,
        now,
      });
      const hello = buildGroupHello(input);
      await tx.botJob.create({ data: { orgId, kind: "group", text: hello, createdAt: now } });
      // The hello IS this group's introduction: claim the scheduler's older
      // one-time intro, exactly as `decideClub` does.
      await tx.sentNotification.upsert({
        where: { key: `org-${orgId}:bot-intro` },
        create: { key: `org-${orgId}:bot-intro`, kind: "bot-intro" },
        update: {},
      });
      await settlePaymentsAnnouncement(
        tx,
        orgId,
        { lang: input.lang, coversPayLinks: input.settings.squadMode !== "monthly" && input.settings.payLinks !== "off" },
        now,
      );

      console.log(
        `[club-setup] ${orgId} went live by ${by}: purged ${purged.count} queued job(s), quieted ${quietedMatches} match(es)`,
      );
      return {
        ...read.info,
        outcome: "went-live",
        freePeriodStarted: freePeriod.started,
        // Filled in by `goLiveClub`, after the commit.
        freePeriodNote: null,
        liveAt: now,
        liveBy: by,
        hello,
        purgedJobs: purged.count,
        quietedMatches,
      };
    },
    { timeout: GO_LIVE_TX_TIMEOUT_MS },
  );
}

/**
 * The hello a club's group would get if it went live now, for the Go live
 * banner's preview. `goLiveClub` builds the real one the same way, from
 * the settings at that instant, so a setting changed in between changes
 * the hello too.
 */
export async function helloPreviewForClub(
  orgId: string,
  opts: { organiserUserId?: string | null } = {},
): Promise<string> {
  return buildGroupHello(await loadHelloInput(orgId, { organiserUserId: opts.organiserUserId ?? null }));
}

// ════ BEGIN the go-live pages (slice S5, 2026-10-12) ════
// Read-only loaders for /admin/settings, the club's admin home and
// /admin/clubs. The pure status is `setupStatusOf` (club-setup-rules.ts).

/**
 * One club's setup for its own owner and admins: what the Go live banner
 * needs and nothing else. NO PERSON IS IN IT (review of PR #236, fix 5):
 * no user id, name, phone or email. Who took a club live is worded by
 * `goLiveClubAction`, for the one person who pressed the button.
 */
export interface ClubSetupView {
  settingUp: boolean;
  removedFromGroup: boolean;
  /** The WhatsApp group's own name when MatchTime knows it. Null unless setting up. */
  group: string | null;
}

/**
 * One query for a club that is not setting up (every club today); the
 * group's name is looked up only for one that is (fix 7).
 */
export async function loadClubSetupView(
  orgId: string,
  opts: { billingEnabled?: boolean } = {},
): Promise<ClubSetupView | null> {
  const row = (await db.organisation.findUnique({ where: { id: orgId }, select: SETUP_STATUS_SELECT })) as SetupStatusRow | null;
  if (!row) return null;
  const status = setupStatusOf(row, { billingOn: opts.billingEnabled ?? isBillingEnabled() });
  if (!status.settingUp) return { settingUp: false, removedFromGroup: false, group: null };
  const link = await db.clubConnect.findFirst({
    where: { orgId, linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { groupSubject: true },
  });
  return { settingUp: true, removedFromGroup: status.removedFromGroup, group: link?.groupSubject?.trim() || null };
}

/** A club's status for the owner's clubs page, with its setup DM's real state. */
export type OwnerSetupStatus = SetupStatus & { setupMessage: SetupMessageState };

/**
 * The status of several clubs for the owner's clubs page: one query for
 * the clubs, and one for the setup DMs of those that are setting up (the
 * job's own status says whether it was sent; the club's stamp is only when
 * it is due).
 */
export async function loadSetupStatuses(
  orgIds: string[],
  opts: { billingEnabled?: boolean; now?: Date } = {},
): Promise<Map<string, OwnerSetupStatus>> {
  const out = new Map<string, OwnerSetupStatus>();
  if (orgIds.length === 0) return out;
  const billingOn = opts.billingEnabled ?? isBillingEnabled();
  const now = opts.now ?? new Date();
  const rows = (await db.organisation.findMany({
    where: { id: { in: orgIds } },
    select: SETUP_STATUS_SELECT,
  })) as Array<SetupStatusRow & { id: string }>;
  const statuses = rows.map((row) => ({ id: row.id, status: setupStatusOf(row, { billingOn }) }));
  const held = statuses.filter((r) => r.status.settingUp).map((r) => r.id);
  const jobs = held.length
    ? await db.platformJob.findMany({
        where: { purpose: SETUP_ASK_DM_PURPOSE, refId: { in: held.map(setupAskRefId) } },
        orderBy: { createdAt: "asc" },
        select: { refId: true, status: true, sentAt: true },
      })
    : [];
  // The latest job per club wins (rows are oldest first).
  const jobOf = new Map(jobs.map((j) => [j.refId, j]));
  for (const { id, status } of statuses) {
    out.set(id, {
      ...status,
      setupMessage: status.settingUp
        ? setupMessageState(status.setupMessageSentAt, jobOf.get(setupAskRefId(id)) ?? null, now)
        : { kind: "none", at: null },
    });
  }
  return out;
}
// ════ END the go-live pages ════
