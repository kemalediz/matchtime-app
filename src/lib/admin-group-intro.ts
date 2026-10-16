/**
 * MATCHTIME INTRODUCES ITSELF IN A CLUB'S ADMIN GROUP, ONCE (2026-10-15).
 *
 * FNF HQ was linked and got only "✅ Linked as the admin group for FNF.";
 * another organiser asked "Whats this?". Now every newly linked admin group
 * gets MatchTime's introduction (`buildAdminGroupIntro`, admin-group-help.ts,
 * worded for the club's own settings) as the link command's reply, and a
 * group linked before this gets the same text from
 * `scripts/send-hq-intro.ts`.
 *
 * ONCE PER CLUB AND GROUP: a `SentNotification` claim keyed
 * `hq-intro:<orgId>:<groupId>`. Linking the same group again after an
 * unlink gets the short "Linked as the admin group" line instead.
 *
 *   introduceOnLink(orgId, groupId)   the link command's reply text, or null
 *                                     when that group already had it;
 *   sendHqIntro({ orgId, apply })     the script: dry run by default; with
 *                                     `apply`, claims the key and queues ONE
 *                                     `admin-group` BotJob, the path every
 *                                     admin-group post outside a reply takes
 *                                     (admin-channel.ts
 *                                     `adminGroupJobInstruction`: posted in
 *                                     the group, 09:00 to 22:59 London).
 *                                     With `markSent`, only claims the key:
 *                                     for an intro already posted by hand.
 *
 * ONLY A NEW LINK SENDS ON ITS OWN. `introduceOnLink` is called from one
 * place, `linkAdminGroup`, after its compare-and-set linked the group; a
 * group that was already linked returns "already-linked" before it. Nothing
 * on a message, a poll or a deploy introduces an already-linked group:
 * that is this script, run by hand.
 *
 * NO MODEL. Reads the club's row and its active games' weekdays only.
 */
import { db } from "./db";
import { buildAdminGroupIntro, type AdminGroupIntroClub } from "./admin-group-help";
import { isGroupPostable } from "./group-postability-store";

const CLAIM_KIND = "admin-notice";

export const hqIntroKey = (orgId: string, groupId: string): string => `hq-intro:${orgId}:${groupId}`;

const INTRO_SELECT = {
  id: true,
  name: true,
  language: true,
  whatsappBotEnabled: true,
  squadMode: true,
  benchPickMode: true,
  listAnnouncer: true,
  teamsReadyTime: true,
  featureAttendance: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  adminGroupId: true,
  adminChannelMode: true,
} as const;

type IntroRow = Omit<AdminGroupIntroClub, "activityDays"> & {
  id: string;
  adminGroupId: string | null;
  adminChannelMode: string | null;
};

async function loadIntro(orgId: string): Promise<{ row: IntroRow; text: string } | null> {
  const row = (await db.organisation.findUnique({ where: { id: orgId }, select: INTRO_SELECT })) as IntroRow | null;
  if (!row) return null;
  const activities = (await db.activity.findMany({ where: { orgId, isActive: true }, select: { dayOfWeek: true } })) ?? [];
  return { row, text: buildAdminGroupIntro({ ...row, activityDays: activities.map((a) => a.dayOfWeek) }) };
}

/** Claim the one introduction for this club and group. True when this call won it. */
async function claim(orgId: string, groupId: string): Promise<boolean> {
  const { count } = await db.sentNotification.createMany({
    data: [{ key: hqIntroKey(orgId, groupId), kind: CLAIM_KIND }],
    skipDuplicates: true,
  });
  return count === 1;
}

/**
 * The link command's reply for a group just linked: the introduction, or
 * null when this club already introduced itself in this group (the caller
 * then says the short "Linked as the admin group" line). A failed claim
 * still introduces: the link is made, and a silent one is what this fixes.
 */
export async function introduceOnLink(orgId: string, groupId: string): Promise<string | null> {
  const intro = await loadIntro(orgId);
  if (!intro) return null;
  try {
    if (!(await claim(orgId, groupId))) return null;
  } catch (err) {
    console.error(`[admin-group-intro] ${orgId}: intro claim failed, introducing anyway: ${(err as Error)?.name ?? "error"}`);
  }
  return intro.text;
}

export type SendHqIntroResult =
  | { status: "refused"; orgId: string; reason: "no-club" | "no-admin-group" | "admin-messages-not-to-group" | "group-not-postable" | "already-introduced"; text?: string }
  | { status: "dry-run"; orgId: string; club: string; groupId: string; key: string; text: string }
  | { status: "queued"; orgId: string; club: string; groupId: string; key: string; text: string; jobId: string }
  | { status: "dry-run-mark" | "marked"; orgId: string; club: string; groupId: string; key: string; text?: undefined };

/**
 * `scripts/send-hq-intro.ts`: introduce MatchTime in a group linked before
 * the introduction existed. Refuses when the club has no linked admin
 * group, when its admin messages do not go to that group (the BotJob would
 * then go to the owner by DM, where "here" is wrong), when MatchTime cannot
 * post there, or when the key is already claimed. Never sends twice.
 */
export async function sendHqIntro(args: { orgId: string; apply: boolean; markSent?: boolean }): Promise<SendHqIntroResult> {
  const { orgId, apply } = args;
  const intro = await loadIntro(orgId);
  if (!intro) return { status: "refused", orgId, reason: "no-club" };
  const { row, text } = intro;
  const groupId = row.adminGroupId;
  if (!groupId) return { status: "refused", orgId, reason: "no-admin-group", text };

  // --mark-sent: the introduction was posted by hand (FNF HQ, 2026-10-15).
  // Claim the key only, so nothing ever sends it again. No message, so the
  // channel mode and posting rights do not matter.
  if (args.markSent) {
    const key = hqIntroKey(orgId, groupId);
    if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) {
      return { status: "refused", orgId, reason: "already-introduced" };
    }
    if (!apply) return { status: "dry-run-mark", orgId, club: row.name, groupId, key };
    if (!(await claim(orgId, groupId))) return { status: "refused", orgId, reason: "already-introduced" };
    return { status: "marked", orgId, club: row.name, groupId, key };
  }
  if (row.adminChannelMode !== "admin-group") return { status: "refused", orgId, reason: "admin-messages-not-to-group", text };
  if (!(await isGroupPostable(groupId))) return { status: "refused", orgId, reason: "group-not-postable", text };
  const key = hqIntroKey(orgId, groupId);
  if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) {
    return { status: "refused", orgId, reason: "already-introduced", text };
  }
  if (!apply) return { status: "dry-run", orgId, club: row.name, groupId, key, text };

  const jobId = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key, kind: CLAIM_KIND }], skipDuplicates: true });
    if (count !== 1) return null;
    const job = await tx.botJob.create({ data: { orgId, kind: "admin-group", text } });
    return job.id;
  });
  if (!jobId) return { status: "refused", orgId, reason: "already-introduced", text };
  return { status: "queued", orgId, club: row.name, groupId, key, text, jobId };
}
