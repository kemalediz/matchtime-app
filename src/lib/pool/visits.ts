/**
 * THE /play SIGN-UP FUNNEL, the thin I/O half (visits 2026-11-03, every step
 * 2026-11-04). Rules in `visit-rules.ts`. Written by:
 *   opened, started   `POST /api/play/visit` (the page's beacon), after the
 *                     answer has gone;
 *   sent              `createPoolSignup` (`signup.ts`), once the waiting
 *                     sign-up exists;
 *   confirmed         `handlePoolConfirmDm` (`confirm.ts`), once his
 *                     WhatsApp message made it active.
 * Read by the owner's source codes page (`campaigns.ts`). One table,
 * "PoolCampaignVisit", one row per (bucket, London day, step).
 *
 * THE BREAKDOWN (per visit 2026-11-13; DAILY TOTALS ONLY since 2026-11-16,
 * rules in `visit-log-rules.ts`). Each OPEN also adds one to a daily total
 * by the in-app browser and the scanner flag,
 * "PoolVisitDaily", kept 90 days and then deleted by the daily cron
 * (`purgeOldPoolVisitDaily`), so scanners can be told from people after
 * the server log has gone. Nothing per visit is kept, nor a browser,
 * device or what opened the page. Started, sent and confirmed have no breakdown: the counters
 * already count them, and a start is the step just before a sign-up.
 *
 * STAFF TESTS (2026-11-16; rounds 3 and 4 of #607). A sign-up ticked as a
 * test from a verified MatchTime staff session (`PoolProfile.staffTest`,
 * set by `createPoolSignup`, never from the staff cookie) is counted as
 * neither sent nor confirmed. The confirm comes later by WhatsApp, where
 * there is no cookie, so the flag on the profile is what says so.
 *
 * NEVER IN THE WAY. A count is a nice-to-know: every failure is logged and
 * swallowed, so it can never fail the page, the sign-up or the confirm.
 * The breakdown is the same, on its own: its failure never costs a count.
 *
 * PRIVACY. Stored in the counters: the bucket (a campaign code, "_direct"
 * or "_referral"), the London day, the step and a count. In the breakdown:
 * the same for opens, plus the in-app browser and the scanner flag. No id, no address, no cookie, no friend's code, no
 * browser or device, no time of day, and never the user agent itself: it
 * is read to skip link preview fetchers and to make that label, and never
 * stored or logged. No line is logged per visit (round 3 of #607).
 */
import { db } from "../db";
import {
  poolVisitDailyKey,
  poolVisitPurgeBeforeDay,
  POOL_VISIT_RETENTION_DAYS,
  type PoolVisitDailyKey,
} from "./visit-log-rules";
import {
  isLinkPreviewFetcher,
  poolProfileBucket,
  poolVisitBucket,
  poolVisitDay,
  type PoolFunnelStep,
  type PoolPageStep,
} from "./visit-rules";

/** One more for (bucket, day, step). One statement: two at once both count. */
async function countStep(code: string, step: PoolFunnelStep, now: Date): Promise<void> {
  const day = poolVisitDay(now);
  await db.$executeRaw`INSERT INTO "PoolCampaignVisit" ("code", "day", "step", "count") VALUES (${code}, ${day}::date, ${step}, 1)
    ON CONFLICT ("code", "day", "step") DO UPDATE SET "count" = "PoolCampaignVisit"."count" + 1`;
}

const warn = (step: string, err: unknown) => console.warn(`[pool-funnel] ${step} not counted:`, err instanceof Error ? err.message : err);

/** The bucket a page step lands in, as `signup.ts` would attribute it. */
async function pageStepBucket(source: { campaignCode: string | null; referralCode: string | null }): Promise<string> {
  const referralLive = source.referralCode
    ? !!(await db.poolProfile.findUnique({ where: { shareCode: source.referralCode }, select: { userId: true } }))?.userId
    : false;
  const campaignLive =
    !referralLive && !!source.campaignCode
      ? !!(await db.poolCampaign.findFirst({ where: { code: source.campaignCode, active: true }, select: { code: true } }))
      : false;
  return poolVisitBucket(source, { campaignLive, referralLive });
}

/**
 * One more for the open's daily total (2026-11-16, `visit-log-rules.ts`):
 * only the columns `poolVisitDailyKey` builds, never the user agent, a
 * browser or device, what opened the page, the friend's code or the time
 * of day. One statement,
 * so two at once both count. Best-effort on its own: a failure (the table not yet migrated, a
 * blip) is logged and costs nothing else, the count least of all.
 */
async function addToDailyTotal(k: PoolVisitDailyKey): Promise<void> {
  try {
    await db.$executeRaw`INSERT INTO "PoolVisitDaily" ("code", "day", "inApp", "scanner", "count")
      VALUES (${k.code}, ${k.day}::date, ${k.inApp}, ${k.scanner}, 1)
      ON CONFLICT ("code", "day", "inApp", "scanner") DO UPDATE SET "count" = "PoolVisitDaily"."count" + 1`;
  } catch (err) {
    console.warn("[pool-funnel] opened not added to the daily breakdown:", err instanceof Error ? err.message : err);
  }
}

/**
 * A page step (opened, started). The bucket counted, or null when nothing
 * was (a fetcher, or a failure).
 *
 * A link preview fetcher is never counted, but its open is added to the
 * daily breakdown with the scanner flag (2026-11-13), so a burst of
 * scanners on a new post can be told from people. A start is added to no
 * breakdown. A failed count still adds the total, and a failed total never
 * fails the count. Nothing per visit is logged (round 3 of #607); a
 * failure is a warning with its error only.
 */
export async function recordPoolVisit(a: {
  source: { campaignCode: string | null; referralCode: string | null };
  userAgent: string | null;
  now: Date;
  step: PoolPageStep;
}): Promise<string | null> {
  const step = a.step;
  const fetcher = isLinkPreviewFetcher(a.userAgent);
  let code: string;
  try {
    code = await pageStepBucket(a.source);
  } catch (err) {
    warn(step, err);
    return null;
  }
  let counted = false;
  if (!fetcher) {
    try {
      await countStep(code, step, a.now);
      counted = true;
    } catch (err) {
      warn(step, err);
    }
  }
  if (step === "opened") await addToDailyTotal(poolVisitDailyKey({ code, now: a.now, userAgent: a.userAgent }));
  return counted ? code : null;
}

/**
 * RETENTION: keep exactly POOL_VISIT_RETENTION_DAYS (90) London days of
 * the daily breakdown, today included, and delete the days before them. Run by the daily 06:00 cron
 * (`api/cron/close-ratings`). One statement on the "day" index, a day's
 * rows at a time in the steady state. Total: a failure is logged and
 * counted as 0, so the cron's other sweeps still run.
 */
export async function purgeOldPoolVisitDaily(now: Date = new Date()): Promise<number> {
  try {
    const r = await db.poolVisitDaily.deleteMany({ where: { day: { lt: new Date(`${poolVisitPurgeBeforeDay(now)}T00:00:00Z`) } } });
    if (r.count) console.log(`[pool-funnel] deleted ${r.count} daily breakdown row(s) older than ${POOL_VISIT_RETENTION_DAYS} days`);
    return r.count;
  } catch (err) {
    console.error("[pool-funnel] the daily breakdown retention sweep failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** The form sent: a waiting sign-up was made with this attribution. Null
 *  for one that did not come through /play, a staff test, or a failure. */
export async function recordPoolSignupSent(p: { source: string | null; sourceCode: string | null; staffTest?: boolean }, now: Date): Promise<string | null> {
  if (p.staffTest) return null;
  const code = poolProfileBucket(p);
  if (!code) return null;
  try {
    await countStep(code, "sent", now);
    return code;
  } catch (err) {
    warn("sent", err);
    return null;
  }
}

/** His WhatsApp message made the sign-up `profileId` active. Read from the
 *  profile, so the step lands where its sign-up was counted, and a staff
 *  test (`staffTest`) is not counted. */
export async function recordPoolSignupConfirmed(profileId: string, now: Date): Promise<string | null> {
  try {
    const p = await db.poolProfile.findUnique({ where: { id: profileId }, select: { source: true, sourceCode: true, staffTest: true } });
    const code = p && !p.staffTest ? poolProfileBucket(p) : null;
    if (!code) return null;
    await countStep(code, "confirmed", now);
    return code;
  } catch (err) {
    warn("confirmed", err);
    return null;
  }
}
