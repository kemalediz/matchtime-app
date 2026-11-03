/**
 * THE OWNER'S CAMPAIGN CODES, the thin I/O half (slice G1, 2026-10-24):
 * the `PoolCampaign` rows behind `/play?src=CODE` (a LinkedIn post, a
 * leaflet run), and the sign-ups each brought. Rules in `growth-rules.ts`.
 * The owner page (`src/app/admin/pool/campaigns`) is superadmin only;
 * every caller checks that first.
 *
 * Counts only, never names: the page answers "how many", not "who".
 *
 * A club's own code (source "club", slice G3) is made here too, by
 * `ensureClubPoolCampaign`, for that club's one share post: never from the
 * owner page, which knows no club.
 */
import { appBaseUrl } from "../app-url";
import { db } from "../db";
import { clubShareCampaignCode, clubShareCampaignLabel } from "./club-share-rules";
import { campaignSignupCounts, poolCampaignUrl, validateCampaignInput, type CampaignInputErrors } from "./growth-rules";
import { POOL_VISIT_DIRECT, POOL_VISIT_REFERRAL, poolVisitTotals } from "./visit-rules";

export interface PoolCampaignRow {
  code: string;
  source: string;
  label: string;
  active: boolean;
  createdAt: Date;
  url: string;
}

/** One way in's numbers: visits to /play (counted since 2026-11-03, link
 *  preview fetchers never), sign-ups started (the form sent: waiting and
 *  confirmed together), confirmed on WhatsApp, and still waiting. */
export interface PoolWayInNumbers {
  visits: number;
  started: number;
  confirmed: number;
  waiting: number;
}

const numbers = (visits: number | undefined, s: { waiting: number; confirmed: number } | undefined): PoolWayInNumbers => {
  const waiting = s?.waiting ?? 0;
  const confirmed = s?.confirmed ?? 0;
  return { visits: visits ?? 0, started: waiting + confirmed, confirmed, waiting };
};

async function visitTotals(): Promise<Map<string, number>> {
  const rows = await db.poolCampaignVisit.groupBy({ by: ["code"], _sum: { count: true } });
  return poolVisitTotals(rows.map((r) => ({ code: r.code, count: r._sum.count })));
}

export async function listPoolCampaigns(): Promise<Array<PoolCampaignRow & PoolWayInNumbers>> {
  const [campaigns, grouped, visits] = await Promise.all([
    db.poolCampaign.findMany({ orderBy: { createdAt: "desc" } }),
    db.poolProfile.groupBy({ by: ["sourceCode", "status"], where: { source: "campaign" }, _count: { _all: true } }),
    visitTotals(),
  ]);
  const counts = campaignSignupCounts(grouped.map((g) => ({ sourceCode: g.sourceCode, status: g.status, count: g._count._all })));
  const base = appBaseUrl();
  return campaigns.map((c) => ({
    code: c.code,
    source: c.source,
    label: c.label,
    active: c.active,
    createdAt: c.createdAt,
    url: poolCampaignUrl(base, c.code),
    ...numbers(visits.get(c.code), counts.get(c.code)),
  }));
}

/**
 * The ways in with no campaign code, compared the same way: plain /play
 * (direct visits against the "web" sign-ups, which include a switched-off
 * or unknown code) and a friend's link (referral visits against the
 * "referral" sign-ups).
 */
export async function poolWaysInWithoutCode(): Promise<{ direct: PoolWayInNumbers; referral: PoolWayInNumbers }> {
  const [grouped, visits] = await Promise.all([
    db.poolProfile.groupBy({ by: ["source", "status"], where: { source: { in: ["web", "referral"] } }, _count: { _all: true } }),
    visitTotals(),
  ]);
  const counts = campaignSignupCounts(grouped.map((g) => ({ sourceCode: g.source, status: g.status, count: g._count._all })));
  return {
    direct: numbers(visits.get(POOL_VISIT_DIRECT), counts.get("web")),
    referral: numbers(visits.get(POOL_VISIT_REFERRAL), counts.get("referral")),
  };
}

export type CreateCampaignResult = { ok: true; code: string } | { ok: false; errors: CampaignInputErrors } | { ok: false; reason: "taken" };

export async function createPoolCampaign(raw: unknown): Promise<CreateCampaignResult> {
  const v = validateCampaignInput(raw);
  if (!v.ok) return v;
  try {
    await db.poolCampaign.create({ data: v.value });
    return { ok: true, code: v.value.code };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return { ok: false, reason: "taken" };
    throw err;
  }
}

/** A code switched off stops stamping new sign-ups (they count as the web);
 *  its link still opens /play, and its numbers stay. */
export async function setPoolCampaignActive(code: string, active: boolean): Promise<boolean> {
  const { count } = await db.poolCampaign.updateMany({ where: { code }, data: { active } });
  return count === 1;
}

/** The link for a QR code, or null for a code that does not exist. */
export async function poolCampaignLink(code: string): Promise<string | null> {
  const c = await db.poolCampaign.findUnique({ where: { code }, select: { code: true } });
  return c ? poolCampaignUrl(appBaseUrl(), c.code) : null;
}

/** How many "-2", "-3" a club's code may try before giving up. */
const CLUB_CODE_ATTEMPTS = 10;

/**
 * The club's own campaign link (slice G3, its share post), made the first
 * time it is needed and the same ever after: "/play?src=club-<slug>", or
 * "club-<slug>-2" in the rare case that code is someone else's. Two pages
 * at once make ONE code (the code is the key; the loser reads it back).
 * Null only if every attempt was taken.
 */
export async function ensureClubPoolCampaign(org: { id: string; slug: string; name: string }): Promise<string | null> {
  const base = appBaseUrl();
  const existing = await db.poolCampaign.findFirst({ where: { source: "club", orgId: org.id }, orderBy: { createdAt: "asc" }, select: { code: true } });
  if (existing) return poolCampaignUrl(base, existing.code);
  for (let attempt = 1; attempt <= CLUB_CODE_ATTEMPTS; attempt++) {
    const code = clubShareCampaignCode(org.slug, attempt);
    try {
      await db.poolCampaign.create({ data: { code, source: "club", label: clubShareCampaignLabel(org.name), orgId: org.id } });
      return poolCampaignUrl(base, code);
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err;
      const taken = await db.poolCampaign.findUnique({ where: { code }, select: { source: true, orgId: true } });
      if (taken?.source === "club" && taken.orgId === org.id) return poolCampaignUrl(base, code);
    }
  }
  return null;
}
