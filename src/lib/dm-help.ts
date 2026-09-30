/**
 * "help" by DM (2026-09-30): the same deterministic help as the group.
 *
 * Kemal DMed MatchTime "help payments" after the first real self-setup;
 * DM help did not exist. This answers it with `buildHelpReply`, the SAME
 * builder the group's "@Match Time help" uses, so the two can never
 * disagree, and it never calls a model.
 *
 * WHICH CLUB. A DM has no group, so the club is the sender's:
 *   - one active club: that one;
 *   - several: the club they RUN (OWNER/ADMIN) when they run exactly one,
 *     because a help question from an organiser is almost always about
 *     their own club; otherwise the club with the most recent match among
 *     the ones they run, or among all of them when they run none (the
 *     same rule `pickRelevantOrgForUser` uses for DM questions). With more
 *     than one club the reply names the club on its first line, so an
 *     answer about the "wrong" club is at least never a silent one.
 * Only approved clubs count: an organiser whose club is waiting for
 * approval is silenced upstream, and a draft club is nobody's answer.
 *
 * WHO. The club's OWNER/ADMIN gets the admin lines (where its settings
 * live, how to switch a feature on) with links that sign them straight
 * in; everybody else gets the player-facing text and no link.
 *
 * WHERE THE REPLY GOES. To the number the DM came from. A signed-in link
 * is only minted when that number IS the account's own phone: a sender
 * resolved any other way gets public URLs, never a credential.
 */
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { getOrgFeatures } from "@/lib/org-features";
import { buildAdminLink } from "@/lib/admin-link";
import { APPROVED_CLUB_WHERE } from "@/lib/club-approval-state";
import { t } from "@/lib/i18n/t";
import {
  buildHelpReply,
  helpFeaturesFrom,
  helpPagesNeeded,
  readHelpRequest,
  HELP_ADMIN_PAGE_PATH,
  type HelpAdminPage,
  type HelpAudience,
  type HelpTopic,
} from "@/lib/onboarding-conversation";

export { readHelpRequest };

type HelpMembership = {
  orgId: string;
  role: "OWNER" | "ADMIN" | "PLAYER";
  org: { id: string; name: string; language: string };
};

const runs = (m: HelpMembership) => m.role === "OWNER" || m.role === "ADMIN";

/** The club a DM help question is answered for. See the header. */
export async function pickDmHelpClub(
  userId: string,
): Promise<{ membership: HelpMembership; clubCount: number } | null> {
  const memberships = (await db.membership.findMany({
    where: { userId, leftAt: null, org: APPROVED_CLUB_WHERE },
    select: { orgId: true, role: true, org: { select: { id: true, name: true, language: true } } },
    orderBy: { createdAt: "asc" },
  })) as HelpMembership[];
  if (memberships.length === 0) return null;
  if (memberships.length === 1) return { membership: memberships[0], clubCount: 1 };
  const admin = memberships.filter(runs);
  if (admin.length === 1) return { membership: admin[0], clubCount: memberships.length };
  const pool = admin.length > 1 ? admin : memberships;
  const recent = await db.match.findFirst({
    where: { activity: { orgId: { in: pool.map((m) => m.orgId) } } },
    orderBy: { date: "desc" },
    select: { activity: { select: { orgId: true } } },
  });
  const pick = pool.find((m) => m.orgId === recent?.activity.orgId) ?? pool[0];
  return { membership: pick, clubCount: memberships.length };
}

export type DmHelpOutcome = {
  handled: "dm-help";
  topic: HelpTopic | null;
  orgId: string;
  audience: HelpAudience;
};

/**
 * Answer a DM that is a help request. Returns null when the DM is not one
 * (or there is no club or no number to answer), and the caller carries on
 * down its handler list.
 */
export async function handleDmHelp(args: {
  userId: string;
  text: string;
  /** The number the DM came from, in any format; "" when unknown. */
  envelopePhone: string | null | undefined;
}): Promise<DmHelpOutcome | null> {
  const req = readHelpRequest(args.text, { dm: true });
  if (!req) return null;

  const picked = await pickDmHelpClub(args.userId);
  if (!picked) return null;
  const { membership, clubCount } = picked;

  const account = await db.user.findUnique({ where: { id: args.userId }, select: { phoneNumber: true } });
  const accountPhone = account?.phoneNumber ? normalisePhone(account.phoneNumber) : null;
  const envelope = args.envelopePhone
    ? normalisePhone(args.envelopePhone.startsWith("+") ? args.envelopePhone : `+${args.envelopePhone}`)
    : null;
  const replyTo = envelope ?? accountPhone;
  if (!replyTo) return null;
  const ownPhone = !!accountPhone && replyTo === accountPhone;

  const audience: HelpAudience = runs(membership) ? "admin" : "player";
  const links: Partial<Record<HelpAdminPage, string>> = {};
  if (audience === "admin" && ownPhone) {
    for (const page of helpPagesNeeded(req.topic, audience)) {
      links[page] = await buildAdminLink({
        userId: args.userId,
        orgId: membership.orgId,
        nextPath: HELP_ADMIN_PAGE_PATH[page],
      });
    }
  }

  const features = await getOrgFeatures(membership.orgId);
  const lang = features.language;
  const body = buildHelpReply(req.topic, helpFeaturesFrom(features), lang, { audience, links });
  const text = clubCount > 1 ? `${t(lang).onbHelpForClub({ club: membership.org.name })}\n\n${body}` : body;

  await db.botJob.create({
    data: { orgId: membership.orgId, kind: "dm", phone: replyTo.replace(/^\+/, ""), text },
  });
  return { handled: "dm-help", topic: req.topic, orgId: membership.orgId, audience };
}
