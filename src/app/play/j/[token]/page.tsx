import type { Metadata } from "next";
import { isPoolSignupPaused } from "@/lib/pool/flags";
import { signupGoesOnEarlyListForPage } from "@/lib/pool/flags-page";
import { openPartnerPoolInvite } from "@/lib/pool/partner-invite";
import { PartnerInvitePage } from "./partner-invite-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MatchTime", robots: { index: false, follow: false } };

/**
 * THE PARTNER POOL INVITE (2026-11-02): a partner club's player, after he
 * played for another club through a partner ask, joins the local player
 * pool from the link in his one DM. Public: the signed token names him
 * (`partner-invite-token.ts`). The /play fields, filled in from what his
 * club knows, the two ticks, one Join button, and no WhatsApp code: the
 * link came to his own number. Opening it changes nothing. Expired or not
 * ours, already in the pool, or stopped (start again in place): each says
 * so. Only the last 4 digits of his number reach the page.
 */
export default async function PartnerInviteRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await openPartnerPoolInvite(token, { earlyList: await signupGoesOnEarlyListForPage(), signupsPaused: isPoolSignupPaused() });
  return <PartnerInvitePage token={token} view={view} />;
}
