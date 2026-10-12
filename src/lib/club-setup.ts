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
 */
import { randomUUID } from "node:crypto";
import type { MatchStatus } from "@/generated/prisma/enums";
import { db } from "./db";
import { isClubApproved, servingClubWhere } from "./club-approval-state";
import { BILLING_NOT_PAUSED_WHERE, isBillingEnabled } from "./club-billing-rules";
import {
  SETTING_UP_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  hasGoneLive,
  isClubSettingUp,
  settingUpOnly,
  readingBlocksGoLive,
} from "./club-setup-rules";
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
  isGoCommand,
  isSetupLearningFinal,
  liveByOwner,
  liveByUser,
  readingBlocksGoLive,
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
  await tx.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "orgId" = ${orgId}`;
  return rows[0].inserted ? "created-closed" : "closed";
}

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
}

/** Why a club that is not a plain "setting up, in its group" cannot go live. */
function goLiveRefusal(org: GoLiveOrgRow, info: GoLiveClubInfo, billingOn: boolean): GoLiveResult | null {
  if (!isClubSettingUp(org)) {
    return isClubApproved(org) && hasGoneLive(org)
      ? { ...info, outcome: "already-live", liveAt: org.liveAt, liveBy: org.liveBy }
      : { outcome: "not-setting-up", orgId: org.id };
  }
  // TODO(setup-removal slice): NOTHING WRITES `setupRemovedAt` YET, so
  // this half of the guard never fires today (pinned by the "DEPENDENCY"
  // test in e2e/api/setup-go-live.spec.ts). That slice must:
  //   - STAMP it when MatchTime is removed from the group of a club that
  //     is setting up: POST /api/whatsapp/bot-removed
  //     (src/app/api/whatsapp/bot-removed/route.ts), a new setting-up
  //     branch beside `handleBillingRemoval` and `handleBotRemoved`;
  //   - CLEAR it when MatchTime is added back to that same group: the
  //     "live-org" branch of the group add (src/lib/group-add.ts).
  // Until then the only removal this function can see is the billing one
  // just below (a club in its free period that is removed is paused with
  // reason "removed").
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
 * Refusals change nothing: "still-reading" (owner decision 4),
 * "removed-from-group", "billing-paused", "not-setting-up".
 */
export async function goLiveClub(
  orgId: string,
  by: string,
  now: Date = new Date(),
  opts: GoLiveOptions = {},
): Promise<GoLiveResult> {
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

      // FREE PERIOD HOOK (the later money slice, S4b). The club's free
      // period is to start HERE, at go-live, not at approval: that slice
      // moves the `setBillingState(orgId, { type: "approved" })` call
      // (club-approval.ts) to this point, on `tx`, with `now` as the
      // start. Nothing is done for billing in this slice.

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
      // is set to at this instant, not at approval.
      const input = await loadHelloInput(orgId, {
        client: tx as unknown as HelloReadClient,
        organiserUserId: opts.organiserUserId ?? null,
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
