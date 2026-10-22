"use server";

/**
 * Sending partner requests from "Find clubs near you" (partner discovery,
 * slice P3, 2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md,
 * sections 3.1 and 3.4.
 *
 * The search page (P2, #374) calls `sendPartnerRequestsAction` with the
 * clubs ticked, in the order it lists them (nearest first). A server
 * action is a public endpoint, so who is asking is proven here, for real:
 * the club is the caller's active club (`getUserOrg`), and only its OWNERS
 * and ADMINS may send (`isOrgAdmin`). The decisions and the writes are
 * `requestPartnerships` (src/lib/club-partnership.ts): one row per club,
 * at most 20 new requests a London day (a "select all" beyond that sends
 * the nearest 20 and says so, `capped`), 50 pending, the 30-day wait,
 * blocks.
 *
 * The result is the shape the search page reads. Each refusal's `reason`
 * is one of the codes the page has copy for (`daily-cap`, `pending-cap`,
 * `cooldown`, `blocked`, `already-paired`, `pending`, `not-discoverable`);
 * the few others (`hidden`, `no-club`, `same-club`, `not-admin`) show the
 * page's generic "MatchTime couldn't send it." A club that accepts
 * requests automatically is "sent" too: the request went, and was accepted.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { requestPartnerships } from "@/lib/club-partnership";
import type { ClubRole, RequestRefusal } from "@/lib/club-partnership-rules";

export interface SendPartnerRequestsResult {
  ok: boolean;
  /** Why nothing was sent at all: "not-signed-in", "no-club", "not-admin". */
  error?: string;
  /** One line per club asked, in the order given. */
  results?: Array<{ orgId: string; outcome: "sent" | "refused"; reason?: string }>;
  /** The day's 20 stopped part of the selection: "Sent to the nearest N"
   *  (`pr_capped_note`). */
  capped?: boolean;
}

/** The writer's refusal, as the search page names it. */
function reasonFor(refusal: RequestRefusal): string {
  switch (refusal) {
    case "already-pending":
      return "pending";
    case "not-listed":
      return "not-discoverable";
    default:
      return refusal;
  }
}

export async function sendPartnerRequestsAction(input: { partnerOrgIds: string[] }): Promise<SendPartnerRequestsResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "not-signed-in" };
  const membership = await getUserOrg(userId);
  if (!membership) return { ok: false, error: "no-club" };
  const orgId = membership.orgId;
  if (!(await isOrgAdmin(userId, orgId))) return { ok: false, error: "not-admin" };
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, leftAt: true } });
  const role: ClubRole = m && !m.leftAt && m.role === "OWNER" ? "OWNER" : "ADMIN";

  const ids = Array.isArray(input?.partnerOrgIds) ? input.partnerOrgIds.filter((x): x is string => typeof x === "string") : [];
  const r = await requestPartnerships({ askerOrgId: orgId, userId, role, partnerOrgIds: ids });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/partners/find");
  return {
    ok: true,
    results: r.results.map((x) =>
      x.outcome === "refused" ? { orgId: x.partnerOrgId, outcome: "refused", reason: reasonFor(x.refusal) } : { orgId: x.partnerOrgId, outcome: "sent" },
    ),
    capped: r.capped,
  };
}
