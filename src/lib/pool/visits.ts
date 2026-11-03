/**
 * VISITS TO /play, the thin I/O half (2026-11-03). Rules in
 * `visit-rules.ts`. Written by `POST /api/play/visit` (the page's beacon),
 * after the answer has gone; read by the owner's source codes page
 * (`campaigns.ts`).
 *
 * NEVER IN THE WAY. A visit is a nice-to-know: every failure is logged and
 * swallowed, and nothing waits for it.
 *
 * PRIVACY. Stored: the bucket (a campaign code, "_direct" or "_referral"),
 * the London day and a count. The user agent is read only to skip link
 * preview fetchers and is never stored; no address is read at all.
 */
import { db } from "../db";
import { isLinkPreviewFetcher, poolVisitBucket, poolVisitDay } from "./visit-rules";

/** The bucket counted, or null when nothing was (a fetcher, or a failure). */
export async function recordPoolVisit(a: {
  source: { campaignCode: string | null; referralCode: string | null };
  userAgent: string | null;
  now: Date;
}): Promise<string | null> {
  if (isLinkPreviewFetcher(a.userAgent)) return null;
  try {
    const campaignLive =
      !a.source.referralCode && !!a.source.campaignCode
        ? !!(await db.poolCampaign.findFirst({ where: { code: a.source.campaignCode, active: true }, select: { code: true } }))
        : false;
    const code = poolVisitBucket(a.source, { campaignLive });
    const day = poolVisitDay(a.now);
    // One statement: two visits at once both count.
    await db.$executeRaw`INSERT INTO "PoolCampaignVisit" ("code", "day", "count") VALUES (${code}, ${day}::date, 1)
      ON CONFLICT ("code", "day") DO UPDATE SET "count" = "PoolCampaignVisit"."count" + 1`;
    return code;
  } catch (err) {
    console.warn("[pool-visit] not counted:", err instanceof Error ? err.message : err);
    return null;
  }
}
