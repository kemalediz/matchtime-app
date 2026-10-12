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
 *          failed after its retries); or at once when
 *          SETUP_LEARNING_ENABLED is off, in which case there is no
 *          reading to wait for.
 *   WHAT   `composeSetupAskDm`: approved and quiet until you say so, what
 *          the reading found, the settings link, the weekly game and the
 *          starting ratings, the GO line, the free period. It REPLACES
 *          today's "you're live" DM and the separate findings DM
 *          ("setup-learned"), which a held club is never sent.
 *   HOURS  09:00 to 23:00 London (`messageHoursSendAfter`); a night run
 *          is queued for the next 09:00.
 *   ONCE   see "At most one" below.
 *
 * WHO RUNS IT. Two callers, the same code:
 *   - `runSetupAfterApproval(orgId)`: scheduled with `after()` by both
 *     approval entry points (club-setup-schedule.ts), so the organiser
 *     hears within moments of the approval. It reads that one club's chat
 *     (one model call at most) and then sends its DM.
 *   - `runSetupDmSweep()`: the 15-minute learn-setup cron, after its
 *     reading sweep. The retry: a reading that was deferred, a run that
 *     died, a server that never ran the `after()` callback.
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
 * THE READING OFF. When the DM goes without a finished reading (the flag
 * is off), the club's reading is closed for good in the same transaction
 * ("skipped", reason "reading-off") and the stored chat deleted. Without
 * that, switching the reading on a day later would read the club and
 * change its settings behind a DM that said "standard setup", with no
 * second DM to say so.
 *
 * NOT HERE (later slices): the reminder at 24 hours, the 2-hour cap on a
 * reading that never reaches a final status, the admin group block, GO.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { appUrl, buildAdminLink } from "./admin-link";
import { SETUP_DM_DUE_WHERE, markSetupAsked } from "./club-setup";
import { messageHoursSendAfter } from "./message-hours";
import { PlatformDmRefused, queuePlatformDm, type PlatformDmClient } from "./platform-jobs";
import type { PipelineModel } from "./pipeline/llm";
import { isSetupLearningEnabled } from "./setup-learning/flag";
import { learnClubSetup, type LearnOutcome } from "./setup-learning/run";
import {
  CHAT_READING_FINAL_STATUSES,
  composeSetupAskDm,
  isChatReadingFinal,
  isStandardSetup,
  readingFromRow,
  type ChatReading,
} from "./club-setup-dm-rules";

export const SETUP_ASK_DM_PURPOSE = "setup-ask" as const;
/** The DM's refId: one per club. */
export const setupAskRefId = (orgId: string): string => `${orgId}:setup-ask`;
/** The links stay clickable for a week: the organiser may take days to say GO. */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Clubs handled per sweep. Far more than are ever approved in 15 minutes. */
export const MAX_SETUP_DMS_PER_SWEEP = 20;

export type SetupDmOutcome =
  /** Queued. `sendAfter` null: goes at once. */
  | { kind: "sent"; sendAfter: Date | null }
  /** Not setting up, already asked, or MatchTime was removed from the group. */
  | { kind: "not-due" }
  /** The reading is on and has not reached a final status yet. */
  | { kind: "reading" }
  /** Another run stamped the club first; that run queued the DM. */
  | { kind: "already" }
  /** No closed connect request: nobody to tell. */
  | { kind: "no-organiser" }
  /** The platform channel refused the recipient. Stamped, never retried. */
  | { kind: "refused"; reason: string };

export interface SetupDmOptions {
  /** SETUP_LEARNING_ENABLED, as the caller read it. */
  learningEnabled?: boolean;
}

type RawClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * The DM is going without a finished reading: make sure none can ever
 * finish. An absent row becomes a final one; a running or deferred one is
 * closed; the stored chat is deleted, as after any final outcome. One
 * statement with no error to catch (a caught unique violation would still
 * have aborted the transaction).
 */
async function closeReadingForGood(orgId: string, tx: RawClient, now: Date): Promise<void> {
  await tx.$queryRaw`
    INSERT INTO "ClubSetupLearning" ("id", "orgId", "status", "reason", "updatedAt")
    VALUES (${`csl-${randomUUID()}`}, ${orgId}, 'skipped', 'reading-off', ${now})
    ON CONFLICT ("orgId") DO UPDATE SET
      "status" = 'skipped',
      "reason" = 'reading-off',
      "updatedAt" = ${now}
    WHERE "ClubSetupLearning"."status" IN ('running', 'deferred')`;
  await tx.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "orgId" = ${orgId}`;
}

/** Send this club's setup DM if it is due. Never twice (see the header). */
export async function sendSetupDm(orgId: string, now: Date = new Date(), opts: SetupDmOptions = {}): Promise<SetupDmOutcome> {
  const learningEnabled = opts.learningEnabled ?? isSetupLearningEnabled();
  const org = await db.organisation.findFirst({
    where: { id: orgId, ...SETUP_DM_DUE_WHERE },
    select: {
      id: true,
      name: true,
      language: true,
      rollingSquadEnabled: true,
      benchPickMode: true,
      squadMode: true,
      setupLearning: { select: { status: true, applied: true, suggestions: true, noted: true } },
    },
  });
  if (!org) return { kind: "not-due" };
  const final = isChatReadingFinal(org.setupLearning?.status);
  if (learningEnabled && !final) return { kind: "reading" };

  // The organiser: whoever made the connect request the approval closed
  // (the same row the reading reads the chat from).
  const connect = await db.clubConnect.findFirst({
    where: { orgId, status: "closed", linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { id: true, userId: true, phone: true, groupSubject: true },
  });
  if (!connect) {
    console.error(`[club-setup-dm] ${orgId}: setting up, but no closed connect request: nobody to send the setup DM to`);
    return { kind: "no-organiser" };
  }

  const link = async (nextPath: string): Promise<string> => {
    try {
      return await buildAdminLink({ userId: connect.userId, orgId, nextPath, ttlSeconds: LINK_TTL_SECONDS });
    } catch (err) {
      console.error(`[club-setup-dm] ${orgId}: signed-in link to ${nextPath} failed; sending the plain address:`, err);
      return appUrl(nextPath);
    }
  };

  const stored = readingFromRow(org.setupLearning);
  let reading: ChatReading;
  let learnedUrl: string | null = null;
  let organiserPicksUrl: string | null = null;
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
  } else {
    reading = stored;
  }

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
    // adminGroupBlock: go-live slice S7 passes the admin group step here.
  });

  const sendAfter = messageHoursSendAfter(now);
  const dueAt = sendAfter ?? now;
  const outcome = await db.$transaction(async (tx): Promise<SetupDmOutcome> => {
    // The claim. Only the run that wins it goes on.
    if (!(await markSetupAsked(orgId, dueAt, tx))) return { kind: "already" };
    if (!final) await closeReadingForGood(orgId, tx as unknown as RawClient, now);
    try {
      await queuePlatformDm({
        phone: connect.phone,
        text,
        purpose: SETUP_ASK_DM_PURPOSE,
        refId: setupAskRefId(orgId),
        sendAfter,
        client: tx as unknown as PlatformDmClient,
      });
    } catch (err) {
      // The recipient rule said no (the organiser's number is no longer a
      // MatchTime user's). That is a fact about the data, not a failure to
      // retry: the stamp stays, so no sweep mints links for this club
      // every 15 minutes for ever. /admin/clubs shows a stuck club.
      if (!(err instanceof PlatformDmRefused)) throw err;
      console.error(`[club-setup-dm] ${orgId}: setup DM NOT queued (${err.reason}); the club is waiting for GO with no DM`);
      return { kind: "refused", reason: err.reason };
    }
    return { kind: "sent", sendAfter };
  });
  if (outcome.kind === "sent") {
    console.log(
      `[club-setup-dm] ${orgId} ("${org.name}"): setup DM queued (reading: ${reading.kind}` +
        `${sendAfter ? `, held until ${sendAfter.toISOString()}` : ""})`,
    );
  }
  return outcome;
}

/**
 * The cron's half: every club whose setup DM is due. With the reading on,
 * only clubs whose reading is final; with it off, every one.
 */
export async function runSetupDmSweep(
  now: Date = new Date(),
  opts: SetupDmOptions = {},
): Promise<{ considered: number; sent: number }> {
  const learningEnabled = opts.learningEnabled ?? isSetupLearningEnabled();
  const due = await db.organisation.findMany({
    where: {
      ...SETUP_DM_DUE_WHERE,
      ...(learningEnabled ? { setupLearning: { is: { status: { in: [...CHAT_READING_FINAL_STATUSES] } } } } : {}),
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
      console.error(`[club-setup-dm] ${o.id}: setup DM failed; the next sweep retries:`, err);
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
      console.error(`[club-setup-dm] ${orgId}: the reading after approval failed; the cron retries:`, err);
    }
  }
  let dm: SetupDmOutcome | null = null;
  try {
    dm = await sendSetupDm(orgId, now, { learningEnabled });
  } catch (err) {
    console.error(`[club-setup-dm] ${orgId}: the setup DM after approval failed; the cron retries:`, err);
  }
  return { reading, dm };
}
