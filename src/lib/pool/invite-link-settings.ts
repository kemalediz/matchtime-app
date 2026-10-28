/**
 * THE SETTINGS CARD FOR A CLUB'S GROUP INVITE LINK (local player pool L8).
 * Thin I/O over `invite-link.ts`: what the card shows (where the link comes
 * from now) and saving a pasted link. The caller proved the actor is an
 * owner or admin of the club.
 *
 * Shown only to a club with the player pool open (the platform switch and
 * the club's own, `poolOffersOpenForClub`; review of #406, M4: live clubs
 * unchanged), like the Invite to club button. `env` is the request's
 * resolved pool switch (`switch-env.ts`).
 *
 * REPLACING OR REMOVING the link (review M2): every link DM not handed to
 * the Pi yet is cancelled and its invitation goes back to waiting, so the
 * guest gets the CURRENT link (at once with a new one; by the sweep once
 * there is a source again). MatchTime cannot tell from a pasted link which
 * group it opens (that needs a call to WhatsApp), so the card warns against
 * pasting the admin group's link instead (decision L8.16).
 */
import { db } from "../db";
import { readPostState } from "../group-postability-store";
import { deliverWaitingLinks, retractUnsentLinks } from "./club-invitation";
import { poolOffersOpenForClub } from "./flags";
import { inviteLinkSource, isGroupInviteCodeJobsOn, parseGroupInviteLink } from "./invite-link";

type Env = Record<string, string | undefined>;

export interface InviteLinkSettings {
  /** Where the link comes from now. */
  mode: "bot" | "pasted" | "none";
  /** The pasted link (shown to the club's own organisers only). */
  link: string | null;
  botIsAdmin: boolean;
}

export async function loadInviteLinkSettings(orgId: string, env: Env): Promise<InviteLinkSettings | null> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { whatsappGroupId: true, groupInviteLink: true, featurePlayerPool: true } });
  if (!org || !poolOffersOpenForClub(org, env)) return null;
  const state = org.whatsappGroupId ? await readPostState(org.whatsappGroupId) : null;
  const botIsAdmin = state?.botIsAdmin === true;
  const source = inviteLinkSource({ groupId: org.whatsappGroupId, botIsAdmin, codeJobsOn: isGroupInviteCodeJobsOn(env), pastedLink: org.groupInviteLink });
  return { mode: source.kind, link: org.groupInviteLink, botIsAdmin };
}

export type SaveInviteLinkResult = { ok: true; link: string | null; sent: number } | { ok: false; reason: "invalid" | "hidden" };

export async function saveInviteLink(args: { orgId: string; input: unknown; byUserId: string; now?: Date; env: Env }): Promise<SaveInviteLinkResult> {
  const org = await db.organisation.findUnique({ where: { id: args.orgId }, select: { featurePlayerPool: true, groupInviteLink: true } });
  if (!org || !poolOffersOpenForClub(org, args.env)) return { ok: false, reason: "hidden" };
  const parsed = parseGroupInviteLink(args.input, { allowEmpty: true });
  if (!parsed.ok) return { ok: false, reason: "invalid" };
  const now = args.now ?? new Date();
  const changed = org.groupInviteLink !== parsed.link;
  await db.organisation.update({
    where: { id: args.orgId },
    data: { groupInviteLink: parsed.link, groupInviteLinkSetAt: parsed.link ? now : null, groupInviteLinkSetById: parsed.link ? args.byUserId : null },
  });
  // A link taken back: the DMs carrying the old one that have not gone are
  // cancelled and wait for the current one. Never logged: the link is the
  // club's (decision L8.17).
  if (changed && org.groupInviteLink) await retractUnsentLinks(args.orgId, now);
  // Approved guests waiting for a link get the new one now.
  const sent = parsed.link ? await deliverWaitingLinks(args.orgId, now, args.env) : 0;
  return { ok: true, link: parsed.link, sent };
}
