/**
 * THE ORGANISER'S ONE SETUP DM: the database half (go-live slice S3,
 * 2026-10-12; go-live plan 2.3 and 2.4). The words are in the pure half,
 * `club-setup-dm-rules.ts`.
 *
 * A club approved while SETUP_HOLD_ENABLED is on is approved and SETTING
 * UP: silent in its group until its organiser says GO. This module tells
 * the organiser so, once:
 *
 *   WHEN   as soon as the reading of the group's chat reaches a final
 *          status (applied, nothing found, skipped for a short history,
 *          failed after its retries); at once when SETUP_LEARNING_ENABLED
 *          is off (there is no reading to wait for); and in any case TWO
 *          HOURS after the approval (the cap, below).
 *   WHAT   `composeSetupAskDm`: approved and quiet until you say so, what
 *          the reading found, the settings link, the weekly game and the
 *          starting ratings, the GO line, and (only when going live will
 *          start one) the free period. It REPLACES
 *          today's "you're live" DM and the separate findings DM
 *          ("setup-learned"), which a held club is never sent. It is
 *          composed from the club AS IT IS at that moment: a setting the
 *          organiser has undone or changed since the reading is not
 *          reported as on.
 *   HOURS  09:00 to 23:00 London (`messageHoursSendAfter`); a night run
 *          is queued for the next 09:00. `cancelSetupDm`
 *          (club-setup-dm-cancel.ts) takes a waiting one back when the
 *          club is suspended, removed or goes live first.
 *   ONCE   see "At most one" below.
 *
 * WHO RUNS IT. Two callers, the same code:
 *   - `runSetupAfterApproval(orgId)`: scheduled with `after()` by both
 *     approval entry points (club-setup-schedule.ts), so the organiser
 *     hears within moments of the approval. It reads that one club's chat
 *     (one model call at most) and then sends its DM.
 *   - `runSetupDmSweep()`: the 15-minute learn-setup cron, after its
 *     reading sweep. The retry: a reading that was deferred, a run that
 *     died, a server that never ran the `after()` callback; and the cap.
 *
 * KEYED ON THE CLUB'S STATE, NOT ON THE FLAG, like every other setup
 * rail: a club that is setting up and has not been asked gets its DM
 * whatever SETUP_HOLD_ENABLED says now. With no club in that state (the
 * flag has never been on) the sweep is one query that finds nothing.
 *
 * AT MOST ONE DM PER CLUB. `markSetupAsked` (club-setup.ts) is a
 * compare-and-set on "setting up, never asked", and the PlatformJob is
 * created in the SAME transaction. Two runs that both read the club as
 * due (two crons, or a cron and an `after()` run) both reach that write;
 * the database lets one through, the other gets a count of 0 and queues
 * nothing. If the transaction fails after the stamp, both roll back and
 * a later sweep sends it. `setupAskedAt` is the DM's due time: the clock
 * the 24-hour reminder runs on (slice S6).
 *
 * THE 2-HOUR CAP (`STILL_READING_WINDOW_MS`, club-setup-rules.ts: the
 * same constant that makes GO answer "still reading", so that answer's
 * "when I've finished I'll send the setup message" is kept: within two
 * hours of the approval, in the daytime). A reading can fail to reach a
 * final status for ever: a run cut off on its last attempt leaves the row
 * "running" with nothing allowed to retake it, and a "deferred" row whose
 * club has left the reading sweep's 3-day window is never selected again.
 * So when a held club's reading is not final two hours after its approval,
 * the reading is CLOSED FOR GOOD ("skipped", reason "timed-out"), the
 * stored chat is deleted, and the DM goes with the "couldn't read" line.
 *
 * CLOSING A READING FOR GOOD (`closeReadingForGood`) is the same single
 * statement as `closeUnfinishedSetupLearning` (club-setup.ts) with its own
 * reason: a compare-and-set on "not final", so a reading that finished a
 * moment earlier is left exactly as it was, and is then what the DM
 * reports. It is closed for good because the reading itself refuses to
 * write a row it no longer holds (setup-learning/run.ts: its settings
 * write and its record are one transaction that first locks the row on
 * status "running"). THE LOCK ORDER is written once, at the top of
 * club-setup.ts: the club's row (FOR NO KEY UPDATE), then the reading
 * row, then the connect rows. The close here follows it (`lockClubSetup`
 * first), and so does the stamp (its compare-and-set on the club is its
 * transaction's first write; it then only inserts the DM).
 *
 * Also used when the DM goes with the reading switched OFF (reason
 * "reading-off"): without it, switching the reading on a day later would
 * change the club's settings behind a DM that said "standard setup".
 *
 * WHAT CANNOT BE SENT IS SHOWN TO THE OWNER, ONCE, AND NOT RETRIED. The
 * platform channel refusing the organiser's number, or a club with no
 * organiser on record, is a fact about the data, not a failure to retry:
 * the club is stamped (so no sweep comes back to it every 15 minutes) and
 * one ops event (`SETUP_ALERT_KIND`, on /admin/health) names the club and
 * a reason code. Nothing else shows such a club today.
 *
 * LOGS carry the club's id and reason codes only: never its name, a phone
 * number, the message text or a link.
 *
 * THE ADMIN GROUP STEP (go-live slice S7, owner decisions 6 and 10). A
 * club with no admin group linked gets one more block in the DM ("add me
 * to your organisers' group, then tag me there with the code in my next
 * message") and a SECOND platform DM straight after it: exactly the code,
 * so it can be copied whole (2026-10-30: the link needs a real tag). Both jobs are created in the claim's own
 * transaction, with the same due time, and the second is ordered after
 * the first (`createdAt`, one millisecond apart: dispatch is oldest
 * first). So it is sent at most once per club for the same reason the
 * setup DM is, and never without it. The code is minted INSIDE that
 * transaction, after the claim is won (a run that loses the race must not
 * replace the code the winner sends), and lasts 7 days from the DM's due
 * time. A club that already has an admin group gets neither the block nor
 * the second message. `cancelSetupDm` takes both back together.
 *
 * NOT HERE: the reminder at 24 hours (club-setup-reminder.ts), GO
 * (setup-go-dm.ts).
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { ADMIN_GROUP_DM_CODE_TTL_MS } from "./admin-channel-rules";
import { createAdminGroupLinkCode, type AdminGroupCodeClient } from "./admin-group-link";
import { appUrl, buildAdminLink } from "./admin-link";
import {
  SETUP_DM_DUE_WHERE,
  SETUP_LEARNING_FINAL_STATUSES,
  STILL_READING_WINDOW_MS,
  isSetupLearningFinal,
  lockClubSetup,
  markSetupAsked,
} from "./club-setup";
import { freePeriodCanStart } from "./club-billing-rules";
import { loadHasSquadToCarry, type HelloReadClient } from "./group-hello-load";
import { messageHoursSendAfter } from "./message-hours";
import { SETUP_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { PlatformDmRefused, queuePlatformDm, type PlatformDmClient } from "./platform-jobs";
import type { PipelineModel } from "./pipeline/llm";
import { clearCapturedChatForClub } from "./captured-chat";
import {
  SETUP_ADMIN_CODE_DM_PURPOSE,
  composeSetupAdminCommandDm,
  setupAdminCodeRefId,
  setupAdminGroupBlock,
} from "./club-setup-followup-rules";
import { isSetupLearningEnabled } from "./setup-learning/flag";
import { learnClubSetup, type LearnOutcome } from "./setup-learning/run";
import { FEE_PATH } from "./setup-learning/suggestion-action";
import {
  READING_OFF_REASON,
  READING_TIMED_OUT_REASON,
  SETUP_ASK_DM_PURPOSE,
  composeSetupAskDm,
  isStandardSetup,
  readingFromRow,
  setupAskRefId,
  type ChatReading,
} from "./club-setup-dm-rules";

export { SETUP_ASK_DM_PURPOSE, setupAskRefId } from "./club-setup-dm-rules";
export { cancelSetupDm, type SetupDmCancelReason } from "./club-setup-dm-cancel";

/** The links stay clickable for a week: the organiser may take days to say GO. */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Clubs handled per sweep. Far more than are ever approved in 15 minutes. */
export const MAX_SETUP_DMS_PER_SWEEP = 20;

/** Why a setup DM was not sent, as shown on /admin/health. Codes only. */
export type SetupDmNotSentCode = "no-organiser" | PlatformDmRefused["code"];

export type SetupDmOutcome =
  /** Queued. `sendAfter` null: goes at once. */
  | { kind: "sent"; sendAfter: Date | null }
  /** Not setting up, already asked, or MatchTime was removed from the group. */
  | { kind: "not-due" }
  /** The reading is on, not final, and the 2-hour cap has not been reached. */
  | { kind: "reading" }
  /** Another run stamped the club first; that run queued the DM. */
  | { kind: "already" }
  /** No closed connect request: nobody to tell. Stamped, recorded, not retried. */
  | { kind: "no-organiser" }
  /** The platform channel refused the recipient. Stamped, recorded, not retried. */
  | { kind: "refused"; reason: SetupDmNotSentCode };

export interface SetupDmOptions {
  /** SETUP_LEARNING_ENABLED, as the caller read it. */
  learningEnabled?: boolean;
}

type RawClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * Close the club's reading for good, unless it has already finished. An
 * absent row becomes a final one, a running or deferred one is closed, and
 * then the stored chat is deleted, as after any final outcome. A row that
 * is already final is left exactly as it was (false). One statement with
 * no error to catch, in its own transaction with the chat's deletion.
 *
 * It takes THE CLUB'S ROW FIRST (`lockClubSetup`: the lock order at the
 * top of club-setup.ts), so it waits for a reading that is writing its
 * result at this instant and then finds the row final, instead of meeting
 * it half way. Never FOR UPDATE: that waits for the reading's claim, which
 * is waiting for this row (a deadlock, found on main).
 */
export async function closeReadingForGood(
  orgId: string,
  reason: typeof READING_OFF_REASON | typeof READING_TIMED_OUT_REASON,
  now: Date = new Date(),
): Promise<boolean> {
  return db.$transaction(async (client) => {
    const tx = client as unknown as RawClient;
    await lockClubSetup(tx, orgId);
    const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "ClubSetupLearning" ("id", "orgId", "status", "reason", "updatedAt")
      VALUES (${`csl-${randomUUID()}`}, ${orgId}, 'skipped', ${reason}, ${now})
      ON CONFLICT ("orgId") DO UPDATE SET
        "status" = 'skipped',
        "reason" = ${reason},
        "updatedAt" = ${now}
      WHERE "ClubSetupLearning"."status" IN ('running', 'deferred')
      RETURNING (xmax = 0) AS "inserted"`;
    if (rows.length === 0) return false;
    // The group description goes with the chat (captured-chat.ts).
    await clearCapturedChatForClub(tx, orgId);
    return true;
  });
}

/**
 * The club, only while its setup DM is due, with all the DM is composed
 * from. Read in ONE SNAPSHOT (repeatable read): the club's settings and
 * its reading row are two SELECTs, and a reading that commits between them
 * would otherwise give settings from before it and a row from after it,
 * which reads as "the organiser changed this back" and made the DM say
 * "found nothing" about a setting just switched on (found by the cap's
 * race, e2e/helpers/setup-hold-lib-tests.ts check 9). Read only: it takes
 * no lock and cannot fail to serialise.
 */
function loadDue(orgId: string) {
  return db.$transaction((tx) => loadDueIn(tx, orgId), { isolationLevel: "RepeatableRead" });
}

function loadDueIn(tx: Pick<typeof db, "organisation">, orgId: string) {
  return tx.organisation.findFirst({
    where: { id: orgId, ...SETUP_DM_DUE_WHERE },
    select: {
      id: true,
      name: true,
      language: true,
      approvedAt: true,
      rollingSquadEnabled: true,
      benchPickMode: true,
      dropOutDeadlineDay: true,
      dropOutDeadlineTime: true,
      listPublishDay: true,
      listPublishTime: true,
      paymentTrackingEnabled: true,
      squadMode: true,
      featureAttendance: true,
      featureBench: true,
      featureSquadFromList: true,
      adminGroupId: true,
      // Whether going live will start a free period (`freePeriodCanStart`).
      billingStatus: true,
      billingPlan: true,
      clubBilling: { select: { orgId: true } },
      setupLearning: { select: { status: true, reason: true, applied: true, suggestions: true, noted: true } },
    },
  });
}

/** Stamp a club whose DM can never be sent, and tell the owner once. */
async function recordNotSent(orgId: string, code: SetupDmNotSentCode, now: Date): Promise<void> {
  console.error(`[club-setup-dm] ${orgId}: setup DM NOT sent (${code}); the club is waiting for GO with no DM. See /admin/health.`);
  await recordOpsEvent({
    orgId,
    kind: SETUP_ALERT_KIND,
    severity: "warning",
    title: "Setup message not sent",
    detail:
      `This club is approved and silent in its group, but its organiser was not sent the setup message (${code}). ` +
      `It is not retried. The organiser can still go live from the settings page.`,
    // One per club, ever: there is one setup DM.
    dedupeKey: "setup-ask-not-sent",
    now,
  });
}

/** Send this club's setup DM if it is due. Never twice (see the header). */
export async function sendSetupDm(orgId: string, now: Date = new Date(), opts: SetupDmOptions = {}): Promise<SetupDmOutcome> {
  const learningEnabled = opts.learningEnabled ?? isSetupLearningEnabled();
  let org = await loadDue(orgId);
  if (!org) return { kind: "not-due" };

  if (!isSetupLearningFinal(org.setupLearning?.status)) {
    const capReached = !!org.approvedAt && now.getTime() - org.approvedAt.getTime() >= STILL_READING_WINDOW_MS;
    if (learningEnabled && !capReached) return { kind: "reading" };
    // The reading is off, or it has had its two hours: no reading will
    // ever be reported for this club, so none may ever finish. Then read
    // the club again: if the reading finished a moment before the close,
    // the close did nothing and the fresh row is what the DM reports.
    const closed = await closeReadingForGood(orgId, learningEnabled ? READING_TIMED_OUT_REASON : READING_OFF_REASON, now);
    if (closed && learningEnabled) console.log(`[club-setup-dm] ${orgId}: reading not final two hours after approval; closed (timed-out)`);
    org = await loadDue(orgId);
    if (!org) return { kind: "not-due" };
  }

  const sendAfter = messageHoursSendAfter(now);
  const dueAt = sendAfter ?? now;

  // The organiser: whoever made the connect request the approval closed
  // (the same row the reading reads the chat from).
  const connect = await db.clubConnect.findFirst({
    where: { orgId, status: "closed", linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { id: true, userId: true, phone: true, groupSubject: true },
  });
  if (!connect) {
    // Nobody to tell, now or on any later sweep.
    if (await markSetupAsked(orgId, dueAt)) await recordNotSent(orgId, "no-organiser", now);
    return { kind: "no-organiser" };
  }

  const link = async (nextPath: string): Promise<string> => {
    try {
      return await buildAdminLink({ userId: connect.userId, orgId, nextPath, ttlSeconds: LINK_TTL_SECONDS });
    } catch {
      console.error(`[club-setup-dm] ${orgId}: a signed-in link could not be made; sending the plain address`);
      return appUrl(nextPath);
    }
  };

  // What still stands NOW: not what the organiser has undone or changed.
  const stored = readingFromRow(org.setupLearning, org);
  let reading: ChatReading;
  let learnedUrl: string | null = null;
  let organiserPicksUrl: string | null = null;
  let feeUrl: string | null = null;
  if (stored.kind === "findings") {
    const applied = [];
    for (const a of stored.applied) {
      applied.push({ ...a, undoUrl: await link(`/admin/settings?learned=${a.key}#learned-setup`) });
    }
    reading = { ...stored, applied };
    learnedUrl = await link("/admin/settings#learned-setup");
    if (stored.suggestions.some((sg) => sg.key === "organiserPicks")) {
      organiserPicksUrl = await link("/admin/settings?learned=organiserPicks#learned-setup");
    }
    // The match fee suggestion: straight to the fee field, as the findings DM links it (setup-learning/run.ts).
    if (stored.suggestions.some((sg) => sg.key === "matchFee")) feeUrl = await link(FEE_PATH);
  } else {
    reading = stored;
  }

  // "Rolling squad is on: whoever played last time is in next time" is no
  // help for a first game nobody has played. When the reading switched
  // rolling squad on, ask the hello's own rule whether there is a squad
  // to carry; if not, the DM adds "for the first game everyone says In
  // once". A failed read costs that one line, never the DM.
  let noSquadToCarry = false;
  if (reading.kind === "findings" && reading.applied.some((a) => a.key === "rollingSquad" && a.to === true)) {
    try {
      noSquadToCarry = !(await loadHasSquadToCarry(orgId, db as unknown as HelloReadClient, now));
    } catch {
      console.error(`[club-setup-dm] ${orgId}: could not tell whether there is a squad to carry; the first-game line is left out`);
    }
  }

  // The optional admin group step: only for a club with none linked.
  const adminStep = !org.adminGroupId;

  const text = composeSetupAskDm({
    lang: org.language,
    club: org.name,
    group: connect.groupSubject,
    reading,
    standard: isStandardSetup(org),
    scheduleUrl: await link("/admin/activities"),
    ratingsUrl: await link("/admin/players/ratings"),
    settingsUrl: await link("/admin/settings"),
    learnedUrl,
    organiserPicksUrl,
    feeUrl,
    // The free period line, only when going live will start one: the test
    // `goLiveClub`'s billing step applies (billing on, plan not Free, no
    // free period had). Read from the environment, as the sweep reads the
    // reading's switch.
    freePeriod: freePeriodCanStart({ ...org, hasBilling: !!org.clubBilling }),
    adminGroupBlock: adminStep ? setupAdminGroupBlock(org.language) : null,
    noSquadToCarry,
  });
  const language = org.language;
  // The setup DM first, its admin group command second: dispatch is oldest
  // first, and two rows of one transaction would share its timestamp.
  const queuedAt = new Date();

  const outcome = await db.$transaction(async (tx): Promise<SetupDmOutcome> => {
    // The claim. Only the run that wins it goes on.
    if (!(await markSetupAsked(orgId, dueAt, tx))) return { kind: "already" };
    try {
      await queuePlatformDm({
        phone: connect.phone,
        text,
        purpose: SETUP_ASK_DM_PURPOSE,
        refId: setupAskRefId(orgId),
        sendAfter,
        client: tx as unknown as PlatformDmClient,
        ...(adminStep ? { createdAt: queuedAt } : {}),
      });
      if (adminStep) {
        // "My next message": the link command, on its own, right behind.
        const { code } = await createAdminGroupLinkCode(orgId, dueAt, {
          ttlMs: ADMIN_GROUP_DM_CODE_TTL_MS,
          client: tx as unknown as AdminGroupCodeClient,
        });
        await queuePlatformDm({
          phone: connect.phone,
          text: composeSetupAdminCommandDm({ lang: language, code }),
          purpose: SETUP_ADMIN_CODE_DM_PURPOSE,
          refId: setupAdminCodeRefId(orgId),
          sendAfter,
          client: tx as unknown as PlatformDmClient,
          createdAt: new Date(queuedAt.getTime() + 1),
        });
      }
    } catch (err) {
      // The recipient rule said no (the organiser's number is no longer a
      // MatchTime user's, or is not a number). The stamp STAYS, so no sweep
      // mints links for this club every 15 minutes for ever; the owner is
      // told below, on /admin/health. Only the code is kept: the refusal's
      // own message can hold the raw number.
      if (!(err instanceof PlatformDmRefused)) throw err;
      return { kind: "refused", reason: err.code };
    }
    return { kind: "sent", sendAfter };
  });
  if (outcome.kind === "refused") await recordNotSent(orgId, outcome.reason, now);
  if (outcome.kind === "sent") {
    console.log(
      `[club-setup-dm] ${orgId}: setup DM queued (reading: ${reading.kind}` +
        `${adminStep ? ", with the admin group command" : ""}` +
        `${sendAfter ? `, held until ${sendAfter.toISOString()}` : ""})`,
    );
  }
  return outcome;
}

/**
 * The cron's half: every club whose setup DM is due. With the reading on,
 * clubs whose reading is final, and clubs approved two hours ago or more
 * (the cap); with it off, every one.
 */
export async function runSetupDmSweep(
  now: Date = new Date(),
  opts: SetupDmOptions = {},
): Promise<{ considered: number; sent: number }> {
  const learningEnabled = opts.learningEnabled ?? isSetupLearningEnabled();
  const due = await db.organisation.findMany({
    where: {
      ...SETUP_DM_DUE_WHERE,
      ...(learningEnabled
        ? {
            OR: [
              { setupLearning: { is: { status: { in: [...SETUP_LEARNING_FINAL_STATUSES] } } } },
              { approvedAt: { lte: new Date(now.getTime() - STILL_READING_WINDOW_MS) } },
            ],
          }
        : {}),
    },
    orderBy: { approvedAt: "asc" },
    take: MAX_SETUP_DMS_PER_SWEEP,
    select: { id: true },
  });
  let sent = 0;
  for (const o of due) {
    try {
      if ((await sendSetupDm(o.id, now, { learningEnabled })).kind === "sent") sent++;
    } catch (err) {
      console.error(`[club-setup-dm] ${o.id}: setup DM failed; the next sweep retries: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return { considered: due.length, sent };
}

export interface SetupAfterApprovalOptions extends SetupDmOptions {
  now?: Date;
  /** Tests and the e2e seam pass a stub; never set in production. */
  model?: PipelineModel;
}

/**
 * What runs right after an approval that held the club, for THAT club
 * only: its chat reading (when the reading is on), then its setup DM. One
 * model call at most, so it fits inside the route's duration limit; the
 * cron retries whatever did not finish. Never throws: it runs inside
 * `after()`, where nobody is listening.
 */
export async function runSetupAfterApproval(
  orgId: string,
  opts: SetupAfterApprovalOptions = {},
): Promise<{ reading: LearnOutcome | null; dm: SetupDmOutcome | null }> {
  const now = opts.now ?? new Date();
  const learningEnabled = opts.learningEnabled ?? isSetupLearningEnabled();
  let reading: LearnOutcome | null = null;
  if (learningEnabled) {
    try {
      reading = await learnClubSetup(orgId, { now, model: opts.model });
    } catch (err) {
      console.error(`[club-setup-dm] ${orgId}: the reading after approval failed; the cron retries: ${(err as Error)?.name ?? "error"}`);
    }
  }
  let dm: SetupDmOutcome | null = null;
  try {
    dm = await sendSetupDm(orgId, now, { learningEnabled });
  } catch (err) {
    console.error(`[club-setup-dm] ${orgId}: the setup DM after approval failed; the cron retries: ${(err as Error)?.name ?? "error"}`);
  }
  return { reading, dm };
}
