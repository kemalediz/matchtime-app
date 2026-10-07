/**
 * SELF-JOIN, SLICE 6: GROUP ADD LINKING (2026-09-29).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 2.3, 4.1,
 * 5.5, 5.6, 5.7, 6.1 and 8. The pure rules are in group-add-rules.ts.
 *
 * Called by POST /api/whatsapp/bot-added (while SELF_JOIN_ENABLED is on),
 * POST /api/whatsapp/bot-removed, GET /api/whatsapp/platform-jobs (the
 * 48-hour auto-leave) and GET /api/whatsapp/orgs (the reconnect sweep).
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
import { detectGroupLang } from "./i18n/detect";
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
  addEvidenceFrom,
  decideGroupAddLink,
  ownerApprovalDmText,
  type AdderMatch,
} from "./group-add-rules";
import { PlatformDmRefused, queuePlatformDm, queuePlatformLeaveGroup } from "./platform-jobs";
import { detectAdminGroupCandidate, recordAdminGroupCandidate } from "./admin-group-link";
import { CAPTURED_HISTORY_RETENTION_MS } from "./captured-history-retention";

export interface GroupAddInput {
  groupId: string;
  groupSubject?: unknown;
  addedByPhone?: unknown;
  addedByLid?: unknown;
  participants?: unknown;
  enrichmentHistory?: unknown;
  discovered?: unknown;
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
    }
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
  | { kind: "admin-group-candidate"; id: string };

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
    if (late.length > 0 && !pastRetention) {
      await db.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = ${JSON.stringify(late)}::jsonb
        WHERE "id" = ${existing.id} AND "capturedHistory" IS NULL`;
    }
    return { kind: "already-linked", connectId: existing.id };
  }

  // 3. Which request, if any (plan 2.3).
  const ev = addEvidenceFrom(input);
  const candidates = await db.clubConnect.findMany({
    where: { status: { in: ["issued", "dm_verified"] }, org: DRAFT_CLUB_WHERE },
    select: {
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
    },
  });
  const decision = decideGroupAddLink(ev, candidates, now);
  const snapshot = parseParticipantSnapshot(input.participants);

  if (!decision.link) {
    console.log(
      `[group-add] ${groupId}: no request matches (${decision.reason}; adder phone=${ev.addedByPhone ?? "-"} ` +
        `lid=${ev.addedByLid ?? "-"}, ${snapshot.length} member(s)${ev.discovered ? ", discovered" : ""})`,
    );
    // A group the reconnect sweep found may be one MatchTime was in long
    // before self-join. It is never recorded, so it is never auto-left.
    if (ev.discovered) return { kind: "discovered-no-match" };
    // Slice 2a (plan 2.4): after every connect-request match has failed,
    // an add by an owner or admin of an approved club is their admins' HQ
    // group, waiting for "@Match Time admin group CODE". Still silent, and
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
  const history = coerceHistoryMessages(input.enrichmentHistory);
  const detected = detectGroupLang({ subject, history: history.map((m) => m.text) });

  // 4. Link, and set the club pending, together or not at all.
  let result: "linked" | "race-lost" | { already: string };
  try {
    result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-add:${groupId}`}))`;
      const again = await tx.clubConnect.findFirst({ where: LINKED_AND_WAITING(groupId), select: { id: true } });
      if (again) return { already: again.id };
      const { count } = await tx.clubConnect.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: "group_linked",
          groupId,
          groupSubject: subject,
          memberCount: snapshot.length,
          addedByPhone: ev.addedByPhone,
          addedByLid: ev.addedByLid,
          adderMatch: decision.adderMatch,
          participants: snapshot.length > 0 ? (snapshot.map((p) => ({ ...p })) as unknown as object) : undefined,
          detectedLang: detected.lang,
          // F3: the chat, kept until the learned setup has read it once
          // after approval (or the club is rejected). See setup-learning/.
          capturedHistory: history.length > 0 ? (history as unknown as object) : undefined,
          linkedAt: now,
          botRemovedAt: null,
        },
      });
      if (count !== 1) return "race-lost" as const;
      // Throwing rolls the link back: a request must never say
      // group_linked while its club is not pending.
      if (!(await markClubPendingOnLink(row.orgId, tx))) throw new LinkAborted();
      return "linked" as const;
    });
  } catch (err) {
    if (err instanceof LinkAborted) result = "race-lost";
    else throw err;
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
    refId: row.id,
    text: ownerApprovalDmText({
      club: org?.name ?? "(unnamed club)",
      code: row.code,
      organiserName: organiser?.name ?? null,
      organiserPhone: row.phone,
      adderMatch: decision.adderMatch,
      organiserPresent: decision.organiserPresent,
      numberUnconfirmed: row.dmAt !== null && row.dmPhone === null,
      groupSubject: subject,
      memberCount: snapshot.length,
      detectedLang: detected,
      clubLang: org?.language ?? null,
      alsoIn,
    }),
  };

  let organiserAckQueued = false;
  if (decision.adderMatch === "phone" || decision.adderMatch === "lid") {
    organiserAckQueued = await queueOrganiserAck(row.id, row.phone, t(org?.language).sj_dm_in_group({ group: subject }));
  }

  console.log(
    `[group-add] ${groupId} ("${subject ?? "?"}") linked to ${row.id} (club ${row.orgId}, now pending): ` +
      `adder=${decision.adderMatch}, ${snapshot.length} member(s), looks ${detected.lang}` +
      `${detected.confident ? "" : " (unsure)"}, organiser ack ${organiserAckQueued ? "queued" : "not sent"}`,
  );
  return {
    kind: "linked",
    connectId: row.id,
    orgId: row.orgId,
    adderMatch: decision.adderMatch,
    ownerDm,
    organiserAckQueued,
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

/** The organiser's "I'm in" DM, once per request. True when queued. */
async function queueOrganiserAck(connectId: string, phone: string, text: string): Promise<boolean> {
  const refId = `${connectId}:in-group`;
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
      // F3: the chat goes with the link; a re-add brings it again.
      await tx.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "id" = ${l.id}`;
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
 */
export async function queueUnsolicitedAutoLeaves(now: Date = new Date()): Promise<{ queued: number; markedLeft: number }> {
  const due = await db.unsolicitedGroup.findMany({
    where: { leftAt: null, addedAt: { lte: new Date(now.getTime() - UNSOLICITED_AUTO_LEAVE_MS) } },
    orderBy: { addedAt: "asc" },
    take: 20,
    select: { id: true, groupId: true, addedAt: true },
  });
  let queued = 0;
  let markedLeft = 0;
  for (const row of due) {
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
