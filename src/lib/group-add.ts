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
  decideRelinkAfterReAdd,
  ownerApprovalDmText,
  relinkRefIds,
  type AddEvidence,
  type AdderMatch,
} from "./group-add-rules";
import { PlatformDmRefused, queuePlatformDm, queuePlatformLeaveGroup } from "./platform-jobs";
import { detectAdminGroupCandidate, recordAdminGroupCandidate } from "./admin-group-link";
import { CAPTURED_HISTORY_RETENTION_MS } from "./captured-history-retention";
import { isSetupHoldEnabled } from "./club-setup-rules";
import { capturedAtLink, clearCapturedChat, fillCapturedChatOnReAdd } from "./captured-chat";
import { ingestGroupDescription } from "./group-description";

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
    if (relink) {
      const out = await linkGroupToRequest(ctx, relink);
      if (out !== RELINK_ABANDONED) return out;
    }
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
  const out = await linkGroupToRequest(
    { groupId, subject, snapshot, ev, history: input.enrichmentHistory, description, now },
    {
      row,
      // Compare-and-set on the status the request had when it was matched.
      expect: { id: row.id, status: row.status },
      adderMatch: decision.adderMatch,
      organiserPresent: decision.organiserPresent,
      ownerDmRefId: row.id,
      organiserAckRefId: `${row.id}:in-group`,
      relink: null,
    },
  );
  // Only a relink can be abandoned; a first link never is.
  return out === RELINK_ABANDONED ? { kind: "race-lost" } : out;
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
  const detected = detectGroupLang({ subject, history: history.map((m) => m.text) });

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
          detectedLang: detected.lang,
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
      detectedLang: detected,
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
      `looks ${detected.lang}` +
      `${detected.confident ? "" : " (unsure)"}, organiser ack ${organiserAckQueued ? "queued" : "not sent"}`,
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

/**
 * The organiser's ack after a matched group add. With SETUP_HOLD_ENABLED
 * on (go-live slice S3) an approved club stays silent until its organiser
 * says GO, so "I'll message you here when it's live" would be false: the
 * held variant says "as soon as it's approved". Off, today's text exactly.
 */
export function inGroupAckText(
  lang: string | null | undefined,
  group: string | null,
  held: boolean = isSetupHoldEnabled(),
): string {
  const s = t(lang);
  return (held ? s.sj_dm_in_group_held : s.sj_dm_in_group)({ group });
}
