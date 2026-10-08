/**
 * CAPTURED GROUP CHAT EXPIRES (owner's decision, 2026-10-08).
 *
 * When MatchTime is added to a group the Pi sends the group's recent chat
 * (text, author name, author phone). The server keeps it in two places:
 *
 *   ClubConnect.capturedHistory        the self-join path. Deleted when the
 *     learned setup has read it once after approval, when the club is
 *     rejected, and when MatchTime is removed from the group. A club that
 *     was linked and then never decided used to keep it for ever.
 *   OnboardingSession.capturedHistory  the legacy in-group setup (self-join
 *     off). Nothing ever deleted it.
 *
 * THE RULE. Captured chat is deleted once it is
 * CAPTURED_HISTORY_RETENTION_DAYS old:
 *
 *   - on a connect request, measured from `linkedAt`, the moment the group
 *     was linked, which is when the chat was stored. (A re-add may store
 *     chat later on a link that had none; that chat is still measured from
 *     the link, so it can only live shorter, never longer. Past the limit a
 *     re-add stores nothing: see group-add.ts.)
 *   - on an onboarding session, measured from `createdAt`, and at once when
 *     the session is "completed" or "abandoned": the only reader is the
 *     completion turn itself, which reads it from memory.
 *
 * NEVER UNDER A PENDING SWEEP. The learned-setup sweep
 * (setup-learning/run.ts) reads clubs approved in the last
 * SWEEP_WINDOW_DAYS, and retries a deferred one inside that window. So a
 * connect request whose club was approved inside that window is left
 * alone here, however old its link is; the sweep deletes the chat itself
 * when it finishes. Once the window has closed no sweep will ever read the
 * chat, and it expires like any other (this also covers a club approved
 * while SETUP_LEARNING_ENABLED was off). The longest chat can live is
 * therefore retention + the sweep window, and only for a club approved on
 * the last day of its retention.
 *
 * A club approved AFTER its chat expired is approved exactly as usual. The
 * sweep then finds no chat: skipped ("no-history"), no model call, no
 * setting changed, no DM, no error.
 *
 * Runs from /api/cron/learn-setup every 15 minutes, after the sweep, and
 * whether or not SETUP_LEARNING_ENABLED is on. Idempotent (a second run
 * finds nothing), bounded (CAPTURED_HISTORY_MAX_PER_RUN rows per table per
 * run; the rest go on the next run), and it logs counts only: never a
 * message, a name, a phone or a group.
 */
import { db } from "@/lib/db";
import { SWEEP_WINDOW_DAYS } from "./setup-learning/run";
import { CAPTURED_HISTORY_RETENTION_DAYS, CAPTURED_HISTORY_RETENTION_MS } from "./captured-history-retention";

export { CAPTURED_HISTORY_RETENTION_DAYS };
/** Rows cleared per table per run. */
export const CAPTURED_HISTORY_MAX_PER_RUN = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export function capturedHistoryCutoffs(now: Date): { expireBefore: Date; sweepReadsSince: Date } {
  return {
    expireBefore: new Date(now.getTime() - CAPTURED_HISTORY_RETENTION_MS),
    sweepReadsSince: new Date(now.getTime() - SWEEP_WINDOW_DAYS * DAY_MS),
  };
}

/**
 * Prisma stores DateTime as UTC in `timestamp(3)` (no zone). A Date bound
 * to raw SQL arrives zoned and would be compared through the session's
 * time zone; a plain UTC string cast to `timestamp` cannot be.
 */
function utcTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export interface ExpiredCapturedHistory {
  connectRequests: number;
  onboardingSessions: number;
}

export async function expireCapturedHistory(now: Date = new Date()): Promise<ExpiredCapturedHistory> {
  const cut = capturedHistoryCutoffs(now);
  const expireBefore = utcTimestamp(cut.expireBefore);
  const sweepReadsSince = utcTimestamp(cut.sweepReadsSince);

  const connectRequests = await db.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL
    WHERE "id" IN (
      SELECT c."id" FROM "ClubConnect" c
      JOIN "Organisation" o ON o."id" = c."orgId"
      WHERE c."capturedHistory" IS NOT NULL
        AND COALESCE(c."linkedAt", c."createdAt") < ${expireBefore}::timestamp
        AND (o."approvedAt" IS NULL OR o."approvedAt" < ${sweepReadsSince}::timestamp)
      ORDER BY c."id"
      LIMIT ${CAPTURED_HISTORY_MAX_PER_RUN}
    )`;

  const onboardingSessions = await db.$executeRaw`UPDATE "OnboardingSession" SET "capturedHistory" = NULL
    WHERE "id" IN (
      SELECT s."id" FROM "OnboardingSession" s
      WHERE s."capturedHistory" IS NOT NULL
        AND (s."stage" IN ('completed', 'abandoned') OR s."createdAt" < ${expireBefore}::timestamp)
      ORDER BY s."id"
      LIMIT ${CAPTURED_HISTORY_MAX_PER_RUN}
    )`;

  if (connectRequests > 0 || onboardingSessions > 0) {
    console.log(
      `[captured-history] expired after ${CAPTURED_HISTORY_RETENTION_DAYS} days: ` +
        `${connectRequests} connect request(s), ${onboardingSessions} onboarding session(s)`,
    );
  }
  return { connectRequests, onboardingSessions };
}
