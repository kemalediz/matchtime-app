/**
 * THE PLAYER POOL BANNER, the thin I/O half of `banner-rules.ts`
 * (2026-10-28). Every call is for the SIGNED-IN person (the caller passes
 * the session's user id).
 *
 *   loadPoolBanner     the facts for his banner, then the rule: his clubs
 *                      with the pool open (as this request resolved the
 *                      platform switch), his pool profile, his two
 *                      dismissals, his share link, and whether his current
 *                      club still has to tell its players
 *   dismissPoolBanner  "Not interested" on one banner, for good
 *
 * The dismissals are two columns on "User" that the Prisma client ignores
 * (`@ignore` in schema.prisma), read and written here with raw SQL, so the
 * rest of the app never selects them. Before the migration
 * 20261028180000_pool_banner_dismissals is applied the read fails: no
 * banner, and "Not interested" answers "unavailable". Never a crash.
 */
import { db } from "../db";
import { normaliseLang, type Lang } from "../i18n/lang";
import { clubShareKey } from "./club-share-rules";
import { poolOffersOpenForClub } from "./flags";
import { loadPoolShare } from "./growth";
import { poolBannerFor, type PoolBannerKind } from "./banner-rules";
import type { PoolProfileStatus } from "./vocab";

type Env = Record<string, string | undefined>;

export interface PoolBannerView {
  kind: PoolBannerKind;
  /** The club's language (his pool profile's, once he is in the pool). */
  language: Lang;
  /** share only: WhatsApp's chat picker with his message and link. */
  whatsApp: string | null;
  /** "Tell your players about it" (his current club, owner or admin). */
  adminLine: boolean;
}

interface Dismissals {
  join: Date | null;
  share: Date | null;
}

/** His two dismissals; null when the columns are not there (or any read error). */
export async function readPoolBannerDismissals(userId: string): Promise<Dismissals | null> {
  try {
    const rows = await db.$queryRaw<{ j: Date | null; s: Date | null }[]>`
      SELECT "poolBannerJoinDismissedAt" AS j, "poolBannerShareDismissedAt" AS s FROM "User" WHERE id = ${userId}`;
    if (rows.length === 0) return null;
    return { join: rows[0].j ?? null, share: rows[0].s ?? null };
  } catch (err) {
    console.warn(`[pool-banner] dismissals unreadable: ${(err as Error).message?.split("\n")[0]}`);
    return null;
  }
}

export async function loadPoolBanner(userId: string, opts: { env: Env; currentOrgId: string | null }): Promise<PoolBannerView | null> {
  const memberships = await db.membership.findMany({
    where: { userId, leftAt: null, guestMatchId: null, org: { featurePlayerPool: true } },
    orderBy: { createdAt: "asc" },
    select: { orgId: true, role: true, org: { select: { featurePlayerPool: true, language: true } } },
  });
  const open = memberships.filter((m) => poolOffersOpenForClub(m.org, opts.env));
  if (open.length === 0) return null;

  const dismissals = await readPoolBannerDismissals(userId);
  if (!dismissals) return null;

  const profile = await db.poolProfile.findUnique({ where: { userId }, select: { status: true } });
  const poolStatus = (profile?.status as PoolProfileStatus | undefined) ?? null;
  const inPool = poolStatus === "active" || poolStatus === "paused";
  const share = inPool && !dismissals.share ? await loadPoolShare(userId) : null;

  // The admin line: only his CURRENT club, so the link to its settings
  // opens the right club.
  const current = open.find((m) => m.orgId === opts.currentOrgId) ?? null;
  let adminOfOpenClubNotShared = false;
  if (current && (current.role === "OWNER" || current.role === "ADMIN")) {
    const sent = await db.sentNotification.findUnique({ where: { key: clubShareKey(current.orgId) }, select: { key: true } });
    adminOfOpenClubNotShared = !sent;
  }

  const choice = poolBannerFor({
    dismissalsReadable: true,
    memberOfOpenClub: true,
    poolStatus,
    joinDismissedAt: dismissals.join,
    shareDismissedAt: dismissals.share,
    hasShareLink: !!share,
    adminOfOpenClubNotShared,
  });
  if (!choice) return null;
  const language = choice.kind === "share" && share ? share.language : normaliseLang((current ?? open[0]).org.language);
  return {
    kind: choice.kind,
    language,
    whatsApp: choice.kind === "share" && share ? share.messages[language].whatsApp : null,
    adminLine: choice.adminLine,
  };
}

export type DismissPoolBannerResult = { ok: true } | { ok: false; reason: "unavailable" };

/** "Not interested": the first dismissal's time is kept. */
export async function dismissPoolBanner(userId: string, kind: PoolBannerKind, now: Date = new Date()): Promise<DismissPoolBannerResult> {
  try {
    if (kind === "join") {
      await db.$executeRaw`UPDATE "User" SET "poolBannerJoinDismissedAt" = COALESCE("poolBannerJoinDismissedAt", ${now}) WHERE id = ${userId}`;
    } else {
      await db.$executeRaw`UPDATE "User" SET "poolBannerShareDismissedAt" = COALESCE("poolBannerShareDismissedAt", ${now}) WHERE id = ${userId}`;
    }
  } catch (err) {
    console.warn(`[pool-banner] dismiss failed: ${(err as Error).message?.split("\n")[0]}`);
    return { ok: false, reason: "unavailable" };
  }
  console.log(`[pool-banner] dismissed kind=${kind}`);
  return { ok: true };
}
