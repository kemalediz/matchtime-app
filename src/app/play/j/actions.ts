"use server";

/**
 * The partner pool invite's page, /play/j/<token> (2026-11-02). A server
 * action is a public endpoint: the signed token (`partner-invite-token.ts`)
 * names whose join this is, bound to him and for 14 days; it came to his
 * own WhatsApp, so no code step follows. The writes are the pool's own
 * (`src/lib/pool/partner-invite.ts`): the member join, or the manage page's
 * restart. The same validator as /play (`validatePublicPoolSignup`: the fields,
 * 18 or over and the consent, both ticked).
 */
import { isPoolSignupPaused } from "@/lib/pool/flags";
import { signupGoesOnEarlyListForPage } from "@/lib/pool/flags-page";
import { joinFromPartnerInvite, restartFromPartnerInvite } from "@/lib/pool/partner-invite";
import { validatePublicPoolSignup, type PoolFieldErrors } from "@/lib/pool/profile-fields";

export type PartnerInviteActionResult = { ok: true } | { ok: false; reason: string; errors?: PoolFieldErrors };

export async function joinPartnerInviteAction(token: string, payload: unknown): Promise<PartnerInviteActionResult> {
  try {
    if (isPoolSignupPaused()) return { ok: false, reason: "paused" };
    const valid = validatePublicPoolSignup(payload);
    if (!valid.ok) return { ok: false, reason: "invalid", errors: valid.errors };
    return await joinFromPartnerInvite(String(token), valid.value, { earlyList: await signupGoesOnEarlyListForPage() });
  } catch (err) {
    console.error("[pool-partner-invite] the page's join failed:", err instanceof Error ? err.message : "failed");
    return { ok: false, reason: "generic" };
  }
}

export async function restartPartnerInviteAction(token: string, consent: boolean): Promise<PartnerInviteActionResult> {
  try {
    if (consent !== true) return { ok: false, reason: "consent" };
    return await restartFromPartnerInvite(String(token), true);
  } catch (err) {
    console.error("[pool-partner-invite] the page's restart failed:", err instanceof Error ? err.message : "failed");
    return { ok: false, reason: "generic" };
  }
}
