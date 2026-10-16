"use server";

/**
 * Asking a partner club for a player (slice S2, 2026-10-16): the match
 * page's button, and the partner organiser's approve page. Each action
 * proves who is asking here (a server action is a public endpoint); the
 * rules and writes are `src/lib/partner-ask.ts`.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { loadPartnerAskSettings } from "@/lib/club-partnership";
import { approvePartnerAsk, askRefusalText, declinePartnerAsk, requestPartnerAsk } from "@/lib/partner-ask";

async function sessionUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  return session.user.id;
}

/** The match page's "Ask <partner> for a player". OWNER or ADMIN only. */
export async function requestPartnerAskAction(matchId: string, partnershipId: string): Promise<{ ok: boolean; message: string }> {
  const userId = await sessionUserId();
  const match = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true, org: { select: { language: true } } } } } });
  if (!match) throw new Error("Not found");
  const orgId = match.activity.orgId;
  await requireOrgAdmin(userId, orgId);
  const lang = match.activity.org.language;
  const r = await requestPartnerAsk({ askerOrgId: orgId, matchId, partnershipId, requestedByUserId: userId, via: "button" });
  revalidatePath(`/matches/${matchId}`);
  const s = t(lang);
  if (r.ok) {
    return { ok: true, message: r.status === "posted" ? s.xask_posted_toast({ partner: r.partnerName }) : s.xask_asked_toast({ partner: r.partnerName }) };
  }
  const cutoff = (await loadPartnerAskSettings(orgId))?.cutoffHours ?? 4;
  return { ok: false, message: askRefusalText(lang, r.refusal, r.partnerName, cutoff) };
}

/** The partner organiser's answer on the approve page. The writer checks
 *  they are an OWNER or ADMIN of the club that was asked. */
export async function answerPartnerAskAction(askId: string, answer: "yes" | "no"): Promise<{ ok: boolean; outcome: string }> {
  const userId = await sessionUserId();
  const r = answer === "yes" ? await approvePartnerAsk({ askId, userId }) : await declinePartnerAsk({ askId, userId });
  revalidatePath(`/partner-asks/${askId}`);
  return { ok: r.ok, outcome: r.outcome };
}
