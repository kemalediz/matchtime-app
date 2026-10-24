/**
 * THE SETTINGS CARD FOR A CLUB'S GROUP INVITE LINK (local player pool L8).
 * Thin I/O over `invite-link.ts`: what the card shows (where the link comes
 * from now) and saving a pasted link. The caller proved the actor is an
 * owner or admin of the club.
 *
 * Shown only to a club that can invite guests: the same rule as the Guest
 * players tab (`guestPlayersTabShown`, decision L5b.1), so every other
 * club's settings page is unchanged.
 */
import { db } from "../db";
import { readPostState } from "../group-postability-store";
import { deliverWaitingLinks } from "./club-invitation";
import { guestPlayersTabShown } from "./guest-report-loader";
import { inviteLinkSource, isGroupInviteCodeJobsOn, parseGroupInviteLink } from "./invite-link";

type Env = Record<string, string | undefined>;

export interface InviteLinkSettings {
  /** Where the link comes from now. */
  mode: "bot" | "pasted" | "none";
  /** The pasted link (shown to the club's own organisers only). */
  link: string | null;
  botIsAdmin: boolean;
}

export async function loadInviteLinkSettings(orgId: string, env: Env = process.env): Promise<InviteLinkSettings | null> {
  if (!(await guestPlayersTabShown(orgId))) return null;
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { whatsappGroupId: true, groupInviteLink: true } });
  if (!org) return null;
  const state = org.whatsappGroupId ? await readPostState(org.whatsappGroupId) : null;
  const botIsAdmin = state?.botIsAdmin === true;
  const source = inviteLinkSource({ groupId: org.whatsappGroupId, botIsAdmin, codeJobsOn: isGroupInviteCodeJobsOn(env), pastedLink: org.groupInviteLink });
  return { mode: source.kind, link: org.groupInviteLink, botIsAdmin };
}

export type SaveInviteLinkResult = { ok: true; link: string | null; sent: number } | { ok: false; reason: "invalid" | "hidden" };

export async function saveInviteLink(args: { orgId: string; input: unknown; byUserId: string; now?: Date; env?: Env }): Promise<SaveInviteLinkResult> {
  if (!(await guestPlayersTabShown(args.orgId))) return { ok: false, reason: "hidden" };
  const parsed = parseGroupInviteLink(args.input, { allowEmpty: true });
  if (!parsed.ok) return { ok: false, reason: "invalid" };
  const now = args.now ?? new Date();
  await db.organisation.update({
    where: { id: args.orgId },
    data: { groupInviteLink: parsed.link, groupInviteLinkSetAt: parsed.link ? now : null, groupInviteLinkSetById: parsed.link ? args.byUserId : null },
  });
  // Approved guests who were waiting because there was no link get it now.
  const sent = parsed.link ? await deliverWaitingLinks(args.orgId, now, args.env) : 0;
  return { ok: true, link: parsed.link, sent };
}
