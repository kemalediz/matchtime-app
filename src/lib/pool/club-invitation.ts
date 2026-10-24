/**
 * JOINING A CLUB'S GROUP: THE FLOW (local player pool L8, 2026-10-24).
 * Thin I/O around the pure rules (`club-invitation-rules.ts` for the
 * invitation's life, `club-invite.ts` for the card, `invite-link.ts` for
 * where the link comes from). Approved spec: "Joining the group", "Guest
 * players in the app" (Invite to club), "My invitations".
 *
 *   sweepClubInvitations   on every platform poll: the after-game question
 *                          (an hour after the game, quiet hours respected),
 *                          invitations the club never answered, and invite
 *                          code jobs that never came back.
 *   answerAsPlayer         Join / No thanks on My invitations.
 *   answerAsClub           the organisers' tap on the guest card (Invite to
 *                          club, Send the invite link, Not now).
 *   onInviteCodeReported   the Pi read the group's invite code (or could not).
 *   deliverWaitingLinks    a link was pasted: approved guests waiting get it.
 *   adoptInvitedGuest      he joined the WhatsApp group: an ordinary member.
 *
 * PRIVACY. The link is written into ONE message: `link_dm`, queued by
 * `queueLinkDm`, to the phone of the invitation's own user, only once both
 * yeses are stored (status "accepted"), and only once (`linkSentAt` is the
 * compare-and-set). Nothing else here puts the link in any text. The
 * organisers' notices name the guest by first name and last initial and
 * carry no number; the guest's DMs name the club only.
 *
 * NO MODEL. Every answer is a tap on a page (decision L8.3): an admin's
 * answer in his own words in HQ would need a new "waiting" line in the HQ
 * router's context, a prompt change this slice may not make.
 *
 * Only a club with the pool switched on (`featurePlayerPool`) is asked
 * after a game (decision log #2: shipping this changes no live club). The
 * Invite to club tap works for any club that has had a guest, because an
 * organiser pressed it.
 */
import { db } from "../db";
import { appUrl } from "../app-url";
import { sendAdminNotice } from "../admin-channel";
import { dayLabel } from "../i18n/dates";
import { inviteCopy } from "../i18n/pool-invite";
import { normaliseLang, type Lang } from "../i18n/lang";
import { keepGuestAsMember } from "../partner-guest";
import { cancelQueuedPlatformDms, queuePlatformDm, queuePlatformInviteCode, type PlatformDmClient, type PlatformJobOutcome } from "../platform-jobs";
import { readPostState } from "../group-postability-store";
import { GUEST_MEMBER_WHERE, isGuestMembership, partnerHomeClubOf } from "../guest-membership";
import { loadGuestFacts } from "./guest-report-loader";
import { buildGuestPlayers, guestDisplayName, settleGuestResult } from "./guest-report";
import type { InviteToClubResult, InviteToClubState } from "./club-invite";
import {
  afterGameAskDue,
  afterGameKickoffRange,
  clubSilentBefore,
  invitationStep,
  type InvitationEffect,
  type InvitationEvent,
  type InvitationFacts,
} from "./club-invitation-rules";
import { INVITE_LINK_SETTINGS_PATH, groupInviteLinkFromCode, inviteLinkSource, isGroupInviteCodeJobsOn, type InviteLinkSource } from "./invite-link";
import { buildPoolInvitationsLink } from "./links";
import { poolSendAt } from "./waves";

type Env = Record<string, string | undefined>;

/** Where the organisers answer a guest who wants to join. */
export const GUEST_HISTORY_PATH = "/admin/guests?tab=history";

/** An invite code job not reported within this is taken as failed. */
const INVITE_CODE_STALE_MS = 10 * 60_000;
/** After the Pi failed to read the code, it is not asked again for this long
 *  (the pasted link, or the organisers' one notice, in between). */
const INVITE_CODE_RETRY_MS = 6 * 3600_000;

const INVITATION_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  matchId: true,
  status: true,
  origin: true,
  clubYesAt: true,
  playerYesAt: true,
  declinedBy: true,
  closedAt: true,
  linkSentAt: true,
  createdAt: true,
} as const;

type InvitationRow = InvitationFacts & { id: string; orgId: string; userId: string; matchId: string | null; linkSentAt: Date | null };

// ── Small reads ────────────────────────────────────────────────────────

/** Where this club's link would come from now. */
export async function loadLinkSource(orgId: string, env: Env = process.env): Promise<InviteLinkSource> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { whatsappGroupId: true, groupInviteLink: true } });
  if (!org) return { kind: "none" };
  const state = org.whatsappGroupId ? await readPostState(org.whatsappGroupId) : null;
  return inviteLinkSource({
    groupId: org.whatsappGroupId,
    botIsAdmin: state?.botIsAdmin === true,
    codeJobsOn: isGroupInviteCodeJobsOn(env),
    pastedLink: org.groupInviteLink,
  });
}

/** The language of his DMs: his pool profile's, else his home club's (a
 *  partner guest), else this club's. */
async function guestLanguage(userId: string, orgId: string): Promise<Lang> {
  const [profile, membership, club] = await Promise.all([
    db.poolProfile.findUnique({ where: { userId }, select: { language: true } }),
    db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { guestFromOrgId: true } }),
    db.organisation.findUnique({ where: { id: orgId }, select: { language: true } }),
  ]);
  if (profile?.language) return normaliseLang(profile.language);
  const homeId = partnerHomeClubOf(membership);
  if (homeId) {
    const home = await db.organisation.findUnique({ where: { id: homeId }, select: { language: true } });
    if (home) return normaliseLang(home.language);
  }
  return normaliseLang(club?.language);
}

async function clubOf(orgId: string): Promise<{ name: string; language: Lang } | null> {
  const o = await db.organisation.findUnique({ where: { id: orgId }, select: { name: true, language: true } });
  return o ? { name: o.name, language: normaliseLang(o.language) } : null;
}

async function phoneOf(userId: string): Promise<string | null> {
  return (await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } }))?.phoneNumber ?? null;
}

/**
 * He withdrew his consent (review of #406, M3; decision L8.14): his pool
 * profile is stopped, or he came through the pool and deleted it. Then
 * nothing more about joining goes to him: no link, no closing line.
 */
async function consentWithdrawn(userId: string): Promise<boolean> {
  const profile = await db.poolProfile.findUnique({ where: { userId }, select: { status: true } });
  if (profile) return profile.status === "stopped";
  return !!(await db.guestPlace.findFirst({ where: { userId, source: "pool" }, select: { id: true } }));
}

/** A live, ordinary member of the club already (review L6). */
async function isMemberOf(orgId: string, userId: string): Promise<boolean> {
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { leftAt: true, guestMatchId: true, guestFromOrgId: true, guestVia: true } });
  return !!m && m.leftAt === null && !isGuestMembership(m);
}

/** The card's state for one guest, from the database (never the page). */
export async function guestInviteState(orgId: string, userId: string, now: Date): Promise<InviteToClubState> {
  const facts = await loadGuestFacts(orgId, { userIds: [userId], now });
  const card = buildGuestPlayers({ orgId, now, lang: "en", games: facts.games, people: facts.people }).cards[userId];
  return card?.invite ?? "hidden";
}

// ── Stepping an invitation ─────────────────────────────────────────────

/**
 * Apply one event: the pure step, then a compare-and-set on the row as it
 * was read (status and both yeses), so two taps at once cannot both win;
 * then the effects. Returns false when the step refused or the race was
 * lost.
 */
async function step(inv: InvitationRow, ev: InvitationEvent, now: Date, env: Env): Promise<{ ok: boolean; effects: InvitationEffect[] }> {
  const s = invitationStep(inv, ev);
  if (!s.ok) return { ok: false, effects: [] };
  const { count } = await db.clubInvitation.updateMany({
    where: { id: inv.id, status: "open", clubYesAt: inv.clubYesAt, playerYesAt: inv.playerYesAt },
    data: s.patch,
  });
  if (count !== 1) return { ok: false, effects: [] };
  const next: InvitationRow = { ...inv, ...s.patch } as InvitationRow;
  for (const effect of s.effects) {
    try {
      if (effect === "send-link") await deliverInviteLink(next.id, now, env);
      else if (effect === "tell-club-wants-join") await tellClubWantsJoin(next, now, env);
      else if (effect === "tell-guest-closed") await tellGuestClosed(next, now);
    } catch (err) {
      console.error(`[club-invite] ${effect} for invitation ${inv.id} failed:`, err instanceof Error ? err.message : "failed");
    }
  }
  return { ok: true, effects: s.effects };
}

// ── The guest's answer (My invitations) ────────────────────────────────

export type PlayerAnswerResult = "waiting-club" | "link-sent" | "declined" | "closed" | "member" | "not-yours";

export async function answerAsPlayer(args: { invitationId: string; userId: string; answer: "join" | "no"; now?: Date; env?: Env }): Promise<PlayerAnswerResult> {
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;
  const inv = (await db.clubInvitation.findUnique({ where: { id: args.invitationId }, select: INVITATION_SELECT })) as InvitationRow | null;
  if (!inv || inv.userId !== args.userId) return "not-yours";
  if (inv.status !== "open") return "closed";
  if (args.answer === "join" && (await isMemberOf(inv.orgId, inv.userId))) return "member";
  const done = await step(inv, args.answer === "join" ? { kind: "player-yes", at: now } : { kind: "player-no", at: now }, now, env);
  if (!done.ok) return "closed";
  if (args.answer === "no") return "declined";
  return done.effects.includes("send-link") ? "link-sent" : "waiting-club";
}

// ── The organisers' tap (the guest card) ───────────────────────────────

/** The actor is an owner or admin of `orgId` (the action checked). */
export async function answerAsClub(args: { orgId: string; userId: string; actorId: string; answer: "yes" | "no"; now?: Date; env?: Env }): Promise<InviteToClubResult> {
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;
  // Live clubs unchanged (review M4): only a club with the pool on.
  const pool = await db.organisation.findUnique({ where: { id: args.orgId }, select: { featurePlayerPool: true } });
  if (!pool?.featurePlayerPool) return { ok: false, reason: "not-allowed" };
  const state = await guestInviteState(args.orgId, args.userId, now);
  const open = (await db.clubInvitation.findFirst({ where: { orgId: args.orgId, userId: args.userId, status: "open" }, select: INVITATION_SELECT })) as InvitationRow | null;

  if (args.answer === "no") {
    if (state !== "requested" || !open) return { ok: false, reason: "not-eligible" };
    const done = await step(open, { kind: "club-no", at: now, byUserId: args.actorId }, now, env);
    return done.ok ? { ok: true, state: await guestInviteState(args.orgId, args.userId, now) } : { ok: false, reason: "failed" };
  }

  if (state === "invited" || state === "link-sent" || state === "approved") return { ok: false, reason: "already-invited" };
  if (state !== "available" && state !== "requested") return { ok: false, reason: "not-eligible" };
  if ((await loadLinkSource(args.orgId, env)).kind === "none") return { ok: false, reason: "no-link" };

  if (open) {
    const done = await step(open, { kind: "club-yes", at: now, byUserId: args.actorId }, now, env);
    return done.ok ? { ok: true, state: await guestInviteState(args.orgId, args.userId, now) } : { ok: false, reason: "failed" };
  }

  // A new invitation: the organiser's tap is the club's yes; he is asked.
  const phone = await phoneOf(args.userId);
  const club = await clubOf(args.orgId);
  if (!phone || !club) return { ok: false, reason: "not-eligible" };
  const lang = await guestLanguage(args.userId, args.orgId);
  const link = await buildPoolInvitationsLink(args.userId);
  try {
    await db.$transaction(async (tx) => {
      const inv = await tx.clubInvitation.create({
        data: { orgId: args.orgId, userId: args.userId, origin: "organiser", invitedByUserId: args.actorId, clubYesAt: now, clubYesById: args.actorId, createdAt: now },
        select: { id: true },
      });
      await queuePlatformDm({
        phone,
        purpose: "club-invite-ask",
        refId: inv.id,
        text: inviteCopy(lang).ask_organiser({ club: club.name, link }),
        sendAfter: poolSendAt(now),
        client: tx as unknown as PlatformDmClient,
      });
    });
  } catch (err) {
    // The partial unique index: another tap, or the after-game question,
    // opened one a moment ago (review L2). The tap is then the club's yes
    // on that one.
    if ((err as { code?: string })?.code === "P2002") {
      const won = (await db.clubInvitation.findFirst({ where: { orgId: args.orgId, userId: args.userId, status: "open" }, select: INVITATION_SELECT })) as InvitationRow | null;
      if (!won || won.clubYesAt) return { ok: false, reason: "already-invited" };
      const done = await step(won, { kind: "club-yes", at: now, byUserId: args.actorId }, now, env);
      return done.ok ? { ok: true, state: "invited" } : { ok: false, reason: "already-invited" };
    }
    console.error(`[club-invite] org ${args.orgId}: invite failed:`, err instanceof Error ? err.message : "failed");
    return { ok: false, reason: "failed" };
  }
  return { ok: true, state: "invited" };
}

// ── The link ───────────────────────────────────────────────────────────

/**
 * The ONE place the link is put in a message. Only for an ACCEPTED
 * invitation, once: `linkSentAt` is stamped by compare-and-set in the same
 * transaction as the DM is queued.
 */
async function queueLinkDm(invitationId: string, link: string, now: Date): Promise<boolean> {
  const inv = await db.clubInvitation.findUnique({ where: { id: invitationId }, select: { id: true, orgId: true, userId: true, status: true, linkSentAt: true, playerYesAt: true } });
  if (!inv || inv.status !== "accepted" || inv.linkSentAt) return false;
  if (await consentWithdrawn(inv.userId)) return false;
  const [phone, club, lang] = await Promise.all([phoneOf(inv.userId), clubOf(inv.orgId), guestLanguage(inv.userId, inv.orgId)]);
  if (!phone || !club) return false;
  // His own tap was the second yes: an answer, sent now. The club's tap
  // was: held to the end of the pool's quiet hours.
  const answeredJustNow = inv.playerYesAt && now.getTime() - inv.playerYesAt.getTime() < 60_000;
  return db.$transaction(async (tx) => {
    const { count } = await tx.clubInvitation.updateMany({ where: { id: inv.id, status: "accepted", linkSentAt: null }, data: { linkSentAt: now } });
    if (count !== 1) return false;
    await queuePlatformDm({
      phone,
      purpose: "club-invite-link",
      refId: inv.id,
      text: inviteCopy(lang).link_dm({ club: club.name, link }),
      sendAfter: answeredJustNow ? null : poolSendAt(now),
      client: tx as unknown as PlatformDmClient,
    });
    return true;
  });
}

/** Both said yes: the link from where the club's source says, or the
 *  organisers are told how (once). Idempotent. */
export async function deliverInviteLink(
  invitationId: string,
  now: Date,
  env: Env = process.env,
  /** preferPasted: a link an organiser has just pasted goes first.
   *  skipBot: the Pi's last try failed lately; do not ask it again yet. */
  opts: { preferPasted?: boolean; skipBot?: boolean } = {},
): Promise<"queued" | "asked-pi" | "no-link" | "nothing"> {
  const inv = await db.clubInvitation.findUnique({ where: { id: invitationId }, select: { id: true, orgId: true, userId: true, status: true, linkSentAt: true } });
  if (!inv || inv.status !== "accepted" || inv.linkSentAt) return "nothing";
  if (await consentWithdrawn(inv.userId)) return "nothing";
  const source = await loadLinkSource(inv.orgId, env);
  // A link an organiser has just pasted is what he expects to go out now.
  if (source.kind === "bot" && source.fallback && (opts.preferPasted || opts.skipBot)) return (await queueLinkDm(inv.id, source.fallback, now)) ? "queued" : "nothing";
  if (source.kind === "bot") {
    const job = opts.skipBot ? null : await queuePlatformInviteCode({ groupId: source.groupId, refId: inv.id });
    if (job && "id" in job) return "asked-pi";
    if (source.fallback) return (await queueLinkDm(inv.id, source.fallback, now)) ? "queued" : "nothing";
    // MatchTime IS an admin, so "make MatchTime an admin" would be wrong
    // (review L1): the organisers are asked to paste the link.
    await tellClubNoLink(inv, now, "link-failed");
    return "no-link";
  }
  if (source.kind === "pasted") return (await queueLinkDm(inv.id, source.link, now)) ? "queued" : "nothing";
  await tellClubNoLink(inv, now, "no-link");
  return "no-link";
}

/** The route's hook for an "invite-code" job's report (pool L8). */
export async function onInviteCodeReported(jobId: string, result: PlatformJobOutcome, now: Date = new Date()): Promise<void> {
  const job = await db.platformJob.findUnique({ where: { id: jobId }, select: { kind: true, refId: true } });
  if (!job || job.kind !== "invite-code" || !job.refId) return;
  const link = result.outcome === "sent" ? groupInviteLinkFromCode(result.inviteCode) : null;
  if (link && (await queueLinkDm(job.refId, link, now))) return;
  if (link) return; // sent already, or no longer accepted
  await inviteCodeFailed(job.refId, now);
}

/** The Pi could not read the code: the pasted link if there is one, else
 *  the organisers are told (once). */
async function inviteCodeFailed(invitationId: string, now: Date): Promise<void> {
  const inv = await db.clubInvitation.findUnique({ where: { id: invitationId }, select: { id: true, orgId: true, userId: true, status: true, linkSentAt: true } });
  if (!inv || inv.status !== "accepted" || inv.linkSentAt) return;
  const org = await db.organisation.findUnique({ where: { id: inv.orgId }, select: { groupInviteLink: true } });
  if (org?.groupInviteLink && (await queueLinkDm(inv.id, org.groupInviteLink, now))) return;
  await tellClubNoLink(inv, now, "link-failed");
}

/** A link was just pasted: every approved guest still waiting for one gets it. */
export async function deliverWaitingLinks(orgId: string, now: Date = new Date(), env: Env = process.env): Promise<number> {
  const waiting = await db.clubInvitation.findMany({ where: { orgId, status: "accepted", linkSentAt: null }, select: { id: true } });
  let sent = 0;
  for (const w of waiting) if ((await deliverInviteLink(w.id, now, env, { preferPasted: true })) === "queued") sent++;
  return sent;
}

// ── Telling people ─────────────────────────────────────────────────────

/** Once per key (the notice table's unique key). */
async function once(key: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind: "club-invite" } });
    return true;
  } catch {
    return false;
  }
}

async function guestNameFor(userId: string, lang: Lang): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  return guestDisplayName(user?.name) ?? inviteCopy(lang).notice_someone;
}

async function lastGameDay(inv: { matchId: string | null }, lang: Lang): Promise<string | null> {
  if (!inv.matchId) return null;
  const m = await db.match.findUnique({ where: { id: inv.matchId }, select: { date: true } });
  return m ? dayLabel(lang, m.date) : null;
}

async function tellClubWantsJoin(inv: InvitationRow, now: Date, env: Env): Promise<void> {
  const club = await clubOf(inv.orgId);
  if (!club || !(await once(`club-invite:${inv.id}:wants-join`))) return;
  const c = inviteCopy(club.language);
  const name = await guestNameFor(inv.userId, club.language);
  const day = (await lastGameDay(inv, club.language)) ?? "";
  const noLink = (await loadLinkSource(inv.orgId, env)).kind === "none";
  await sendAdminNotice({
    orgId: inv.orgId,
    now,
    nextPath: GUEST_HISTORY_PATH,
    excludeUserId: inv.userId,
    text: (link) => {
      const lines = [c.notice_wants_join({ name, day, link: link || appUrl(GUEST_HISTORY_PATH) })];
      if (noLink) lines.push(c.notice_no_link({ link: appUrl(INVITE_LINK_SETTINGS_PATH) }));
      return lines.join("\n\n");
    },
  });
}

async function tellClubNoLink(inv: { id: string; orgId: string; userId: string }, now: Date, why: "no-link" | "link-failed"): Promise<void> {
  const club = await clubOf(inv.orgId);
  if (!club || !(await once(`club-invite:${inv.id}:${why}`))) return;
  const c = inviteCopy(club.language);
  const name = await guestNameFor(inv.userId, club.language);
  await sendAdminNotice({
    orgId: inv.orgId,
    now,
    nextPath: INVITE_LINK_SETTINGS_PATH,
    excludeUserId: inv.userId,
    text: (link) => {
      const to = link || appUrl(INVITE_LINK_SETTINGS_PATH);
      return why === "link-failed" ? c.notice_link_failed({ name, link: to }) : c.notice_no_link({ link: to });
    },
  });
}

async function tellGuestClosed(inv: InvitationRow, now: Date): Promise<void> {
  if (await consentWithdrawn(inv.userId)) return;
  const [phone, club, lang] = await Promise.all([phoneOf(inv.userId), clubOf(inv.orgId), guestLanguage(inv.userId, inv.orgId)]);
  if (!phone || !club) return;
  await queuePlatformDm({ phone, purpose: "club-invite-closed", refId: inv.id, text: inviteCopy(lang).closed_dm({ club: club.name }), sendAfter: poolSendAt(now) });
}

// ── Taking a link back (review M2) and a withdrawn consent (M3) ────────

/**
 * The club removed or replaced its pasted link: every link DM not handed to
 * the Pi yet is cancelled, and its invitation's `linkSentAt` cleared, so
 * the next delivery (now, with a new link; or the sweep, once there is a
 * source again) sends the CURRENT link. A DM already on its way is left.
 */
export async function retractUnsentLinks(orgId: string, now: Date = new Date()): Promise<number> {
  const sent = await db.clubInvitation.findMany({ where: { orgId, status: "accepted", linkSentAt: { not: null } }, select: { id: true } });
  if (sent.length === 0) return 0;
  const queued = await db.platformJob.findMany({
    where: { kind: "dm", purpose: "club-invite-link", status: "queued", refId: { in: sent.map((i) => i.id) } },
    select: { refId: true },
  });
  const refIds = [...new Set(queued.map((q) => q.refId).filter((r): r is string => !!r))];
  if (refIds.length === 0) return 0;
  await cancelQueuedPlatformDms({ purposes: ["club-invite-link"], refIds, reason: "the club changed its group link", now });
  const still = await db.platformJob.findMany({ where: { purpose: "club-invite-link", refId: { in: refIds }, status: { in: ["claimed", "sent", "unconfirmed"] } }, select: { refId: true } });
  const gone = refIds.filter((r) => !still.some((x) => x.refId === r));
  if (gone.length > 0) await db.clubInvitation.updateMany({ where: { id: { in: gone }, status: "accepted" }, data: { linkSentAt: null } });
  return gone.length;
}

/**
 * He stopped or deleted his pool profile (decision L8.14): a withdrawal of
 * consent. His open invitations, and approved ones whose link has not gone,
 * are withdrawn with no message; every invitation DM to him not handed to
 * the Pi yet is cancelled.
 */
export async function withdrawInvitationsForConsent(userId: string, now: Date = new Date()): Promise<number> {
  const rows = await db.clubInvitation.findMany({ where: { userId, status: { in: ["open", "accepted"] } }, select: { id: true } });
  if (rows.length === 0) return 0;
  await cancelQueuedPlatformDms({
    purposes: ["club-invite-ask", "club-invite-link", "club-invite-closed"],
    refIds: rows.map((r) => r.id),
    reason: "he withdrew his consent",
    now,
  });
  const unsent = await db.platformJob.findMany({ where: { purpose: "club-invite-link", refId: { in: rows.map((r) => r.id) }, status: { in: ["claimed", "sent", "unconfirmed"] } }, select: { refId: true } });
  const delivered = new Set(unsent.map((u) => u.refId));
  const { count } = await db.clubInvitation.updateMany({
    where: { id: { in: rows.map((r) => r.id).filter((id) => !delivered.has(id)) }, status: { in: ["open", "accepted"] } },
    data: { status: "withdrawn", closedAt: now },
  });
  return count;
}

// ── He joined the group ────────────────────────────────────────────────

/**
 * WhatsApp says he joined the club's group (the group-join event). A guest
 * the club invited (both yeses) becomes an ordinary member: his guest marks
 * cleared by `keepGuestAsMember`, the one writer of that change. Anyone
 * else's join is left exactly as the route always handled it.
 */
export async function adoptInvitedGuest(orgId: string, userId: string): Promise<boolean> {
  const invited = await db.clubInvitation.findFirst({ where: { orgId, userId, status: "accepted" }, select: { id: true } });
  if (!invited) return false;
  return keepGuestAsMember(orgId, userId);
}

// ── The sweep ──────────────────────────────────────────────────────────

export interface ClubInviteSweep {
  asked: number;
  expired: number;
  codesTimedOut: number;
}

/** Every platform poll. Never throws past one step: each part is its own try. */
export async function sweepClubInvitations(now: Date = new Date(), env: Env = process.env): Promise<ClubInviteSweep> {
  const out: ClubInviteSweep = { asked: 0, expired: 0, codesTimedOut: 0 };
  try {
    out.asked = await askAfterGames(now);
  } catch (err) {
    console.error("[club-invite] after-game questions failed; the next poll tries again:", err instanceof Error ? err.message : "failed");
  }
  try {
    const silent = (await db.clubInvitation.findMany({
      where: { status: "open", clubYesAt: null, playerYesAt: { lte: clubSilentBefore(now) } },
      select: INVITATION_SELECT,
      take: 50,
    })) as InvitationRow[];
    for (const inv of silent) if ((await step(inv, { kind: "club-silent", at: now }, now, env)).ok) out.expired++;
  } catch (err) {
    console.error("[club-invite] expiring unanswered invitations failed:", err instanceof Error ? err.message : "failed");
  }
  try {
    await retryWaitingLinks(now, env);
  } catch (err) {
    console.error("[club-invite] retrying approved invitations failed:", err instanceof Error ? err.message : "failed");
  }
  try {
    const stale = await db.platformJob.findMany({
      where: { kind: "invite-code", status: { in: ["queued", "claimed"] }, createdAt: { lt: new Date(now.getTime() - INVITE_CODE_STALE_MS) } },
      select: { id: true, refId: true },
      take: 20,
    });
    for (const j of stale) {
      const { count } = await db.platformJob.updateMany({
        where: { id: j.id, status: { in: ["queued", "claimed"] } },
        data: { status: "failed", failedAt: now, failReason: "no report from the Pi in time" },
      });
      if (count === 1 && j.refId) {
        out.codesTimedOut++;
        await inviteCodeFailed(j.refId, now);
      }
    }
  } catch (err) {
    console.error("[club-invite] timing out invite code jobs failed:", err instanceof Error ? err.message : "failed");
  }
  return out;
}

/**
 * Approved invitations still waiting for a link (review M1): whenever the
 * club has a source now, the link goes. The Pi is not asked again while a
 * job is outstanding, nor for a while after it failed (a job refused at
 * dispatch included, review L1): then the pasted link, or the organisers'
 * one notice.
 */
async function retryWaitingLinks(now: Date, env: Env): Promise<void> {
  const waiting = await db.clubInvitation.findMany({
    where: { status: "accepted", linkSentAt: null, org: { featurePlayerPool: true } },
    select: { id: true, orgId: true },
    orderBy: { closedAt: "asc" },
    take: 20,
  });
  const sources = new Map<string, InviteLinkSource>();
  for (const w of waiting) {
    if (!sources.has(w.orgId)) sources.set(w.orgId, await loadLinkSource(w.orgId, env));
    if (sources.get(w.orgId)!.kind === "none") continue;
    const last = await db.platformJob.findFirst({ where: { kind: "invite-code", refId: w.id }, orderBy: { createdAt: "desc" }, select: { status: true, failedAt: true } });
    if (last && (last.status === "queued" || last.status === "claimed")) continue;
    const failedLately = last?.status === "failed" && !!last.failedAt && now.getTime() - last.failedAt.getTime() < INVITE_CODE_RETRY_MS;
    await deliverInviteLink(w.id, now, env, { skipBot: failedLately });
  }
}

/** The after-game question to every guest due one now. */
async function askAfterGames(now: Date): Promise<number> {
  const range = afterGameKickoffRange(now);
  const recent = await db.match.findMany({
    where: { date: { gte: range.from, lte: range.to }, status: { not: "CANCELLED" }, activity: { org: { featurePlayerPool: true } } },
    select: { id: true, date: true, status: true, activity: { select: { orgId: true, matchDurationMins: true } } },
    take: 200,
  });
  if (recent.length === 0) return 0;
  const matchIds = recent.map((m) => m.id);
  const [memberships, places] = await Promise.all([
    // The clubs' guest rows, filtered to these matches below (a guest row
    // is written only by partner-guest.ts; this reads them).
    // POOL guests only (review M4): a partner club's player is recruited
    // only by a deliberate Invite to club, never automatically.
    db.membership.findMany({ where: { ...GUEST_MEMBER_WHERE, guestVia: "pool", orgId: { in: [...new Set(recent.map((m) => m.activity.orgId))] } }, select: { userId: true, orgId: true, guestMatchId: true } }),
    db.guestPlace.findMany({ where: { matchId: { in: matchIds }, source: "pool" }, select: { userId: true, orgId: true, matchId: true } }),
  ]);
  const pairs = new Map<string, { orgId: string; userId: string; matchId: string }>();
  const wanted = new Set(matchIds);
  for (const m of memberships.filter((x) => x.guestMatchId && wanted.has(x.guestMatchId))) pairs.set(`${m.orgId}:${m.userId}:${m.guestMatchId}`, { orgId: m.orgId, userId: m.userId, matchId: m.guestMatchId! });
  for (const p of places) pairs.set(`${p.orgId}:${p.userId}:${p.matchId}`, { orgId: p.orgId, userId: p.userId, matchId: p.matchId });
  if (pairs.size === 0) return 0;

  const matchOf = new Map(recent.map((m) => [m.id, m]));
  const asked = new Set(
    (
      await db.clubInvitation.findMany({
        where: { OR: [...pairs.values()].map((p) => ({ orgId: p.orgId, userId: p.userId })) },
        select: { orgId: true, userId: true },
      })
    ).map((i) => `${i.orgId}:${i.userId}`),
  );

  let n = 0;
  const byOrg = new Map<string, Array<{ userId: string; matchId: string }>>();
  for (const p of pairs.values()) {
    const m = matchOf.get(p.matchId);
    if (!m || m.activity.orgId !== p.orgId) continue;
    // Asked before: skipped before anything else is read (review L4).
    if (asked.has(`${p.orgId}:${p.userId}`)) continue;
    byOrg.set(p.orgId, [...(byOrg.get(p.orgId) ?? []), p]);
  }
  for (const [orgId, list] of byOrg) {
    const facts = await loadGuestFacts(orgId, { userIds: [...new Set(list.map((l) => l.userId))], now });
    const people = new Map(facts.people.map((p) => [p.userId, p]));
    for (const { userId, matchId } of list) {
      const game = facts.games.find((g) => g.userId === userId && g.match.matchId === matchId && g.orgId === orgId);
      const person = people.get(userId);
      const m = matchOf.get(matchId)!;
      const phone = await phoneOf(userId);
      const due = afterGameAskDue({
        match: { kickoff: m.date, durationMins: m.activity.matchDurationMins, status: m.status },
        result: game ? settleGuestResult(game, now) : null,
        member: person?.member === true,
        pool: person?.pool ?? "none",
        hasPhone: !!phone,
        askedBefore: asked.has(`${orgId}:${userId}`),
        blocked: person?.clubBlocked === true,
        now,
      });
      if (!due.due || !phone) continue;
      if (await askOne({ orgId, userId, matchId, kickoff: m.date, phone, now })) {
        asked.add(`${orgId}:${userId}`);
        n++;
      }
    }
  }
  return n;
}

async function askOne(a: { orgId: string; userId: string; matchId: string; kickoff: Date; phone: string; now: Date }): Promise<boolean> {
  const club = await clubOf(a.orgId);
  if (!club) return false;
  const lang = await guestLanguage(a.userId, a.orgId);
  const link = await buildPoolInvitationsLink(a.userId);
  try {
    await db.$transaction(async (tx) => {
      const inv = await tx.clubInvitation.create({ data: { orgId: a.orgId, userId: a.userId, matchId: a.matchId, origin: "after-game", createdAt: a.now }, select: { id: true } });
      await queuePlatformDm({
        phone: a.phone,
        purpose: "club-invite-ask",
        refId: inv.id,
        text: inviteCopy(lang).ask_after_game({ club: club.name, day: dayLabel(lang, a.kickoff), link }),
        sendAfter: poolSendAt(a.now),
        client: tx as unknown as PlatformDmClient,
      });
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") console.error(`[club-invite] asking ${a.userId} after a game failed:`, err instanceof Error ? err.message : "failed");
    return false;
  }
}
