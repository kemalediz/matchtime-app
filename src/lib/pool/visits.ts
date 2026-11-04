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
 * NEVER IN THE WAY. A count is a nice-to-know: every failure is logged and
 * swallowed, so it can never fail the page, the sign-up or the confirm.
 *
 * PRIVACY. Stored: the bucket (a campaign code, "_direct" or "_referral"),
 * the London day, the step and a count. No id, no address, no user agent:
 * the user agent is read only to skip link preview fetchers.
 */
import { db } from "../db";
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

/** A page step (opened, started). The bucket counted, or null when nothing
 *  was (a fetcher, or a failure). */
export async function recordPoolVisit(a: {
  source: { campaignCode: string | null; referralCode: string | null };
  userAgent: string | null;
  now: Date;
  step?: PoolPageStep;
}): Promise<string | null> {
  const step = a.step ?? "opened";
  if (isLinkPreviewFetcher(a.userAgent)) return null;
  try {
    const referralLive = a.source.referralCode
      ? !!(await db.poolProfile.findUnique({ where: { shareCode: a.source.referralCode }, select: { userId: true } }))?.userId
      : false;
    const campaignLive =
      !referralLive && !!a.source.campaignCode
        ? !!(await db.poolCampaign.findFirst({ where: { code: a.source.campaignCode, active: true }, select: { code: true } }))
        : false;
    const code = poolVisitBucket(a.source, { campaignLive, referralLive });
    await countStep(code, step, a.now);
    return code;
  } catch (err) {
    warn(step, err);
    return null;
  }
}

/** The form sent: a waiting sign-up was made with this attribution. Null
 *  for one that did not come through /play, or a failure. */
export async function recordPoolSignupSent(p: { source: string | null; sourceCode: string | null }, now: Date): Promise<string | null> {
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
 *  profile, so the step lands where its sign-up was counted. */
export async function recordPoolSignupConfirmed(profileId: string, now: Date): Promise<string | null> {
  try {
    const p = await db.poolProfile.findUnique({ where: { id: profileId }, select: { source: true, sourceCode: true } });
    const code = p ? poolProfileBucket(p) : null;
    if (!code) return null;
    await countStep(code, "confirmed", now);
    return code;
  } catch (err) {
    warn("confirmed", err);
    return null;
  }
}
