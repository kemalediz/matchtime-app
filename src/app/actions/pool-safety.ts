"use server";

/**
 * No-shows, blocks, reports and a person looking at a pause (player pool,
 * slice L7). A server action is a public endpoint, so each one proves who
 * is asking before `src/lib/pool/no-shows.ts` or `safety.ts` does anything:
 *
 *   organisers   an owner or admin of the club (`requireOrgAdmin`), for
 *                marking a no-show, blocking a guest and reporting one;
 *   the player   the SIGNED-IN person, for his own blocks, reports and
 *                review request (nothing in the request names whose);
 *   the owner    `isSuperadmin`, for the safety page's two buttons.
 *
 * The offer page's block and report live with its other answers
 * (`app/play/offer/actions.ts`), behind the offer holder's proof.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isOrgAdmin, isSuperadmin } from "@/lib/org";
import { markGuestNoShow } from "@/lib/pool/no-shows";
import { POOL_MANAGE_PATH } from "@/lib/pool/paths";
import { POOL_SAFETY_PATH, liftPoolPause, markReportReviewed, reportFromClub, reportFromPlayer, requestPauseReview, setClubBlock, setPlayerBlock } from "@/lib/pool/safety";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

type Result = { ok: true } | { ok: false; reason: string };

async function me(): Promise<string | null> {
  return (await auth())?.user?.id ?? null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length < 200 ? v : null);

/** "Didn't turn up" / "Turned up" on the match page. */
export async function markGuestNoShowAction(matchId: unknown, userId: unknown, noShow: unknown): Promise<Result> {
  const actor = await me();
  const m = str(matchId);
  const u = str(userId);
  if (!actor || !m || !u || typeof noShow !== "boolean") return { ok: false, reason: "invalid" };
  const match = await db.match.findUnique({ where: { id: m }, select: { activity: { select: { orgId: true } } } });
  if (!match || !(await isOrgAdmin(actor, match.activity.orgId))) return { ok: false, reason: "not-allowed" };
  const r = await markGuestNoShow({ orgId: match.activity.orgId, matchId: m, userId: u, byUserId: actor, noShow });
  revalidatePath(`/matches/${m}`);
  return r.ok ? { ok: true } : r;
}

/** The guest card: stop (or start again) offering this club's games to him. */
export async function setGuestBlockAction(orgId: unknown, userId: unknown, blocked: unknown): Promise<Result> {
  const actor = await me();
  const o = str(orgId);
  const u = str(userId);
  if (!actor || !o || !u || typeof blocked !== "boolean") return { ok: false, reason: "invalid" };
  if (!(await isOrgAdmin(actor, o))) return { ok: false, reason: "not-allowed" };
  return setClubBlock({ orgId: o, userId: u, byUserId: actor, blocked });
}

/** The guest card: report a problem with him to the MatchTime team. */
export async function reportGuestAction(orgId: unknown, userId: unknown, text: unknown, matchId: unknown = null): Promise<Result> {
  const actor = await me();
  const o = str(orgId);
  const u = str(userId);
  if (!actor || !o || !u) return { ok: false, reason: "invalid" };
  if (!(await isOrgAdmin(actor, o))) return { ok: false, reason: "not-allowed" };
  return reportFromClub({ orgId: o, userId: u, byUserId: actor, text, matchId: str(matchId), env: await poolEnvForRequest() });
}

/** His manage page: stop (or start again) one club's offers. */
export async function setOwnClubBlockAction(orgId: unknown, blocked: unknown): Promise<Result> {
  const userId = await me();
  const o = str(orgId);
  if (!userId || !o || typeof blocked !== "boolean") return { ok: false, reason: "invalid" };
  const r = await setPlayerBlock({ userId, orgId: o, blocked });
  revalidatePath(POOL_MANAGE_PATH);
  return r;
}

/** His manage page: report a problem with a club to the MatchTime team. */
export async function reportClubAction(orgId: unknown, text: unknown): Promise<Result> {
  const userId = await me();
  const o = str(orgId);
  if (!userId || !o) return { ok: false, reason: "invalid" };
  return reportFromPlayer({ userId, orgId: o, text });
}

/** His manage page: ask a person to look at a pause MatchTime decided. */
export async function requestPauseReviewAction(): Promise<Result> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  const r = await requestPauseReview(userId);
  revalidatePath(POOL_MANAGE_PATH);
  return r;
}

/** The owner's safety page. */
export async function markPoolReportReviewedAction(reportId: unknown): Promise<Result> {
  const actor = await me();
  const id = str(reportId);
  if (!actor || !id || !(await isSuperadmin(actor))) return { ok: false, reason: "not-allowed" };
  const ok = await markReportReviewed(id, actor);
  revalidatePath(POOL_SAFETY_PATH);
  return ok ? { ok: true } : { ok: false, reason: "gone" };
}

export async function liftPoolPauseAction(userId: unknown): Promise<Result> {
  const actor = await me();
  const u = str(userId);
  if (!actor || !u || !(await isSuperadmin(actor))) return { ok: false, reason: "not-allowed" };
  const ok = await liftPoolPause(u, actor, new Date(), await poolEnvForRequest());
  revalidatePath(POOL_SAFETY_PATH);
  return ok ? { ok: true } : { ok: false, reason: "gone" };
}
