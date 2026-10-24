/**
 * THE OWNER'S CAMPAIGN CODES, the thin I/O half (slice G1, 2026-10-24):
 * the `PoolCampaign` rows behind `/play?src=CODE` (a LinkedIn post, a
 * leaflet run), and the sign-ups each brought. Rules in `growth-rules.ts`.
 * The owner page (`src/app/admin/pool/campaigns`) is superadmin only;
 * every caller checks that first.
 *
 * Counts only, never names: the page answers "how many", not "who".
 */
import { appBaseUrl } from "../app-url";
import { db } from "../db";
import { campaignSignupCounts, poolCampaignUrl, validateCampaignInput, type CampaignInputErrors } from "./growth-rules";

export interface PoolCampaignRow {
  code: string;
  source: string;
  label: string;
  active: boolean;
  createdAt: Date;
  url: string;
  waiting: number;
  confirmed: number;
}

export async function listPoolCampaigns(): Promise<PoolCampaignRow[]> {
  const [campaigns, grouped] = await Promise.all([
    db.poolCampaign.findMany({ orderBy: { createdAt: "desc" } }),
    db.poolProfile.groupBy({ by: ["sourceCode", "status"], where: { source: "campaign" }, _count: { _all: true } }),
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
    ...(counts.get(c.code) ?? { waiting: 0, confirmed: 0 }),
  }));
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
