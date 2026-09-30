/**
 * THE ADMIN CHANNEL: the one door for admin-only notices (slice 2a,
 * 2026-09-30). Plan: MDs/friday-group-features-plan-2026-09-30.md, 2.2.
 *
 * A club chooses where messages only admins should see go: one person by
 * DM, its linked admin WhatsApp group, or each admin by DM. Every notice
 * that used to loop over `findOrgAdminsWithPhone` goes through here, and
 * so does every new one in slices 1 to 3:
 *
 *   sendAdminNotice(orgId, notice)       an event (a join, a leave, a new
 *                                        player's IN): queued as BotJobs;
 *   adminNoticeInstructions({...})       a scheduled notice built inside
 *                                        `computeDuePosts` (the provisional
 *                                        review, the switch and cancel
 *                                        nudges): returned as instructions.
 *
 * SUTTON FC IS UNCHANGED. "each-admin" (every club that existed before the
 * migration) produces exactly today's rows: one `dm` BotJob per owner and
 * admin with a phone, or one `dm` instruction keyed as today
 * (`…:<adminId>`), each with that admin's own signed-in link.
 *
 * LINKS. A DM carries the recipient's personal signed-in, club-pinned link
 * (`buildAdminLink`). A post in the admin group carries the plain URL
 * (`appUrl`), which asks for sign-in: a personal sign-in link posted in a
 * group would let anyone in that group sign in as that admin.
 *
 * NO MODEL. Nothing here composes text; callers hand in a text builder.
 */
import { db } from "./db";
import { appUrl, buildAdminLink } from "./admin-link";
import {
  isAdminGroupPostHour,
  normaliseAdminChannelMode,
  resolveAdminNoticeTargets,
  type AdminChannelConfig,
  type ChannelAdmin,
  type PiCaps,
} from "./admin-channel-rules";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import type { DueInstruction } from "./bot-scheduler";

/** What a notice says, and whom it points at. */
export interface AdminNotice {
  /**
   * The text: a finished string, or a builder given the link to put in it
   * ("" when there is no `nextPath`) and who is reading: one admin by DM,
   * or the admin group.
   */
  text: string | ((link: string, audience: "dm" | "group") => string);
  /** The admin page the notice points at, or none. */
  nextPath?: string | null;
  /** Never tell this person about themselves (an admin who just joined or left). */
  excludeUserId?: string | null;
}

/** `sendAdminNotice`'s argument: the notice, for a club, queued at `now`. */
export interface AdminNoticeRequest extends AdminNotice {
  orgId: string;
  now?: Date;
  /**
   * Hold a notice queued between 22:00 and 07:59 London until 08:00
   * (`sendAfter`, slice 1's R4 rule). The default for every new notice.
   * The notices that existed before the admin channel (a join, a leave, a
   * new player's IN) pass false: they have always gone out at once, and a
   * club on "each-admin" (Sutton FC) must see no change.
   */
  holdOvernight?: boolean;
}

/** A club's channel, loaded once per notice (or once per scheduler poll). */
export interface LoadedAdminChannel {
  orgId: string;
  orgName: string;
  language: string;
  cfg: AdminChannelConfig;
  admins: ChannelAdmin[];
}

/**
 * Every OWNER and ADMIN with an active membership, phone or not, in the
 * order `findOrgAdminsWithPhone` has always used (role asc), so
 * "each-admin" delivers in today's order.
 */
async function loadChannelAdmins(orgId: string): Promise<ChannelAdmin[]> {
  const rows =
    (await db.membership.findMany({
      where: { orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
      include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      orderBy: { role: "asc" },
    })) ?? [];
  return rows.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    role: m.role === "OWNER" ? "OWNER" : "ADMIN",
    phoneNumber: m.user.phoneNumber,
  }));
}

export async function loadAdminChannel(orgId: string): Promise<LoadedAdminChannel | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      language: true,
      adminChannelMode: true,
      adminChannelUserId: true,
      adminGroupId: true,
    },
  });
  if (!org) return null;
  return {
    orgId: org.id,
    orgName: org.name,
    language: org.language,
    cfg: {
      mode: normaliseAdminChannelMode(org.adminChannelMode),
      channelUserId: org.adminChannelUserId ?? null,
      adminGroupId: org.adminGroupId ?? null,
    },
    admins: await loadChannelAdmins(org.id),
  };
}

function logFallback(orgId: string, via: string): void {
  if (via === "owner-fallback" || via === "each-admin-fallback") {
    console.warn(`[admin-channel] org ${orgId}: admin notice fell back (${via})`);
  }
}

const bare = (phone: string) => phone.replace(/^\+/, "");

function render(notice: AdminNotice, link: string, audience: "dm" | "group"): string {
  return typeof notice.text === "string" ? notice.text : notice.text(link, audience);
}

async function dmText(ch: LoadedAdminChannel, notice: AdminNotice, userId: string): Promise<string> {
  const link = notice.nextPath ? await buildAdminLink({ userId, orgId: ch.orgId, nextPath: notice.nextPath }) : "";
  return render(notice, link, "dm");
}

function groupText(notice: AdminNotice): string {
  return render(notice, notice.nextPath ? appUrl(notice.nextPath) : "", "group");
}

/**
 * THE ONE WAY A CLUB'S ORGANISERS ARE TOLD SOMETHING. Queue an admin-only
 * notice as BotJobs that the club's next due-posts poll hands the Pi, so a
 * muted club (`whatsappBotEnabled` false) sends nothing until unmuted, like
 * every other post. No caller picks recipients itself.
 *
 * "admin-group" with a linked group queues ONE `admin-group` job. Whether
 * it then goes to the group is decided when it is emitted, because only
 * then do we know if the Pi polling can send there
 * (`adminGroupJobInstruction`); if it cannot, the job goes to the owner by
 * DM instead. Every other case queues `dm` jobs: for "each-admin" exactly
 * the rows the call sites wrote before the admin channel existed.
 *
 * Not `owner-dm.ts`: that module DMs the PLATFORM owner about club
 * approvals. This is the club's own organisers.
 */
export async function sendAdminNotice(req: AdminNoticeRequest): Promise<{ channel: "dm" | "admin-group" | "none"; queued: number }> {
  const { orgId } = req;
  const now = req.now ?? new Date();
  const sendAfter = req.holdOvernight === false ? null : adminNoticeSendAfter(now);
  const ch = await loadAdminChannel(orgId);
  if (!ch) return { channel: "none", queued: 0 };

  if (ch.cfg.mode === "admin-group" && ch.cfg.adminGroupId) {
    await db.botJob.create({
      data: { orgId, kind: "admin-group", text: groupText(req), ...(sendAfter ? { sendAfter } : {}) },
    });
    return { channel: "admin-group", queued: 1 };
  }

  // No Pi capability at queue time: the group case was handled above, so
  // this resolves the DM recipients only.
  const target = resolveAdminNoticeTargets(ch.cfg, ch.admins, { adminGroup: false });
  if (target.kind !== "dm") return { channel: "none", queued: 0 };
  logFallback(orgId, target.via);
  let queued = 0;
  for (const user of target.users) {
    if (req.excludeUserId && user.id === req.excludeUserId) continue;
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: bare(user.phoneNumber),
        text: await dmText(ch, req, user.id),
        ...(sendAfter ? { sendAfter } : {}),
      },
    });
    queued++;
  }
  if (queued === 0) console.warn(`[admin-channel] org ${orgId}: no admin to tell; notice not sent`);
  return { channel: "dm", queued };
}

/**
 * The instructions for one scheduled admin notice, inside `computeDuePosts`.
 *
 * `key(suffix)` builds the idempotency key: the suffix is the recipient's
 * user id for a DM (today's `…:<adminId>` keys, so a club on "each-admin"
 * sends nothing twice across this change) and "admin-group" for the group.
 * Switching channel mid-week can therefore deliver a notice that is still
 * due once more, on the new channel. That is intended: the new channel has
 * not seen it.
 */
export async function adminNoticeInstructions(args: {
  channel: LoadedAdminChannel;
  piCaps: PiCaps;
  sentKeys: ReadonlySet<string>;
  now: Date;
  key: (suffix: string) => string;
  matchId?: string;
  notice: AdminNotice;
}): Promise<DueInstruction[]> {
  const { channel: ch, notice } = args;
  const target = resolveAdminNoticeTargets(ch.cfg, ch.admins, args.piCaps);
  const withMatch = args.matchId ? { matchId: args.matchId } : {};

  if (target.kind === "group") {
    const key = args.key("admin-group");
    if (args.sentKeys.has(key) || !isAdminGroupPostHour(args.now)) return [];
    return [{ kind: "admin-group-message", key, ...withMatch, groupId: target.groupId, text: groupText(notice) }];
  }

  logFallback(ch.orgId, target.via);
  const out: DueInstruction[] = [];
  for (const user of target.users) {
    if (notice.excludeUserId && user.id === notice.excludeUserId) continue;
    const key = args.key(user.id);
    if (args.sentKeys.has(key)) continue;
    out.push({
      kind: "dm",
      key,
      ...withMatch,
      targetUser: user.id,
      phone: bare(user.phoneNumber),
      text: await dmText(ch, notice, user.id),
    });
  }
  return out;
}

/**
 * A queued `admin-group` BotJob, at emit time. Posted in the admin group
 * when the club still has one linked and still routes there, the Pi polling
 * can send there, and it is 08:00 to 21:59 London; held (null) overnight;
 * otherwise sent to the club's one person (the owner) by DM with the same
 * text, so a rolled-back Pi or an unlinked group never swallows it.
 */
export function adminGroupJobInstruction(
  job: { id: string; text: string },
  ch: LoadedAdminChannel,
  piCaps: PiCaps,
  now: Date,
): DueInstruction | null {
  const key = `botjob-${job.id}`;
  const target = resolveAdminNoticeTargets(ch.cfg, ch.admins, piCaps);
  if (target.kind === "group") {
    if (!isAdminGroupPostHour(now)) return null;
    return { kind: "admin-group-message", key, groupId: target.groupId, text: job.text };
  }
  logFallback(ch.orgId, target.via);
  // One job, one key: one recipient. The owner when they are among them.
  const user = target.users.find((u) => ch.admins.some((a) => a.id === u.id && a.role === "OWNER")) ?? target.users[0];
  if (!user) return null;
  return { kind: "dm", key, phone: bare(user.phoneNumber), text: job.text, targetUser: user.id };
}

// ── The settings page (plan section 5) ──────────────────────────────────

export interface AdminChannelStatus {
  mode: "one-person" | "admin-group" | "each-admin";
  /** one-person: who. null = the owner. */
  channelUserId: string | null;
  adminGroup: { subject: string | null; linkedAt: string | null } | null;
  /** The code on screen, while it is still valid. */
  code: { code: string; expiresAt: string } | null;
  /** Who can be "one person": owners and admins with a phone. */
  people: Array<{ id: string; name: string | null; role: "OWNER" | "ADMIN" }>;
}

export async function loadAdminChannelStatus(orgId: string, now: Date = new Date()): Promise<AdminChannelStatus | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      adminChannelMode: true,
      adminChannelUserId: true,
      adminGroupId: true,
      adminGroupSubject: true,
      adminGroupLinkedAt: true,
      adminGroupLinkCode: true,
      adminGroupLinkCodeExpiresAt: true,
    },
  });
  if (!org) return null;
  const admins = await loadChannelAdmins(orgId);
  const codeLive =
    !!org.adminGroupLinkCode && !!org.adminGroupLinkCodeExpiresAt && org.adminGroupLinkCodeExpiresAt.getTime() > now.getTime();
  return {
    mode: normaliseAdminChannelMode(org.adminChannelMode),
    channelUserId: org.adminChannelUserId ?? null,
    adminGroup: org.adminGroupId
      ? { subject: org.adminGroupSubject ?? null, linkedAt: org.adminGroupLinkedAt?.toISOString() ?? null }
      : null,
    code: codeLive ? { code: org.adminGroupLinkCode!, expiresAt: org.adminGroupLinkCodeExpiresAt!.toISOString() } : null,
    people: admins.filter((a) => !!a.phoneNumber).map((a) => ({ id: a.id, name: a.name, role: a.role })),
  };
}

export type SaveAdminChannelResult =
  | { ok: true }
  | { ok: false; reason: "needs-link" | "not-an-admin-with-phone" | "bad-mode" };

/**
 * Save the "Admin messages go to" choice. "admin-group" only takes effect
 * once a group is linked: until then the saved mode stays what it was and
 * the page shows the link steps ("needs-link"). A chosen person must be an
 * owner or admin of this club with a phone; null means the owner.
 */
export async function saveAdminChannelChoice(
  orgId: string,
  mode: string,
  channelUserId: string | null,
): Promise<SaveAdminChannelResult> {
  if (mode !== "one-person" && mode !== "admin-group" && mode !== "each-admin") return { ok: false, reason: "bad-mode" };
  if (mode === "admin-group") {
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { adminGroupId: true } });
    if (!org?.adminGroupId) return { ok: false, reason: "needs-link" };
    await db.organisation.updateMany({ where: { id: orgId }, data: { adminChannelMode: "admin-group" } });
    return { ok: true };
  }
  if (mode === "one-person" && channelUserId) {
    const admins = await loadChannelAdmins(orgId);
    if (!admins.some((a) => a.id === channelUserId && !!a.phoneNumber)) return { ok: false, reason: "not-an-admin-with-phone" };
  }
  await db.organisation.updateMany({
    where: { id: orgId },
    data: { adminChannelMode: mode, adminChannelUserId: mode === "one-person" ? channelUserId : null },
  });
  return { ok: true };
}
