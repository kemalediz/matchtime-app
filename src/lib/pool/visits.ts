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
 * rules in `visit-log-rules.ts`). Each page step also adds one to a daily
 * total per coarse category, "PoolVisitDaily", kept 90 days and then
 * deleted by the daily cron (`purgeOldPoolVisitDaily`), so drop-off can be
 * explained after the server log has gone. Nothing per visit is kept: no
 * hour, no time on screen. Sent and confirmed have no breakdown: the
 * counters and the sign-up itself already say all there is.
 *
 * STAFF TESTS (2026-11-16). A sign-up made from a MatchTime staff browser
 * (`PoolProfile.staffTest`, set by `createPoolSignup`) is counted as
 * neither sent nor confirmed. The confirm comes later by WhatsApp, where
 * there is no cookie, so the flag on the profile is what says so.
 *
 * NEVER IN THE WAY. A count is a nice-to-know: every failure is logged and
 * swallowed, so it can never fail the page, the sign-up or the confirm.
 * The breakdown is the same, on its own: its failure never costs a count.
 *
 * PRIVACY. Stored in the counters: the bucket (a campaign code, "_direct"
 * or "_referral"), the London day, the step and a count. In the breakdown
 * (never linked to a sign-up or profile): the same, plus what opened the
 * page and a coarse browser label (browser family, in-app browser, device
 * class, scanner), and a count. No id, no address, no cookie, no friend's
 * code, no time of day, and never the user agent itself: it is read to
 * skip link preview fetchers and to make that label, and written to the
 * server log with each page step (`logBeacon`, 2026-11-06), never stored.
 */
import { db } from "../db";
import { poolVisitDailyKey, poolVisitPurgeBeforeDay, POOL_VISIT_RETENTION_DAYS, type PoolVisitDailyKey, type PoolVisitTrigger } from "./visit-log-rules";
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

/**
 * One server log line per beacon, there to identify scanners (Kemal,
 * 2026-11-06: a scanner made 17 opened and 17 started for "fb" in 34
 * seconds and its user agent got past the fetcher check, unrecorded). The
 * raw user agent goes to the log only, never the database (the breakdown
 * keeps only its coarse label); no address, and a friend's share code only
 * as ref=yes. The user agent is JSON-quoted, so it stays one line whatever
 * it holds.
 *   [pool-funnel] beacon step=started code=fb ref=no result=counted bucket=fb ua="Mozilla/5.0 ..."
 * `result` is counted, fetcher (filtered, not counted) or failed.
 */
function logBeacon(
  step: PoolPageStep,
  source: { campaignCode: string | null; referralCode: string | null },
  result: "counted" | "fetcher" | "failed",
  bucket: string | null,
  userAgent: string | null,
): void {
  const ua = userAgent === null ? "none" : JSON.stringify(userAgent);
  console.info(
    `[pool-funnel] beacon step=${step} code=${source.campaignCode ?? "-"} ref=${source.referralCode ? "yes" : "no"} result=${result} bucket=${bucket ?? "-"} ua=${ua}`,
  );
}

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
 * One more for the visit's daily total (2026-11-16, `visit-log-rules.ts`):
 * only the columns `poolVisitDailyKey` builds, never the user agent, the
 * friend's code or the time of day. One statement, so two at once both
 * count. Best-effort on its own: a failure (the table not yet migrated, a
 * blip) is logged and costs nothing else, the count least of all.
 */
async function addToDailyTotal(k: PoolVisitDailyKey): Promise<void> {
  try {
    await db.$executeRaw`INSERT INTO "PoolVisitDaily" ("code", "day", "step", "trigger", "browser", "inApp", "device", "scanner", "count")
      VALUES (${k.code}, ${k.day}::date, ${k.step}, ${k.trigger}, ${k.browser}, ${k.inApp}, ${k.device}, ${k.scanner}, 1)
      ON CONFLICT ("code", "day", "step", "trigger", "browser", "inApp", "device", "scanner") DO UPDATE SET "count" = "PoolVisitDaily"."count" + 1`;
  } catch (err) {
    console.warn(`[pool-funnel] ${k.step} not added to the daily breakdown:`, err instanceof Error ? err.message : err);
  }
}

/**
 * A page step (opened, started). The bucket counted, or null when nothing
 * was (a fetcher, or a failure).
 *
 * A link preview fetcher is never counted, but it is added to the daily
 * breakdown with the scanner flag (2026-11-13), so a burst of scanners on a
 * new post can be told from people. A failed count still adds the total,
 * and a failed total never fails the count.
 */
export async function recordPoolVisit(a: {
  source: { campaignCode: string | null; referralCode: string | null };
  userAgent: string | null;
  now: Date;
  step: PoolPageStep;
  /** What opened the page (opened); "none" for a start. */
  trigger: PoolVisitTrigger;
}): Promise<string | null> {
  const step = a.step;
  const fetcher = isLinkPreviewFetcher(a.userAgent);
  let code: string;
  try {
    code = await pageStepBucket(a.source);
  } catch (err) {
    warn(step, err);
    logBeacon(step, a.source, fetcher ? "fetcher" : "failed", null, a.userAgent);
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
  await addToDailyTotal(poolVisitDailyKey({ code, step, trigger: a.trigger, now: a.now, userAgent: a.userAgent }));
  logBeacon(step, a.source, fetcher ? "fetcher" : counted ? "counted" : "failed", fetcher || !counted ? null : code, a.userAgent);
  return counted ? code : null;
}

/**
 * RETENTION: delete the daily breakdown once its day is
 * POOL_VISIT_RETENTION_DAYS (90) old. Run by the daily 06:00 cron
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
