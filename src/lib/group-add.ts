/**
 * SELF-JOIN, SLICE 6: GROUP ADD LINKING (2026-09-29).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 2.3, 4.1,
 * 5.5, 5.6, 5.7, 6.1 and 8. The pure rules are in group-add-rules.ts.
 *
 * Called by POST /api/whatsapp/bot-added (while SELF_JOIN_ENABLED is on),
 * POST /api/whatsapp/bot-removed, GET /api/whatsapp/platform-jobs (the
 * 48-hour auto-leave) and GET /api/whatsapp/orgs (the reconnect sweep).
 *
 * RELINK AFTER A RE-ADD (2026-10-11). MatchTime removed from a waiting
 * club's group and added straight back by the organiser, with no new code,
 * links the SAME request again instead of being unsolicited. The rule and
 * its 24-hour window are in group-add-rules.ts (`decideRelinkAfterReAdd`);
 * the link itself is `linkGroupToRequest`, the one a first link uses.
 *
 * COMMUNITIES AND THE STRONGER ADD (2026-10-15, the FNF incident). A
 * WhatsApp community's parent group and announcements group are never
 * linked (`communityRoleOf`). A request linked on weak evidence (the
 * organiser merely in the group) is MOVED to the group the organiser then
 * adds MatchTime to themselves, while the club waits (`decideWeakLinkUpgrade`,
 * `relinkToOrganiserGroup`); the owner gets the approval DM, or a
 * correction if he was already asked about the other group.
 *
 * THE GROUP STAYS SILENT. Nothing here posts in a group, reacts, DMs a
 * member or calls a model. What it may send:
 *   - the organiser's ack, one DM on the platform channel, only when the
 *     adder WAS the organiser (phone or connect-DM LID);
 *   - the owner's approval DM, which it only BUILDS: the route queues it
 *     through `queueOwnerDm`, the one door to the owner's phone;
 *   - leaving an unsolicited group after 48 hours, through
 *     `queuePlatformLeaveGroup`, which refuses any group an approved club
 *     owns.
 *
 * SUTTON FC CANNOT BE MOVED FROM HERE. A group any approved club owns
 * (muted or dormant included) is answered "live-org" before anything is
 * read or written; the club writers are compare-and-set on draft/pending;
 * the sweep lists every club's group as already known; and a leave is
 * refused for an approved club's group at queue time and again at
 * dispatch.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { coerceHistoryMessages } from "./onboarding-enrichment-reconcile";
import { parseParticipantSnapshot, snapshotPhone } from "./participant-snapshot";
import {
  APPROVED_CLUB_WHERE,
  DRAFT_CLUB_WHERE,
  PENDING_CLUB_WHERE,
  markClubPendingOnLink,
  returnPendingClubToDraft,
} from "./club-approval";
import {
  UNSOLICITED_AUTO_LEAVE_MS,
  WEAK_ADDER_MATCH_LIST,
  addEvidenceFrom,
  communityRoleOf,
  decideGroupAddLink,
  decideRelinkAfterReAdd,
  decideWeakLinkUpgrade,
  ownerApprovalDmText,
  ownerLinkCorrectionDmText,
  relinkRefIds,
  type AddEvidence,
  type AdderMatch,
  type CommunityRole,
} from "./group-add-rules";
import { PlatformDmRefused, queuePlatformDm, queuePlatformLeaveGroup } from "./platform-jobs";
import { adderHasOpenAdminGroupCode, detectAdminGroupCandidate, recordAdminGroupCandidate } from "./admin-group-link";
import { CAPTURED_HISTORY_RETENTION_MS } from "./captured-history-retention";
import { isSetupHoldEnabled } from "./club-setup-rules";
import { capturedAtLink, clearCapturedChat, fillCapturedChatOnReAdd } from "./captured-chat";
import { ingestGroupDescription } from "./group-description";
import {
  connectNotPostableText,
  decideGroupPostability,
  parsePostabilityInput,
  type PostabilityInput,
  type PostabilityReason,
} from "./group-postability-rules";
import { clearHeldAdd, holdGroupAdd, parseHeldAdd, readPostState, type HeldAdd } from "./group-postability-store";
import { queueOwnerDm } from "./owner-dm";

export interface GroupAddInput {
  groupId: string;
  groupSubject?: unknown;
  addedByPhone?: unknown;
  addedByLid?: unknown;
  participants?: unknown;
  enrichmentHistory?: unknown;
  /**
   * The group's WhatsApp description (2026-10-12). Whatever is handed in
   * goes through `ingestGroupDescription` before anything else happens, so
   * only masked text can be stored from here, whoever the caller is. The
   * route masks it first as well; masking masked text changes nothing.
   */
  groupDescription?: unknown;
  discovered?: unknown;
  /**
   * What the Pi read of the group's settings (2026-10-14): only admins can
   * send, a community announcements group, MatchTime an admin. Absent or
   * malformed is no reading, and changes nothing.
   */
  postability?: unknown;
  /**
   * What the Pi read of the group's place in a WhatsApp community
   * (2026-10-15): `{ isCommunity, isCommunityAnnounce, linkedParent }`. A
   * community's parent group or announcements group is never linked
   * (`communityRoleOf`). Absent or malformed is no reading.
   */
  community?: unknown;
  now?: Date;
}

export type GroupAddOutcome =
  /** An approved club owns this group (Sutton FC): today's "ignore". */
  | { kind: "live-org"; orgId: string }
  /** A club that is not approved owns it (suspended, rejected): silent. */
  | { kind: "club-group"; orgId: string }
  /** Already linked to a club waiting for approval: a re-add, nothing new. */
  | { kind: "already-linked"; connectId: string }
  | {
      kind: "linked";
      connectId: string;
      orgId: string;
      adderMatch: AdderMatch;
      /** For the route to queue through `queueOwnerDm` (purpose owner-approval). */
      ownerDm: { text: string; refId: string };
      organiserAckQueued: boolean;
      /** Present (true) when this linked a request again after a removal
       *  and a re-add with no new code: see "Relink after a re-add". */
      relinked?: true;
      /**
       * Present when the organiser's own add MOVED a request that was
       * linked on weak evidence to another group ("The stronger add
       * wins"). `ownerDm` is then the full approval DM under the request's
       * own key (for when the owner has not been asked yet), and
       * `correctionDm` the correction for when he has.
       */
      upgradedFrom?: { groupId: string; subject: string | null; memberCount: number | null };
      correctionDm?: { text: string; refId: string };
    }
  /**
   * 2026-10-15: a WhatsApp community's parent group or its announcements
   * group. Never a club's group: nothing linked, nothing recorded, nobody
   * told, and MatchTime does not leave it (leaving a community's parent
   * would take it out of the community, and so out of the club's chat).
   */
  | { kind: "community-group"; role: CommunityRole }
  /** Nobody asked MatchTime in (plan 5.6). */
  | { kind: "unsolicited"; recorded: boolean; id: string }
  /** The reconnect sweep found a group that matches no request. */
  | { kind: "discovered-no-match" }
  /** The request or the club moved while we linked. */
  | { kind: "race-lost" }
  /** Slice 2a: already a club's linked admin group. Not silent. */
  | { kind: "admin-group"; orgId: string }
  /** Slice 2a: added by an owner or admin of an approved club: an admin
   *  group waiting for its code. Silent, no approval DM, no ack. */
  | { kind: "admin-group-candidate"; id: string }
  /**
   * 2026-10-14: the add matched an organiser's request, but only admins can
   * send in the group and MatchTime is not one, so it could never post
   * there. NOT linked: the add is held (GroupPostState), the request and
   * the club are untouched, the owner is not asked, and the organiser is
   * told once what to do. Finished by `resumeHeldGroupAdd` when MatchTime
   * is made an admin there.
   */
  | {
      kind: "held-not-postable";
      connectId: string;
      reason: Exclude<PostabilityReason, "ok">;
      organiserDmQueued: boolean;
    };

/** Must MatchTime stay silent in the group after this outcome? */
export function isSilentOutcome(o: GroupAddOutcome): boolean {
  return o.kind !== "live-org" && o.kind !== "discovered-no-match" && o.kind !== "admin-group";
}

class LinkAborted extends Error {}

const LINKED_AND_WAITING = (groupId: string) => ({
  groupId,
  status: "group_linked",
  botRemovedAt: null,
  org: PENDING_CLUB_WHERE,
});

export async function handleSelfJoinGroupAdd(input: GroupAddInput): Promise<GroupAddOutcome> {
  const now = input.now ?? new Date();
  const groupId = input.groupId;
  const subject = typeof input.groupSubject === "string" && input.groupSubject.trim() ? input.groupSubject.trim() : null;
  // Masked here, before any read or write. `input.groupDescription` is
  // not used again below. A group the reconnect sweep found brings none:
  // the sweep reads groups that have nothing to do with MatchTime, and
  // only a real add may bring a description.
  const description = input.discovered === true ? null : ingestGroupDescription(input.groupDescription).text;

  // 1. A club already owns this group. An APPROVED one first, whatever its
  //    mute switch or dormancy: that is Sutton FC's case, and it is today's
  //    "ignore". Nothing below runs for it.
  const approvedOwner = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, ...APPROVED_CLUB_WHERE },
    select: { id: true },
  });
  if (approvedOwner) return { kind: "live-org", orgId: approvedOwner.id };
  const otherOwner = await db.organisation.findFirst({ where: { whatsappGroupId: groupId }, select: { id: true } });
  if (otherOwner) return { kind: "club-group", orgId: otherOwner.id };
  // Slice 2a: a club's linked admin group is not a new club either.
  const adminGroupOwner = await db.organisation.findFirst({ where: { adminGroupId: groupId }, select: { id: true } });
  if (adminGroupOwner) return { kind: "admin-group", orgId: adminGroupOwner.id };

  // 1b. A WhatsApp community's parent group or announcements group
  //     (2026-10-15, the FNF incident). Joining a group inside a community
  //     puts MatchTime in both, each as an add of its own, and the
  //     organiser is in their rosters. Never a club's group: not linked,
  //     not recorded (so never auto-left), nobody told.
  const community = communityRoleOf(input);
  if (community) {
    console.log(`[group-add] ${groupId} ("${subject ?? "?"}"): a community ${community} group; not linked, not left, nobody told`);
    return { kind: "community-group", role: community };
  }

  // 2. A re-add of a group already linked and waiting.
  const existing = await db.clubConnect.findFirst({
    where: LINKED_AND_WAITING(groupId),
    select: { id: true, linkedAt: true },
  });
  if (existing) {
    // F3: a re-add may carry the chat the first add could not fetch. It
    // never replaces chat already stored. And it stores nothing on a link
    // already past the retention limit (captured-history-expiry.ts): the
    // next cron run would only delete it again.
    const late = coerceHistoryMessages(input.enrichmentHistory);
    const pastRetention =
      existing.linkedAt != null && now.getTime() - existing.linkedAt.getTime() >= CAPTURED_HISTORY_RETENTION_MS;
    // The group description follows the same rule. And neither is written
    // to a request that a removal, a rejection or an approval cleared
    // since it was read above: the statement itself checks the request is
    // still linked (captured-chat.ts).
    if (!pastRetention) await fillCapturedChatOnReAdd(db, existing.id, { history: late, description });
    return { kind: "already-linked", connectId: existing.id };
  }

  // 3. Which request, if any (plan 2.3).
  const ev = addEvidenceFrom(input);
  const candidates = await db.clubConnect.findMany({
    where: { status: { in: ["issued", "dm_verified"] }, org: DRAFT_CLUB_WHERE },
    select: LINK_ROW_SELECT,
  });
  const decision = decideGroupAddLink(ev, candidates, now);
  const snapshot = parseParticipantSnapshot(input.participants);
  const blocked = blockedBy(input.postability);

  if (!decision.link) {
    console.log(
      `[group-add] ${groupId}: no request matches (${decision.reason}; adder phone=${ev.addedByPhone ?? "-"} ` +
        `lid=${ev.addedByLid ?? "-"}, ${snapshot.length} member(s)${ev.discovered ? ", discovered" : ""})`,
    );
    // A group the reconnect sweep found may be one MatchTime was in long
    // before self-join. It is never recorded, so it is never auto-left.
    if (ev.discovered) return { kind: "discovered-no-match" };
    // Relink after a re-add (2026-10-11): the organiser took MatchTime out
    // of the group while the club waited and put it straight back, with no
    // new code. BEFORE the admin-group rule: the organiser already proved
    // this group is the club's, so their re-add inside the window is a
    // relink even when they also run an approved club, or a member of the
    // group is an admin of one with a link code open. When the rule's
    // conditions do not hold (or stop holding while linking), the add
    // carries on below exactly as before.
    const ctx = { groupId, subject, snapshot, ev, history: input.enrichmentHistory, description, now };
    const relink = await findRelinkAfterReAdd(groupId, ev, now);
    if (relink && blocked) {
      const removedAt = relink.expect.botRemovedAt instanceof Date ? relink.expect.botRemovedAt.toISOString() : null;
      return holdAdd(groupId, subject, ev, input.participants, blocked, relink.row, {
        kind: "relink",
        status: "group_linked",
        removedAt,
        adderMatch: relink.adderMatch,
        organiserPresent: relink.organiserPresent,
      }, now);
    }
    if (relink) {
      const out = await linkGroupToRequest(ctx, relink);
      if (out !== RELINK_ABANDONED) return out;
    }
    // The stronger add wins (2026-10-15): the organiser's own add of this
    // group moves their request off a group it was linked to on weak
    // evidence (the FNF incident: a community's parent group). Never into
    // a group MatchTime cannot post in.
    if (!blocked) {
      const upgraded = await upgradeWeakLinkFor(ctx);
      if (upgraded) return upgraded;
    }
    // Slice 2a (plan 2.4): after every connect-request match has failed,
    // an add by an owner or admin of an approved club is their admins' HQ
    // group, waiting for its code (a real tag and the code). Still silent, and
    // still left after 48 hours if no code comes, but no approval DM and
    // no organiser ack. A matching connect request (above) wins.
    if (
      await detectAdminGroupCandidate({
        addedByPhone: ev.addedByPhone,
        addedByLid: ev.addedByLid,
        participants: input.participants,
        now,
      })
    ) {
      const row = await recordAdminGroupCandidate({
        groupId,
        subject,
        memberCount: snapshot.length,
        addedByPhone: ev.addedByPhone,
        addedByLid: ev.addedByLid,
        now,
      });
      return { kind: "admin-group-candidate", id: row.id };
    }
    return recordUnsolicited(groupId, subject, snapshot.length, ev.addedByPhone, ev.addedByLid, now);
  }

  const row = candidates.find((c) => c.id === decision.connectId);
  if (!row) return { kind: "race-lost" };
  // 2026-10-14: a group MatchTime could never post in is not linked. The
  // add is held until MatchTime is made admin there (or the organiser adds
  // it to the players' group instead, which links this same request).
  if (blocked) {
    return holdAdd(groupId, subject, ev, input.participants, blocked, row, {
      kind: "first",
      status: row.status,
      removedAt: null,
      adderMatch: decision.adderMatch,
      organiserPresent: decision.organiserPresent,
    }, now);
  }
  const ctx = { groupId, subject, snapshot, ev, history: input.enrichmentHistory, description, now };
  const out = await linkGroupToRequest(ctx, {
    row,
    // Compare-and-set on the status the request had when it was matched.
    expect: { id: row.id, status: row.status },
    adderMatch: decision.adderMatch,
    organiserPresent: decision.organiserPresent,
    ownerDmRefId: row.id,
    organiserAckRefId: `${row.id}:in-group`,
    relink: null,
  });
  // Only a relink can be abandoned; a first link never is.
  if (out === RELINK_ABANDONED) return { kind: "race-lost" };
  // The race of the FNF incident: a weaker add of another group (the
  // community's parent) linked this request a moment before the
  // organiser's own add could. Strength beats arrival order.
  if (out.kind === "race-lost" && (decision.adderMatch === "phone" || decision.adderMatch === "lid")) {
    const upgraded = await upgradeWeakLinkFor(ctx);
    if (upgraded) return upgraded;
  }
  return out;
}

// ── The stronger add wins (2026-10-15) ───────────────────────────────────

/**
 * The organiser added MatchTime to this group themselves, and their
 * request is linked to ANOTHER group on weak evidence: move it here. The
 * rule is `decideWeakLinkUpgrade` (group-add-rules.ts); the move is
 * `relinkToOrganiserGroup`, which the one-off correction script uses too.
 * Null when the rule does not hold, or the request moved while linking.
 */
async function upgradeWeakLinkFor(ctx: AddContext): Promise<GroupAddOutcome | null> {
  const { groupId, ev, now } = ctx;
  if (ev.discovered || (!ev.addedByPhone && !ev.addedByLid)) return null;
  const or: Array<Record<string, unknown>> = [];
  if (ev.addedByPhone) or.push({ phone: ev.addedByPhone });
  if (ev.addedByLid) or.push({ dmLid: ev.addedByLid });
  const rows = await db.clubConnect.findMany({
    where: {
      status: "group_linked",
      botRemovedAt: null,
      adderMatch: { in: WEAK_ADDER_MATCH_LIST },
      groupId: { not: groupId },
      OR: or,
    },
    select: {
      id: true,
      groupId: true,
      status: true,
      botRemovedAt: true,
      adderMatch: true,
      phone: true,
      dmLid: true,
      linkedAt: true,
      org: { select: { approvalStatus: true } },
    },
  });
  if (!rows || rows.length === 0) return null;
  const decision = decideWeakLinkUpgrade(
    ev,
    groupId,
    // The rule re-checks every condition the query filtered on.
    rows.map((r) => ({ ...r, orgApprovalStatus: r.org?.approvalStatus ?? "" })),
    now,
  );
  if (!decision.upgrade) {
    console.log(`[group-add] ${groupId}: weak link not moved here (${decision.reason})`);
    return null;
  }
  const out = await relinkToOrganiserGroup({
    connectId: decision.connectId,
    fromGroupId: decision.fromGroupId,
    toGroupId: groupId,
    subject: ctx.subject,
    snapshot: ctx.snapshot,
    ev,
    adderMatch: decision.adderMatch,
    history: ctx.history,
    description: ctx.description,
    now,
  });
  return out.kind === "linked" || out.kind === "already-linked" ? out : null;
}

export interface RelinkToOrganiserGroupInput {
  connectId: string;
  /** The group the request is linked to now, on weak evidence. */
  fromGroupId: string;
  /** The organiser's group. */
  toGroupId: string;
  subject: string | null;
  snapshot: ReturnType<typeof parseParticipantSnapshot>;
  /** Stored as the member count; defaults to the snapshot's size. */
  memberCount?: number;
  ev: AddEvidence;
  adderMatch: "phone" | "lid";
  /** The Pi's `enrichmentHistory`, unread. */
  history: unknown;
  /** ALREADY MASKED, or null. */
  description: string | null;
  now: Date;
}

/**
 * Move a request linked on weak evidence to the organiser's group. THE one
 * move: the live add path and `scripts/relink-self-join.ts` both come
 * through here. Writes only while the request still looks exactly as the
 * rule saw it (linked to `fromGroupId`, MatchTime still there, weak
 * evidence, club pending), under the locks of BOTH groups, taken in sorted
 * order so two moves cannot deadlock. The approval (`decideClub`) takes
 * the lock of the group it reads and checks the request still names it.
 *
 * The earlier group is simply not linked any more: not left, not recorded,
 * nobody told. The chat captured with the weak link was the other group's,
 * so it is deleted and replaced with what this add brought.
 *
 * Builds, never sends, the owner's DMs: the caller hands the outcome to
 * `queueOwnerDmForLink`. Queues the organiser's "I'm in" ack, once ever.
 */
export async function relinkToOrganiserGroup(
  a: RelinkToOrganiserGroupInput,
): Promise<GroupAddOutcome> {
  const history = coerceHistoryMessages(a.history);
  const memberCount = a.memberCount ?? a.snapshot.length;
  let before: { groupSubject: string | null; memberCount: number | null } | null = null;
  let result: "linked" | "race-lost" | { already: string };
  result = await db.$transaction(async (tx) => {
    for (const g of [a.fromGroupId, a.toGroupId].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-add:${g}`}))`;
    }
    const taken = await tx.clubConnect.findFirst({ where: LINKED_AND_WAITING(a.toGroupId), select: { id: true } });
    if (taken) return { already: taken.id };
    before = await tx.clubConnect.findFirst({
      where: { id: a.connectId, groupId: a.fromGroupId },
      select: { groupSubject: true, memberCount: true },
    });
    const { count } = await tx.clubConnect.updateMany({
      where: {
        id: a.connectId,
        status: "group_linked",
        groupId: a.fromGroupId,
        botRemovedAt: null,
        adderMatch: { in: WEAK_ADDER_MATCH_LIST },
        org: PENDING_CLUB_WHERE,
      },
      data: {
        groupId: a.toGroupId,
        groupSubject: a.subject,
        memberCount,
        addedByPhone: a.ev.addedByPhone,
        addedByLid: a.ev.addedByLid,
        adderMatch: a.adderMatch,
        participants: a.snapshot.length > 0 ? (a.snapshot.map((p) => ({ ...p })) as unknown as object) : undefined,
        linkedAt: a.now,
      },
    });
    if (count !== 1) return "race-lost" as const;
    if (a.snapshot.length === 0) {
      // The other group's member list must not be imported at approval.
      await tx.$executeRaw`UPDATE "ClubConnect" SET "participants" = NULL WHERE "id" = ${a.connectId}`;
    }
    // The chat captured with the weak link is the OTHER group's.
    await clearCapturedChat(tx, a.connectId);
    await fillCapturedChatOnReAdd(tx, a.connectId, { history, description: a.description });
    // A waiting club's group now: never auto-left.
    await tx.unsolicitedGroup.updateMany({
      where: { groupId: a.toGroupId, leftAt: null },
      data: { leftAt: a.now, awaitingAdminLink: false },
    });
    return "linked" as const;
  });
  if (typeof result === "object") return { kind: "already-linked", connectId: result.already };
  if (result === "race-lost") {
    console.warn(`[group-add] ${a.toGroupId}: request ${a.connectId} moved while being moved here; nothing written`);
    return { kind: "race-lost" };
  }
  const prev = before as { groupSubject: string | null; memberCount: number | null } | null;

  const row = await db.clubConnect.findUnique({
    where: { id: a.connectId },
    select: { id: true, orgId: true, userId: true, code: true, phone: true, dmAt: true, dmPhone: true },
  });
  if (!row) return { kind: "race-lost" };
  const [org, organiser, alsoIn] = await Promise.all([
    db.organisation.findUnique({ where: { id: row.orgId }, select: { name: true, language: true } }),
    db.user.findUnique({ where: { id: row.userId }, select: { name: true } }),
    loadAlsoIn(a.snapshot),
  ]);
  const club = org?.name ?? "(unnamed club)";
  const ownerDm = {
    refId: row.id,
    text: ownerApprovalDmText({
      club,
      code: row.code,
      organiserName: organiser?.name ?? null,
      organiserPhone: row.phone,
      adderMatch: a.adderMatch,
      organiserPresent: true,
      numberUnconfirmed: row.dmAt !== null && row.dmPhone === null,
      groupSubject: a.subject,
      memberCount,
      clubLang: org?.language ?? null,
      alsoIn,
    }),
  };
  const correctionDm = {
    refId: `${row.id}:relinked:${a.toGroupId}`,
    text: ownerLinkCorrectionDmText({
      club,
      code: row.code,
      groupSubject: a.subject,
      memberCount,
      previousSubject: prev?.groupSubject ?? null,
      previousMemberCount: prev?.memberCount ?? null,
      adderMatch: a.adderMatch,
    }),
  };
  // The weak link sent no ack (the adder was not the organiser): this is
  // the organiser's one "I'm in", under the link's own once-ever key.
  const organiserAckQueued = await queueOrganiserAck(`${row.id}:in-group`, row.phone, inGroupAckText(org?.language, a.subject));
  console.log(
    `[group-add] ${a.toGroupId} ("${a.subject ?? "?"}"): request ${row.id} MOVED here from ${a.fromGroupId} ` +
      `("${prev?.groupSubject ?? "?"}", weak link): adder=${a.adderMatch}, ${memberCount} member(s), ` +
      `${history.length} chat message(s); the earlier group is not linked, not left; organiser ack ${organiserAckQueued ? "queued" : "not sent"}`,
  );
  return {
    kind: "linked",
    connectId: row.id,
    orgId: row.orgId,
    adderMatch: a.adderMatch,
    ownerDm,
    organiserAckQueued,
    upgradedFrom: { groupId: a.fromGroupId, subject: prev?.groupSubject ?? null, memberCount: prev?.memberCount ?? null },
    correctionDm,
  };
}

/**
 * The owner's DM after a link, through `queueOwnerDm` (purpose
 * owner-approval), and `ownerDmQueuedAt`. Used by the bot-added route and
 * by the resume of a held add.
 *
 *   An ordinary link: its one approval DM, unless the request no longer
 *   names this group (the organiser's own add moved it a moment ago, and
 *   the move has told the owner itself).
 *
 *   A move ("The stronger add wins"): if the owner has not been asked
 *   about this request yet, the full approval DM under the request's own
 *   key, which also stops a late copy of the weak link's DM (same key);
 *   if he has, the correction, once.
 */
export async function queueOwnerDmForLink(
  groupId: string,
  outcome: Extract<GroupAddOutcome, { kind: "linked" }>,
): Promise<"queued" | "corrected" | "skipped-moved" | "not-queued"> {
  if (outcome.upgradedFrom && outcome.correctionDm) {
    const asked = await db.platformJob.findFirst({
      where: { purpose: "owner-approval", refId: outcome.ownerDm.refId },
      select: { id: true },
    });
    if (!asked) {
      const dm = await queueOwnerDm(outcome.ownerDm.text, "owner-approval", outcome.ownerDm.refId);
      if (dm.queued > 0 || dm.skipped > 0) await markOwnerDmQueued(outcome.connectId);
      // Nobody slipped the weak link's DM in first: this one is the only one.
      if (dm.skipped === 0) return dm.queued > 0 ? "queued" : "not-queued";
    }
    const fix = await queueOwnerDm(outcome.correctionDm.text, "owner-approval", outcome.correctionDm.refId);
    if (fix.queued > 0 || fix.skipped > 0) await markOwnerDmQueued(outcome.connectId);
    return fix.queued > 0 || fix.skipped > 0 ? "corrected" : "not-queued";
  }
  const still = await db.clubConnect.findFirst({
    where: { id: outcome.connectId, groupId, status: "group_linked" },
    select: { id: true },
  });
  if (!still) {
    console.log(`[group-add] ${groupId}: request ${outcome.connectId} was moved to the organiser's group; its DM is that move's`);
    return "skipped-moved";
  }
  const dm = await queueOwnerDm(outcome.ownerDm.text, "owner-approval", outcome.ownerDm.refId);
  if (dm.queued > 0 || dm.skipped > 0) await markOwnerDmQueued(outcome.connectId);
  return dm.queued > 0 || dm.skipped > 0 ? "queued" : "not-queued";
}

// ── A history bundle that arrived after the add (2026-10-15) ─────────────

/**
 * The Pi read the group's shared-history bundle AFTER its bot-added post
 * had gone without it, and posts it on its own (`lateHistory`). It is
 * stored only on a request linked to this very group and waiting, where
 * none is stored yet, inside the retention limit: the same rule as a re-add
 * (`fillCapturedChatOnReAdd`). Anything else writes nothing at all: no
 * request is matched, nothing recorded, nothing left.
 */
export async function attachLateGroupHistory(
  groupId: string,
  enrichmentHistory: unknown,
  now: Date = new Date(),
): Promise<"stored" | "not-linked" | "already-stored" | "past-retention" | "empty"> {
  const history = coerceHistoryMessages(enrichmentHistory);
  if (history.length === 0) return "empty";
  const linked = await db.clubConnect.findFirst({
    where: LINKED_AND_WAITING(groupId),
    select: { id: true, linkedAt: true },
  });
  if (!linked) return "not-linked";
  if (linked.linkedAt != null && now.getTime() - linked.linkedAt.getTime() >= CAPTURED_HISTORY_RETENTION_MS) {
    return "past-retention";
  }
  const r = await fillCapturedChatOnReAdd(db, linked.id, { history, description: null });
  return r.history > 0 ? "stored" : "already-stored";
}

// ── A group MatchTime cannot post in (2026-10-14) ────────────────────────

/** The reading, when it says MatchTime cannot post; null otherwise (no reading included). */
function blockedBy(raw: unknown): { input: PostabilityInput; reason: Exclude<PostabilityReason, "ok"> } | null {
  const input = parsePostabilityInput(raw);
  if (!input) return null;
  const d = decideGroupPostability(input);
  return d.canPost ? null : { input, reason: d.reason as Exclude<PostabilityReason, "ok"> };
}

/**
 * Hold a matched add in a group MatchTime cannot post in, and tell the
 * organiser once (per request and group) what to do. Nothing is linked, no
 * club changes state, the owner is not asked. The DM goes on the platform
 * channel (purpose connect-reply, like the organiser's "I'm in" ack), to
 * the organiser who asked for the code, in the club's language.
 */
async function holdAdd(
  groupId: string,
  subject: string | null,
  ev: AddEvidence,
  participants: unknown,
  blocked: NonNullable<ReturnType<typeof blockedBy>>,
  row: { id: string; orgId: string; phone: string },
  how: Pick<HeldAdd, "kind" | "status" | "removedAt" | "adderMatch" | "organiserPresent">,
  now: Date,
): Promise<GroupAddOutcome> {
  const held: HeldAdd = {
    ...how,
    subject,
    addedByPhone: ev.addedByPhone,
    addedByLid: ev.addedByLid,
    participants: Array.isArray(participants) ? participants : [],
    reason: blocked.reason,
  };
  const stored = await holdGroupAdd({ groupId, connectId: row.id, held, input: blocked.input, now });
  const org = await db.organisation.findUnique({ where: { id: row.orgId }, select: { language: true } });
  const refId = `${row.id}:not-postable:${groupId}`;
  let organiserDmQueued = false;
  const already = await db.platformJob.findFirst({ where: { purpose: "connect-reply", refId }, select: { id: true } });
  if (!already) {
    try {
      await queuePlatformDm({
        phone: row.phone,
        text: connectNotPostableText(org?.language, { group: subject, reason: blocked.reason }),
        purpose: "connect-reply",
        refId,
      });
      organiserDmQueued = true;
    } catch (err) {
      if (!(err instanceof PlatformDmRefused)) throw err;
      console.error(`[group-add] not-postable DM for ${row.id} not queued: ${err.reason}`);
    }
  }
  console.log(
    `[group-add] ${groupId}: matched request ${row.id} (${how.kind}) but MatchTime cannot post there (${blocked.reason}); ` +
      `held${stored ? "" : " (NOT stored: no table yet)"}, not linked; organiser DM ${organiserDmQueued ? "queued" : "not sent"}`,
  );
  return { kind: "held-not-postable", connectId: row.id, reason: blocked.reason, organiserDmQueued };
}

export type ResumeOutcome =
  | { kind: "none" }
  | { kind: "superseded" }
  | { kind: "race-lost" }
  | { kind: "linked"; connectId: string; orgId: string };

/**
 * MatchTime can post in a group where an add was held (it was made an
 * admin, or the setting was switched off): finish the link exactly as the
 * add would have, through the same `linkGroupToRequest`, then queue the
 * owner's one approval DM as the bot-added route does. The chat history
 * and the description the add brought were not kept while it was held, so
 * a resumed link has none (the learned setup then has nothing to read).
 *
 * The hold is cleared whatever happens: linked, or the request moved on
 * (linked elsewhere, expired, a newer code). Never throws on a missing
 * table; answers "none" when nothing is held.
 */
export async function resumeHeldGroupAdd(groupId: string, now: Date = new Date()): Promise<ResumeOutcome> {
  const state = await readPostState(groupId);
  const connectId = state?.heldConnectId ?? null;
  const held = parseHeldAdd(state?.heldAdd);
  if (!connectId || !held) return { kind: "none" };

  // 2026-10-15: a community's announcements group is never a club's group,
  // even once MatchTime is made admin there. An add held there before that
  // rule existed is dropped, not finished.
  if (held.reason === "community-announce") {
    await clearHeldAdd(groupId, connectId);
    console.log(`[group-add] ${groupId}: held add for ${connectId} dropped (a community announcements group)`);
    return { kind: "superseded" };
  }
  const row = await db.clubConnect.findUnique({ where: { id: connectId }, select: LINK_ROW_SELECT });
  if (!row) {
    await clearHeldAdd(groupId, connectId);
    return { kind: "race-lost" };
  }
  const newer = newerRequestWhere(row);
  if (held.kind === "first" && (await db.clubConnect.count({ where: newer })) > 0) {
    await clearHeldAdd(groupId, connectId);
    console.log(`[group-add] ${groupId}: held add for ${connectId} not finished (newer request)`);
    return { kind: "superseded" };
  }
  const ev = addEvidenceFrom({
    addedByPhone: held.addedByPhone,
    addedByLid: held.addedByLid,
    participants: held.participants,
    discovered: false,
  });
  const snapshot = parseParticipantSnapshot(held.participants);
  const removedAt = held.removedAt ? new Date(held.removedAt) : null;
  const relink = held.kind === "relink" && removedAt && !Number.isNaN(removedAt.getTime());
  const refs = relink ? relinkRefIds(row.id, removedAt!) : null;
  const out = await linkGroupToRequest(
    { groupId, subject: held.subject, snapshot, ev, history: [], description: null, now },
    {
      row,
      expect: relink
        ? { id: row.id, status: "group_linked", groupId, botRemovedAt: removedAt }
        : { id: row.id, status: held.status },
      adderMatch: held.adderMatch as AdderMatch,
      organiserPresent: held.organiserPresent,
      ownerDmRefId: refs?.ownerDm ?? row.id,
      organiserAckRefId: refs?.organiserAck ?? `${row.id}:in-group`,
      relink: relink ? { newerRequestWhere: newer } : null,
    },
  );
  await clearHeldAdd(groupId, connectId);
  if (out === RELINK_ABANDONED) return { kind: "superseded" };
  if (out.kind !== "linked") {
    console.log(`[group-add] ${groupId}: held add for ${connectId} not finished (${out.kind})`);
    return { kind: "race-lost" };
  }
  // As the bot-added route does after a link: the ONE owner DM.
  await queueOwnerDmForLink(groupId, out);
  console.log(`[group-add] ${groupId}: MatchTime can post there now; held add for ${connectId} linked`);
  return { kind: "linked", connectId: out.connectId, orgId: out.orgId };
}

/** `linkGroupToRequest` gave a relink up under its locks: the club got a
 *  newer connect request in the meantime. Nothing was written. */
const RELINK_ABANDONED = "relink-abandoned" as const;

/** "Does this club have another connect request issued at or after this
 *  one?" Asked once to decide a relink and again under its locks. */
const newerRequestWhere = (r: { id: string; orgId: string; issuedAt: Date }) => ({
  orgId: r.orgId,
  id: { not: r.id },
  issuedAt: { gte: r.issuedAt },
});

/** The columns of a connect request the matcher and the link read. */
const LINK_ROW_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  code: true,
  status: true,
  phone: true,
  dmAt: true,
  dmPhone: true,
  dmLid: true,
  issuedAt: true,
  expiresAt: true,
  addWindowEndsAt: true,
} as const;

interface LinkRow {
  id: string;
  orgId: string;
  userId: string;
  code: string;
  phone: string;
  dmAt: Date | null;
  dmPhone: string | null;
}

/** The request an add is to be linked to, and how. */
interface LinkTarget {
  row: LinkRow;
  /** The compare-and-set: the request is written only while it still looks like this. */
  expect: Record<string, unknown>;
  adderMatch: AdderMatch;
  organiserPresent: boolean;
  /** Once-ever keys for the owner's DM and the organiser's ack. */
  ownerDmRefId: string;
  organiserAckRefId: string;
  /** Null for a first link. For a relink after a re-add: what must still
   *  be true of the club once the link holds its locks. */
  relink: { newerRequestWhere: ReturnType<typeof newerRequestWhere> } | null;
}

interface AddContext {
  groupId: string;
  subject: string | null;
  snapshot: ReturnType<typeof parseParticipantSnapshot>;
  ev: AddEvidence;
  /** The Pi's `enrichmentHistory`, unread. */
  history: unknown;
  /** The group description, ALREADY MASKED (`ingestGroupDescription`), or null. */
  description: string | null;
  now: Date;
}

/**
 * Relink after a re-add: is there a link MatchTime was removed from, in
 * this very group, that this add should link again? The rule (every
 * condition, and the window) is `decideRelinkAfterReAdd` in
 * group-add-rules.ts. Null means no: the add carries on as before (the
 * admin-group rule, then unsolicited).
 */
async function findRelinkAfterReAdd(groupId: string, ev: AddEvidence, now: Date): Promise<LinkTarget | null> {
  const removed = await db.clubConnect.findMany({
    where: { groupId, status: "group_linked", botRemovedAt: { not: null } },
    select: { ...LINK_ROW_SELECT, groupId: true, botRemovedAt: true, org: { select: { approvalStatus: true } } },
  });
  if (!removed || removed.length === 0) return null;
  const candidates = await Promise.all(
    removed.map(async (r) => ({
      id: r.id,
      groupId: r.groupId,
      status: r.status,
      botRemovedAt: r.botRemovedAt,
      phone: r.phone,
      dmLid: r.dmLid,
      orgApprovalStatus: r.org.approvalStatus,
      // Any other request of this club issued since: the organiser went
      // back for a new code, so the code flow owns the club now. Asked
      // again under the link's locks (see linkGroupToRequest).
      newerRequestExists: (await db.clubConnect.count({ where: newerRequestWhere(r) })) > 0,
    })),
  );
  const decision = decideRelinkAfterReAdd(ev, groupId, candidates, now);
  if (!decision.relink) {
    console.log(`[group-add] ${groupId}: not relinked after re-add (${decision.reason})`);
    return null;
  }
  const row = removed.find((r) => r.id === decision.connectId);
  if (!row) return null;
  const refs = relinkRefIds(row.id, decision.removedAt);
  return {
    row,
    // Compare-and-set on the very removal that was read: a second delivery
    // of the same add, or another removal in between, finds it gone.
    expect: { id: row.id, status: "group_linked", groupId, botRemovedAt: decision.removedAt },
    adderMatch: decision.adderMatch,
    organiserPresent: true,
    ownerDmRefId: refs.ownerDm,
    organiserAckRefId: refs.organiserAck,
    relink: { newerRequestWhere: newerRequestWhere(row) },
  };
}

/**
 * Link this add to a request and set its club pending, together or not at
 * all, then build what the owner and the organiser are told. THE one link:
 * a first link and a relink after a re-add both come through here, and
 * differ only in the compare-and-set and the dedupe keys they bring, and
 * in three things a relink does under the same transaction: it re-checks
 * that no newer request appeared, it never keeps the member list from
 * before the removal, and it closes any unsolicited row for the group.
 *
 * LOCKS. Every link takes `group-add:<groupId>`. A relink then takes
 * `club-connect:<orgId>`, the lock `issueConnectCode` (club-connect.ts)
 * issues codes under, and only then asks again whether the club has a
 * newer request. Without it a "get code" tap could read the club as draft,
 * and commit its new code after the relink had counted none: the club
 * would be pending with a newer `issued` request, and the card (which
 * reads the latest request) would show a pending club with no group. With
 * it, one of the two goes first: the code first, and the relink sees it
 * and gives up; the relink first, and the code issuer, once it has the
 * lock, reads the club as pending and refuses ("not-draft").
 *
 * It cannot deadlock. The order is always group, then club, and this is
 * the only place that takes both: `issueConnectCode` takes the club lock
 * alone (and nothing before it, no row lock included), the approval
 * (`decideClub`) takes the group lock alone, and the connect DM takes the
 * unrelated site-wide `club-connect:links`. Nothing takes the club lock
 * and then waits for a group lock, so no cycle can form.
 */
async function linkGroupToRequest(
  ctx: AddContext,
  target: LinkTarget,
): Promise<GroupAddOutcome | typeof RELINK_ABANDONED> {
  const { groupId, subject, snapshot, ev, now, description } = ctx;
  const { row } = target;
  const relinked = target.relink !== null;
  const history = coerceHistoryMessages(ctx.history);

  // 4. Link, and set the club pending, together or not at all.
  let result: "linked" | "race-lost" | typeof RELINK_ABANDONED | { already: string };
  try {
    result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-add:${groupId}`}))`;
      const again = await tx.clubConnect.findFirst({ where: LINKED_AND_WAITING(groupId), select: { id: true } });
      if (again) return { already: again.id };
      if (target.relink) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`club-connect:${row.orgId}`}))`;
        if ((await tx.clubConnect.count({ where: target.relink.newerRequestWhere })) > 0) return RELINK_ABANDONED;
      }
      const { count } = await tx.clubConnect.updateMany({
        where: target.expect,
        data: {
          status: "group_linked",
          groupId,
          groupSubject: subject,
          memberCount: snapshot.length,
          addedByPhone: ev.addedByPhone,
          addedByLid: ev.addedByLid,
          adderMatch: target.adderMatch,
          participants: snapshot.length > 0 ? (snapshot.map((p) => ({ ...p })) as unknown as object) : undefined,
          // F3: the chat, kept until the learned setup has read it once
          // after approval (or the club is rejected). See setup-learning/.
          // A relink stores what THIS add brought: the removal deleted
          // the earlier chat, so there is nothing older to keep.
          // With it, the group description, masked, kept and deleted
          // with the chat. A first link has none stored, and a removal
          // deleted any earlier one, so this never replaces one.
          ...capturedAtLink({ history, description }),
          // Also where the chat's retention is measured from (captured-
          // history-expiry.ts). A relink sets it again: its chat was
          // stored now, and the club has been waiting since now.
          linkedAt: now,
          botRemovedAt: null,
        },
      });
      if (count !== 1) return "race-lost" as const;
      // Throwing rolls the link back: a request must never say
      // group_linked while its club is not pending.
      if (!(await markClubPendingOnLink(row.orgId, tx))) throw new LinkAborted();
      if (relinked) {
        // The row still holds the member list from BEFORE the removal. A
        // re-add that brought none must not leave it there beside a
        // member count of 0: approval imports that list. (A first link
        // has no earlier list: only a link ever writes one.)
        if (snapshot.length === 0) {
          await tx.$executeRaw`UPDATE "ClubConnect" SET "participants" = NULL WHERE "id" = ${row.id}`;
        }
        // The group may still have an open unsolicited row: an add that
        // reached us before this rule existed, one by somebody else, or
        // an admin-group candidate. It is a waiting club's group now:
        // close the row, or the 48-hour auto-leave would take MatchTime
        // out of it. (`awaitingAdminLink` is cleared with it, as
        // linkAdminGroup does when it closes one.)
        await tx.unsolicitedGroup.updateMany({
          where: { groupId, leftAt: null },
          data: { leftAt: now, awaitingAdminLink: false },
        });
      }
      return "linked" as const;
    });
  } catch (err) {
    if (err instanceof LinkAborted) result = "race-lost";
    else throw err;
  }
  if (result === RELINK_ABANDONED) {
    console.log(`[group-add] ${groupId}: not relinked after re-add (newer-request, seen while linking ${row.id})`);
    return RELINK_ABANDONED;
  }
  if (result === "race-lost") {
    console.warn(`[group-add] ${groupId}: request ${row.id} or its club moved while linking; nothing written`);
    return { kind: "race-lost" };
  }
  if (typeof result === "object") return { kind: "already-linked", connectId: result.already };

  // 5. What the owner and the organiser are told.
  const [org, organiser, alsoIn] = await Promise.all([
    db.organisation.findUnique({ where: { id: row.orgId }, select: { name: true, language: true } }),
    db.user.findUnique({ where: { id: row.userId }, select: { name: true } }),
    loadAlsoIn(snapshot),
  ]);
  const ownerDm = {
    refId: target.ownerDmRefId,
    text: ownerApprovalDmText({
      club: org?.name ?? "(unnamed club)",
      code: row.code,
      organiserName: organiser?.name ?? null,
      organiserPhone: row.phone,
      adderMatch: target.adderMatch,
      organiserPresent: target.organiserPresent,
      numberUnconfirmed: row.dmAt !== null && row.dmPhone === null,
      groupSubject: subject,
      memberCount: snapshot.length,
      clubLang: org?.language ?? null,
      alsoIn,
    }),
  };

  let organiserAckQueued = false;
  if (target.adderMatch === "phone" || target.adderMatch === "lid") {
    organiserAckQueued = await queueOrganiserAck(
      target.organiserAckRefId,
      row.phone,
      inGroupAckText(org?.language, subject),
    );
  }

  console.log(
    `[group-add] ${groupId} ("${subject ?? "?"}") ${relinked ? "relinked after re-add" : "linked"} to ${row.id} ` +
      `(club ${row.orgId}, now pending): adder=${target.adderMatch}, ${snapshot.length} member(s), ` +
      `${history.length} chat message(s), ${description ? `description ${description.length} chars` : "no description"}, ` +
      `organiser ack ${organiserAckQueued ? "queued" : "not sent"}`,
  );
  return {
    kind: "linked",
    connectId: row.id,
    orgId: row.orgId,
    adderMatch: target.adderMatch,
    ownerDm,
    organiserAckQueued,
    ...(relinked ? { relinked: true as const } : {}),
  };
}

/** The one approval DM went out for this request (plan 3.2 `ownerDmQueuedAt`). */
export async function markOwnerDmQueued(connectId: string, now: Date = new Date()): Promise<void> {
  await db.clubConnect.updateMany({ where: { id: connectId, ownerDmQueuedAt: null }, data: { ownerDmQueuedAt: now } });
}

async function recordUnsolicited(
  groupId: string,
  subject: string | null,
  memberCount: number,
  addedByPhone: string | null,
  addedByLid: string | null,
  now: Date,
): Promise<GroupAddOutcome> {
  const open = await db.unsolicitedGroup.findFirst({ where: { groupId, leftAt: null }, select: { id: true } });
  if (open) return { kind: "unsolicited", recorded: false, id: open.id };
  const row = await db.unsolicitedGroup.create({
    data: { groupId, subject, memberCount, addedByPhone, addedByLid, addedAt: now },
  });
  console.log(`[group-add] ${groupId} ("${subject ?? "?"}"): unsolicited, recorded; silent, left after 48 hours`);
  return { kind: "unsolicited", recorded: true, id: row.id };
}

/** Members of this group who already play in an approved club, per club. */
async function loadAlsoIn(
  snapshot: ReturnType<typeof parseParticipantSnapshot>,
): Promise<Array<{ orgName: string; count: number }>> {
  const phones = [...new Set(snapshot.map((p) => snapshotPhone(p)).filter((p): p is string => !!p))];
  if (phones.length === 0) return [];
  const rows = await db.membership.findMany({
    where: { user: { phoneNumber: { in: phones } }, leftAt: null, org: APPROVED_CLUB_WHERE },
    select: { userId: true, org: { select: { name: true } } },
  });
  const byOrg = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byOrg.get(r.org.name) ?? new Set<string>();
    set.add(r.userId);
    byOrg.set(r.org.name, set);
  }
  return [...byOrg.entries()]
    .map(([orgName, users]) => ({ orgName, count: users.size }))
    .sort((a, b) => b.count - a.count || a.orgName.localeCompare(b.orgName));
}

/** The organiser's "I'm in" DM, once per refId: one for the link, and one
 *  for each relink after a re-add. True when queued. */
async function queueOrganiserAck(refId: string, phone: string, text: string): Promise<boolean> {
  const already = await db.platformJob.findFirst({ where: { purpose: "connect-reply", refId }, select: { id: true } });
  if (already) return false;
  try {
    await queuePlatformDm({ phone, text, purpose: "connect-reply", refId });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[group-add] organiser ack ${refId} not queued: ${err.reason}`);
      return false;
    }
    throw err;
  }
}

// ── Removed from the group (plan 5.7) ───────────────────────────────────

/**
 * MatchTime was removed from a group it was silent in. A club waiting
 * for approval goes back to draft (its card offers the button again);
 * an unsolicited group is marked left. No DMs, to anyone. An approved
 * club is never read here, let alone written.
 */
export async function handleBotRemoved(
  groupId: string,
  now: Date = new Date(),
): Promise<{ returnedToDraft: number; unsolicitedLeft: number }> {
  const links = await db.clubConnect.findMany({ where: LINKED_AND_WAITING(groupId), select: { id: true, orgId: true } });
  let returnedToDraft = 0;
  for (const l of links) {
    const moved = await db.$transaction(async (tx) => {
      const { count } = await tx.clubConnect.updateMany({
        where: { id: l.id, botRemovedAt: null },
        data: { botRemovedAt: now },
      });
      // F3: the chat goes with the link, and the group description with
      // it; a re-add brings them again.
      await clearCapturedChat(tx, l.id);
      return count === 1 && (await returnPendingClubToDraft(l.orgId, tx));
    });
    if (moved) returnedToDraft++;
  }
  const { count: unsolicitedLeft } = await db.unsolicitedGroup.updateMany({
    where: { groupId, leftAt: null },
    data: { leftAt: now },
  });
  console.log(`[group-add] removed from ${groupId}: ${returnedToDraft} club(s) back to draft, ${unsolicitedLeft} unsolicited row(s) left`);
  return { returnedToDraft, unsolicitedLeft };
}

// ── The 48-hour auto-leave (decision 3) ─────────────────────────────────

/**
 * Queue a leave for every unsolicited group MatchTime has been in for 48
 * hours. At most one leave per stay: a leave already sent marks the row
 * left; one queued, claimed or failed is not repeated (a failed leave is
 * for the owner page's Leave button, not a retry loop).
 *
 * ONE EXCEPTION (2026-10-12): a candidate ADMIN group (`awaitingAdminLink`)
 * is not left while a club its adder runs still has an open admin group
 * code (`adderHasOpenAdminGroupCode`). The setup DM's code lasts 7 days;
 * MatchTime must still be in the group when the organiser forwards the
 * command on day three. It is left 48 hours after the add or when the
 * last such code expires, whichever is later. Every other row, and a
 * candidate with no such code, is left at 48 hours exactly as before.
 */
export async function queueUnsolicitedAutoLeaves(now: Date = new Date()): Promise<{ queued: number; markedLeft: number }> {
  const due = await db.unsolicitedGroup.findMany({
    where: { leftAt: null, addedAt: { lte: new Date(now.getTime() - UNSOLICITED_AUTO_LEAVE_MS) } },
    orderBy: { addedAt: "asc" },
    take: 20,
    select: { id: true, groupId: true, addedAt: true, awaitingAdminLink: true, addedByPhone: true, addedByLid: true },
  });
  let queued = 0;
  let markedLeft = 0;
  for (const row of due) {
    // The one exception: a candidate admin group whose code is still open.
    if (row.awaitingAdminLink && (await adderHasOpenAdminGroupCode({ addedByPhone: row.addedByPhone, addedByLid: row.addedByLid, now }))) {
      continue;
    }
    const job = await db.platformJob.findFirst({
      where: { kind: "leave-group", groupId: row.groupId, createdAt: { gte: row.addedAt } },
      orderBy: { createdAt: "desc" },
      select: { status: true, sentAt: true },
    });
    if (job?.status === "sent") {
      await db.unsolicitedGroup.updateMany({ where: { id: row.id, leftAt: null }, data: { leftAt: job.sentAt ?? now } });
      markedLeft++;
      continue;
    }
    if (job) continue;
    const r = await queuePlatformLeaveGroup({ groupId: row.groupId, refId: row.id });
    if ("refused" in r) {
      console.warn(`[group-add] not leaving ${row.groupId} (unsolicited ${row.id}): ${r.refused}`);
      continue;
    }
    console.log(`[group-add] leaving unsolicited group ${row.groupId} (added ${row.addedAt.toISOString()})`);
    queued++;
  }
  return { queued, markedLeft };
}

// ── The reconnect sweep (plan 8) ────────────────────────────────────────

/**
 * Should the Pi look for groups it was added to while it was offline? Only
 * while some organiser's DM-verified request is waiting for its add (a
 * discovered group carries no adder, so only those can match). Returns
 * every group the server already knows, so the Pi reads none of them:
 * every club's group whatever its status (Sutton FC, muted or not), every
 * linked request's group, every unsolicited group not yet left.
 */
export async function loadSelfJoinSweep(now: Date = new Date()): Promise<{ knownGroups: string[] } | null> {
  const open = await db.clubConnect.count({
    where: { status: "dm_verified", addWindowEndsAt: { gt: now }, org: DRAFT_CLUB_WHERE },
  });
  if (open === 0) return null;
  const [orgs, connects, unsolicited] = await Promise.all([
    db.organisation.findMany({
      where: { OR: [{ whatsappGroupId: { not: null } }, { adminGroupId: { not: null } }] },
      select: { whatsappGroupId: true, adminGroupId: true },
    }),
    db.clubConnect.findMany({ where: { groupId: { not: null }, botRemovedAt: null }, select: { groupId: true } }),
    db.unsolicitedGroup.findMany({ where: { leftAt: null }, select: { groupId: true } }),
  ]);
  const known = new Set<string>();
  for (const g of [
    ...orgs.map((o) => o.whatsappGroupId),
    // Slice 2a: a linked admin group is known too.
    ...orgs.map((o) => (o as { adminGroupId?: string | null }).adminGroupId ?? null),
    ...connects.map((c) => c.groupId),
    ...unsolicited.map((u) => u.groupId),
  ]) {
    if (typeof g === "string" && g) known.add(g);
  }
  return { knownGroups: [...known] };
}

/**
 * The organiser's ack after a matched group add. With SETUP_HOLD_ENABLED
 * on (go-live slice S3) an approved club stays silent until its organiser
 * says GO, so "I'll message you here when it's live" would be false: the
 * held variant says "after it's approved" (no promise of how soon: the
 * setup message waits for the chat reading and for the daytime). Off,
 * today's text exactly.
 */
export function inGroupAckText(
  lang: string | null | undefined,
  group: string | null,
  held: boolean = isSetupHoldEnabled(),
): string {
  const s = t(lang);
  return (held ? s.sj_dm_in_group_held : s.sj_dm_in_group)({ group });
}
