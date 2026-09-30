/**
 * LINKING AN ADMIN WHATSAPP GROUP (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.3 and 2.4.
 *
 * An organiser presses "Link admin group" on the settings page, adds
 * MatchTime to the admins' HQ group and sends "@Match Time admin group
 * CODE" there. This module:
 *
 *   - makes the code (`createAdminGroupLinkCode`);
 *   - keeps the HQ group out of the in-group setup: an add by an owner or
 *     admin of an approved club (or, while a code is open, an add to a
 *     group one of that club's admins is in) is a CANDIDATE, recorded as a
 *     silent `UnsolicitedGroup` row waiting for its code
 *     (`detectAdminGroupCandidate`, `recordAdminGroupCandidate`);
 *   - links the group when the code arrives (`linkAdminGroup`), and
 *     answers only a real admin: anyone else hears nothing, so the command
 *     cannot be used to probe codes or clubs;
 *   - unlinks it from the settings page (`unlinkAdminGroup`) or when
 *     MatchTime is removed from it (`handleAdminGroupRemoved`);
 *   - lists the linked groups for the Pi (`loadAdminGroups`).
 *
 * IDENTITY is by phone, or by a LID pair the server stored itself (the
 * connect DM, the participant snapshots taken at a group add). Never by
 * pushname: it is whatever the sender chose to call themselves.
 *
 * NO MODEL anywhere here, and no message from an admin group is ever
 * analysed: the Pi forwards only the link command from a silent group.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { e164Digits, normalisePhone } from "./phone";
import { lidDigits } from "./connect-dm-rules";
import { parseParticipantSnapshot, snapshotPhone } from "./participant-snapshot";
import { ACTIVE_ONBOARDING_STAGES } from "./onboarding-parse";
import { APPROVED_CLUB_WHERE } from "./club-approval-state";
import {
  ADMIN_GROUP_CODE_TTL_MS,
  generateAdminGroupLinkCode,
  isAdminGroupCandidate,
  parseAdminGroupLinkMessage,
} from "./admin-channel-rules";
import { queuePlatformLeaveGroup } from "./platform-jobs";

const ADMIN_ROLES = { in: ["OWNER", "ADMIN"] as Array<"OWNER" | "ADMIN"> };

// ── Who is this? ─────────────────────────────────────────────────────────

function phoneOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (s.startsWith("+")) return normalisePhone(s);
  const digits = e164Digits(s.replace(/@.*$/, ""));
  return digits ? `+${digits}` : null;
}

/**
 * The users a WhatsApp sender can be, by phone first and then by a LID
 * the server stored against a user (connect DM) or a phone (a participant
 * snapshot). Usually one; empty for a stranger.
 */
export async function resolveSenderUserIds(input: {
  phones: Array<string | null | undefined>;
  lid?: string | null;
}): Promise<string[]> {
  const phones = new Set(input.phones.map(phoneOf).filter((p): p is string => !!p));
  const ids = new Set<string>();
  const lid = lidDigits(input.lid ?? null);

  if (lid) {
    const [connects, sessions] = await Promise.all([
      // Small tables (one row per connect request / setup); read only when
      // a LID-only sender needs resolving.
      db.clubConnect.findMany({ select: { userId: true, dmLid: true, participants: true } }),
      db.onboardingSession.findMany({ select: { participants: true } }),
    ]);
    for (const c of connects ?? []) {
      if (c.dmLid && lidDigits(c.dmLid) === lid) ids.add(c.userId);
    }
    for (const row of [...(connects ?? []), ...(sessions ?? [])]) {
      for (const p of parseParticipantSnapshot(row.participants)) {
        if (p.lidId && lidDigits(p.lidId) === lid) {
          const phone = snapshotPhone(p);
          if (phone) phones.add(phone);
        }
      }
    }
  }

  if (phones.size > 0) {
    const users = (await db.user.findMany({ where: { phoneNumber: { in: [...phones] } }, select: { id: true } })) ?? [];
    for (const u of users) ids.add(u.id);
  }
  return [...ids];
}

/** The approved clubs these users are an owner or admin of. */
async function adminClubsOf(
  userIds: string[],
): Promise<Array<{ userId: string; orgId: string; org: { id: string; name: string; language: string } }>> {
  if (userIds.length === 0) return [];
  return (
    (await db.membership.findMany({
      where: { userId: { in: userIds }, leftAt: null, role: ADMIN_ROLES, org: APPROVED_CLUB_WHERE },
      select: { userId: true, orgId: true, org: { select: { id: true, name: true, language: true } } },
    })) ?? []
  );
}

// ── The HQ group add (2.4) ───────────────────────────────────────────────

/**
 * Is MatchTime being added to this group an admin group candidate rather
 * than a new club? See `isAdminGroupCandidate` for the rule. Read-only.
 */
export async function detectAdminGroupCandidate(input: {
  addedByPhone?: unknown;
  addedByLid?: unknown;
  participants?: unknown;
  now: Date;
}): Promise<boolean> {
  const adderIds = await resolveSenderUserIds({
    phones: [typeof input.addedByPhone === "string" ? input.addedByPhone : null],
    lid: typeof input.addedByLid === "string" ? input.addedByLid : null,
  });
  const adderIsApprovedClubAdmin = (await adminClubsOf(adderIds)).length > 0;
  if (adderIsApprovedClubAdmin) {
    return isAdminGroupCandidate({ adderIsApprovedClubAdmin, openCodes: [], participantAdminOrgIds: [], now: input.now });
  }

  const openCodes =
    (await db.organisation.findMany({
      where: { ...APPROVED_CLUB_WHERE, adminGroupLinkCode: { not: null }, adminGroupLinkCodeExpiresAt: { gt: input.now } },
      select: { id: true, adminGroupLinkCodeExpiresAt: true },
    })) ?? [];
  if (openCodes.length === 0) return false;

  const memberPhones = parseParticipantSnapshot(input.participants)
    .map((p) => snapshotPhone(p))
    .filter((p): p is string => !!p);
  const memberIds = await resolveSenderUserIds({ phones: memberPhones });
  const participantAdminOrgIds = (await adminClubsOf(memberIds)).map((m) => m.orgId);
  return isAdminGroupCandidate({
    adderIsApprovedClubAdmin: false,
    openCodes: openCodes.map((o) => ({ orgId: o.id, expiresAt: o.adminGroupLinkCodeExpiresAt })),
    participantAdminOrgIds,
    now: input.now,
  });
}

/**
 * Record the candidate: an `UnsolicitedGroup` row with
 * `awaitingAdminLink`, which makes the group SILENT (nothing in it reaches
 * analyze; the setup trigger is refused) until the code links it. An open
 * unsolicited row for the group is reused.
 */
export async function recordAdminGroupCandidate(input: {
  groupId: string;
  subject?: string | null;
  memberCount?: number | null;
  addedByPhone?: string | null;
  addedByLid?: string | null;
  now: Date;
}): Promise<{ id: string }> {
  const open = await db.unsolicitedGroup.findFirst({ where: { groupId: input.groupId, leftAt: null }, select: { id: true } });
  if (open) {
    await db.unsolicitedGroup.update({ where: { id: open.id }, data: { awaitingAdminLink: true } });
    return { id: open.id };
  }
  const row = await db.unsolicitedGroup.create({
    data: {
      groupId: input.groupId,
      subject: input.subject ?? null,
      memberCount: input.memberCount ?? null,
      addedByPhone: input.addedByPhone ?? null,
      addedByLid: input.addedByLid ?? null,
      addedAt: input.now,
      awaitingAdminLink: true,
    },
  });
  console.log(`[admin-group] ${input.groupId} ("${input.subject ?? "?"}"): admin group candidate; silent, waiting for its code`);
  return { id: row.id };
}

// ── The code (2.3) ───────────────────────────────────────────────────────

/** A new single-use code for this club, replacing any earlier one. */
export async function createAdminGroupLinkCode(
  orgId: string,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + ADMIN_GROUP_CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateAdminGroupLinkCode();
    try {
      await db.organisation.updateMany({
        where: { id: orgId },
        data: { adminGroupLinkCode: code, adminGroupLinkCodeExpiresAt: expiresAt },
      });
      return { code, expiresAt };
    } catch (err) {
      // Unique across clubs: another club holds this code. Draw again.
      if ((err as { code?: string })?.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("Could not create an admin group code; please try again.");
}

// ── The link command (2.3) ───────────────────────────────────────────────

export interface AdminGroupLinkInput {
  groupId: string;
  text: string;
  /** Only the Pi can tell MatchTime itself was tagged. */
  botMentioned?: boolean;
  senderPhone?: string | null;
  senderAltPhone?: string | null;
  senderLid?: string | null;
  groupSubject?: string | null;
  now?: Date;
}

export type AdminGroupLinkResult =
  | { outcome: "linked"; replyText: string; adminGroup: { groupId: string; orgId: string } }
  | { outcome: "already-linked"; replyText: null; adminGroup: { groupId: string; orgId: string } }
  | { outcome: "bad-code" | "main-group"; replyText: string }
  | { outcome: "ignored"; replyText: null; reason: string };

const ignored = (reason: string): AdminGroupLinkResult => ({ outcome: "ignored", replyText: null, reason });

export async function linkAdminGroup(input: AdminGroupLinkInput): Promise<AdminGroupLinkResult> {
  const now = input.now ?? new Date();
  const code = parseAdminGroupLinkMessage(input.text, { botMentioned: input.botMentioned === true });
  if (!code) return ignored("not-a-link-command");

  const userIds = await resolveSenderUserIds({
    phones: [input.senderPhone, input.senderAltPhone],
    lid: input.senderLid ?? null,
  });
  const clubs = await adminClubsOf(userIds);
  // Not an owner or admin of any approved club: silence, whatever the code.
  if (clubs.length === 0) return ignored("not-an-admin");
  const adminOf = new Map(clubs.map((c) => [c.orgId, c]));

  // A club's own community group can never be its admin group.
  const community = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, name: true, language: true },
  });
  if (community) {
    if (!adminOf.has(community.id)) return ignored("another-clubs-main-group");
    return { outcome: "main-group", replyText: t(community.language).admin_group_main_group({ club: community.name }) };
  }

  // Already some club's admin group.
  const owner = await db.organisation.findFirst({
    where: { adminGroupId: input.groupId },
    select: { id: true, name: true, language: true },
  });
  if (owner) {
    if (!adminOf.has(owner.id)) return ignored("another-clubs-admin-group");
    // A Pi retry, or the command sent twice: linked already, say nothing.
    return { outcome: "already-linked", replyText: null, adminGroup: { groupId: input.groupId, orgId: owner.id } };
  }

  const target = await db.organisation.findFirst({
    where: { ...APPROVED_CLUB_WHERE, adminGroupLinkCode: code },
    select: { id: true, name: true, language: true, adminGroupId: true, adminGroupLinkCodeExpiresAt: true },
  });
  const valid =
    !!target && !!target.adminGroupLinkCodeExpiresAt && target.adminGroupLinkCodeExpiresAt.getTime() > now.getTime();
  if (!valid) {
    const lang = clubs[0].org.language;
    return { outcome: "bad-code", replyText: t(lang).admin_group_bad_code };
  }
  const linker = adminOf.get(target.id);
  // A real code for a club this sender does not run: silence.
  if (!linker) return ignored("not-this-clubs-admin");

  // The Pi does not look the subject up (no directory reads); the add
  // recorded it on the candidate row, so use that when none is sent.
  const subject =
    typeof input.groupSubject === "string" && input.groupSubject.trim()
      ? input.groupSubject.trim()
      : ((
          await db.unsolicitedGroup.findFirst({
            where: { groupId: input.groupId, subject: { not: null } },
            orderBy: { addedAt: "desc" },
            select: { subject: true },
          })
        )?.subject ?? null);
  let linked: boolean;
  try {
    linked = await db.$transaction(async (tx) => {
      const { count } = await tx.organisation.updateMany({
        // Compare-and-set on the code: single use, and a second sender (or
        // a code already consumed) finds nothing to update.
        where: { id: target.id, adminGroupLinkCode: code },
        data: {
          adminGroupId: input.groupId,
          adminGroupSubject: subject,
          adminGroupLinkedAt: now,
          adminGroupLinkedByUserId: linker.userId,
          adminGroupLinkCode: null,
          adminGroupLinkCodeExpiresAt: null,
          adminChannelMode: "admin-group",
        },
      });
      if (count !== 1) return false;
      // No longer an unsolicited group: not silent, and never auto-left.
      await tx.unsolicitedGroup.updateMany({
        where: { groupId: input.groupId, leftAt: null },
        data: { leftAt: now, awaitingAdminLink: false },
      });
      // If the setup intro did go out (the add was not recognised), the
      // session only asked for consent; nothing was created. End it.
      await tx.onboardingSession.updateMany({
        where: { whatsappGroupId: input.groupId, stage: { in: [...ACTIVE_ONBOARDING_STAGES] } },
        data: { stage: "abandoned" },
      });
      return true;
    });
  } catch (err) {
    // adminGroupId is UNIQUE: another club linked this group a moment ago.
    if ((err as { code?: string })?.code === "P2002") return ignored("race-lost");
    throw err;
  }
  if (!linked) return ignored("race-lost");

  // The club had a different group linked before: MatchTime leaves it.
  if (target.adminGroupId && target.adminGroupId !== input.groupId) {
    await queuePlatformLeaveGroup({ groupId: target.adminGroupId, refId: `admin-group-replaced:${target.id}` });
  }
  console.log(`[admin-group] ${input.groupId} ("${subject ?? "?"}") linked as the admin group of ${target.id} by ${linker.userId}`);
  return {
    outcome: "linked",
    replyText: t(target.language).admin_group_linked({ club: target.name }),
    adminGroup: { groupId: input.groupId, orgId: target.id },
  };
}

// ── Unlinking and removal ────────────────────────────────────────────────

const CLEARED = {
  adminGroupId: null,
  adminGroupSubject: null,
  adminGroupLinkedAt: null,
  adminGroupLinkedByUserId: null,
  // Back to the owner by DM: the club no longer has a group to post in.
  adminChannelMode: "one-person",
  adminChannelUserId: null,
} as const;

/** The settings page's Unlink: clear the group and leave it. */
export async function unlinkAdminGroup(orgId: string): Promise<{ unlinked: boolean; leaveQueued: boolean }> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { id: true, adminGroupId: true } });
  if (!org?.adminGroupId) return { unlinked: false, leaveQueued: false };
  const groupId = org.adminGroupId;
  const { count } = await db.organisation.updateMany({ where: { id: orgId, adminGroupId: groupId }, data: CLEARED });
  if (count !== 1) return { unlinked: false, leaveQueued: false };
  const leave = await queuePlatformLeaveGroup({ groupId, refId: `admin-group-unlink:${orgId}` });
  if ("refused" in leave) console.warn(`[admin-group] not leaving ${groupId} after unlink: ${leave.refused}`);
  return { unlinked: true, leaveQueued: !("refused" in leave) };
}

/**
 * MatchTime was removed from a group. If it was a club's admin group: clear
 * the link, move the club to the owner by DM, and tell the owner (L4).
 */
export async function handleAdminGroupRemoved(
  groupId: string,
  now: Date = new Date(),
): Promise<{ unlinked: boolean; orgId?: string }> {
  const org = await db.organisation.findFirst({
    where: { adminGroupId: groupId },
    select: { id: true, name: true, language: true },
  });
  if (!org) return { unlinked: false };
  const { count } = await db.organisation.updateMany({ where: { id: org.id, adminGroupId: groupId }, data: CLEARED });
  if (count !== 1) return { unlinked: false };
  const owners =
    (await db.membership.findMany({
      where: { orgId: org.id, role: "OWNER", leftAt: null, user: { phoneNumber: { not: null } } },
      select: { user: { select: { phoneNumber: true } } },
      take: 1,
    })) ?? [];
  const phone = owners[0]?.user.phoneNumber;
  if (phone) {
    await db.botJob.create({
      data: {
        orgId: org.id,
        kind: "dm",
        phone: phone.replace(/^\+/, ""),
        text: t(org.language).admin_group_removed_dm({ club: org.name }),
      },
    });
  }
  console.log(`[admin-group] removed from ${groupId}: ${org.id}'s admin group unlinked at ${now.toISOString()}; owner told: ${!!phone}`);
  return { unlinked: true, orgId: org.id };
}

// ── For the Pi (2.5) ─────────────────────────────────────────────────────

/** Every approved club's linked admin group. */
export async function loadAdminGroups(): Promise<Array<{ groupId: string; orgId: string }>> {
  const rows =
    (await db.organisation.findMany({
      where: { ...APPROVED_CLUB_WHERE, adminGroupId: { not: null } },
      select: { id: true, adminGroupId: true },
    })) ?? [];
  return rows
    .filter((r): r is { id: string; adminGroupId: string } => typeof r.adminGroupId === "string" && r.adminGroupId.length > 0)
    .map((r) => ({ groupId: r.adminGroupId, orgId: r.id }));
}
