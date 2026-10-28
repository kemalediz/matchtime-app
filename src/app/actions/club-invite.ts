"use server";

/**
 * JOINING A CLUB'S GROUP: the server actions (local player pool L8).
 *
 *   inviteToClub          the guest card's tap (Invite to club, Send the
 *                         invite link, Not now). OWNER or ADMIN of the club.
 *   getInviteLinkSettings the settings card: where the link comes from.
 *   setInviteLink         the settings card: paste or remove the link.
 *   answerMyInvitation    Join / No thanks on My invitations. The signed-in
 *                         player himself, for his own invitation only.
 *
 * Every rule is in src/lib/pool/ (club-invitation.ts and its pure rules);
 * these only check who is asking.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isOrgAdmin, requireOrgAdmin } from "@/lib/org";
import type { InviteToClubInput, InviteToClubResult } from "@/lib/pool/club-invite";
import { answerAsClub, answerAsPlayer, type PlayerAnswerResult } from "@/lib/pool/club-invitation";
import { loadInviteLinkSettings, saveInviteLink, type InviteLinkSettings, type SaveInviteLinkResult } from "@/lib/pool/invite-link-settings";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

async function sessionUserId(): Promise<string | null> {
  return (await auth())?.user?.id ?? null;
}

export async function inviteToClub(input: InviteToClubInput): Promise<InviteToClubResult> {
  const actorId = await sessionUserId();
  if (!actorId || typeof input?.orgId !== "string" || typeof input?.userId !== "string") return { ok: false, reason: "not-allowed" };
  if (!(await isOrgAdmin(actorId, input.orgId))) return { ok: false, reason: "not-allowed" };
  const r = await answerAsClub({ orgId: input.orgId, userId: input.userId, actorId, answer: input.answer === "no" ? "no" : "yes", env: await poolEnvForRequest() });
  if (r.ok) revalidatePath("/admin/guests");
  return r;
}

/** Null: the card is not shown for this club. */
export async function getInviteLinkSettings(orgId: string): Promise<InviteLinkSettings | null> {
  const userId = await sessionUserId();
  if (!userId) throw new Error("Not authenticated");
  await requireOrgAdmin(userId, orgId);
  return loadInviteLinkSettings(orgId, await poolEnvForRequest());
}

export async function setInviteLink(orgId: string, input: unknown): Promise<SaveInviteLinkResult> {
  const userId = await sessionUserId();
  if (!userId) throw new Error("Not authenticated");
  await requireOrgAdmin(userId, orgId);
  const r = await saveInviteLink({ orgId, input, byUserId: userId, env: await poolEnvForRequest() });
  if (r.ok) revalidatePath("/admin/settings");
  return r;
}

export async function answerMyInvitation(invitationId: string, answer: "join" | "no"): Promise<PlayerAnswerResult> {
  const userId = await sessionUserId();
  if (!userId || typeof invitationId !== "string") return "not-yours";
  // No revalidate: the card shows his answer in place; a reload lists only
  // what is still open.
  return answerAsPlayer({ invitationId, userId, answer: answer === "join" ? "join" : "no", env: await poolEnvForRequest() });
}
