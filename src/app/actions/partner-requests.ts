"use server";

/**
 * PLACEHOLDER (partner discovery, slice P2, 2026-10-22). Slice P3 builds
 * the real file at this exact path with this exact signature: sending a
 * partner request to each club ticked on /admin/partners/find (plan
 * MDs/partner-discovery-plan-2026-10-21.md, section 3.1). On merge, P3's
 * version replaces this one whole. It does nothing and writes nothing, so
 * the find page compiles and shows "Couldn't send" until P3 lands.
 */

export type SendPartnerRequestsResult = {
  ok: boolean;
  error?: string;
  results?: Array<{ orgId: string; outcome: "sent" | "refused"; reason?: string }>;
  /** Only the nearest 20 were sent (the daily cap, D-4). */
  capped?: boolean;
};

export async function sendPartnerRequestsAction(input: { partnerOrgIds: string[] }): Promise<SendPartnerRequestsResult> {
  void input;
  return { ok: false, error: "not-built" };
}
