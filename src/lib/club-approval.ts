/**
 * CLUB APPROVAL: the one place that decides whether a club may act
 * (2026-09-29). Plan: MDs/self-join-and-approval-plan-2026-09-28.md.
 *
 * Slice 1 ("schema and silence rails") builds the rails, not the flow:
 *
 *   - `Organisation.approvalStatus` ("draft" | "pending" | "approved" |
 *     "rejected" | "suspended"), DEFAULT "approved", so every club that
 *     existed before self-join (Sutton FC included) is approved and
 *     nothing changes for it.
 *   - A CHECK constraint: `whatsappBotEnabled` can only be true on an
 *     approved club. Every route that acts for a group already requires
 *     the bot to be on, so they are blind to unapproved groups for free.
 *   - `silentGroups`: the WhatsApp groups MatchTime is in but must never
 *     speak in or forward (an unapproved club's group, the group a
 *     pending connect request named, a group somebody added MatchTime to
 *     with no code). The Pi reads them from `/api/whatsapp/orgs`; the
 *     analyze onboarding gate and `bot-added` refuse them server side.
 *   - `isClubOperational`: approved and not dormant. Crons skip anything
 *     else, through `APPROVED_CLUB_WHERE` at the query.
 *
 * ONE WRITER. Nothing outside this module (and its pure half,
 * club-approval-state.ts) may use `approvalStatus` as an object key
 * except `approvalStatus: true` in a select or a type annotation
 * (`__tests__/club-approval-source-guard.test.ts`). Slice 7 adds the
 * owner's decision here: `decideClub` (approve, reject, suspend), used by
 * the owner's WhatsApp reply (`handleApproverDm`) and /admin/clubs alike.
 *
 * NOT the mute switch (`whatsappBotEnabled`) and NOT dormancy
 * (`dormantAt`). Both keep their meanings (see org-lifecycle.ts).
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { appUrl, buildAdminLink } from "./admin-link";
import { e164Digits } from "./phone";
import { parseParticipantSnapshot } from "./participant-snapshot";
import { parseApproverPhones, queueOwnerDm } from "./owner-dm";
import { PlatformDmRefused, queuePlatformDm, queuePlatformLeaveGroup } from "./platform-jobs";
import { loadClubFeeTip, setBillingState } from "./club-billing";
import { approvedTipText } from "./club-billing-view";
import {
  isApproverSender,
  ownerAckText,
  parseApproverCommand,
  resolveApproverTarget,
  suspendRefusal,
  type DecidedClub,
  type OwnerAck,
  type WaitingClub,
} from "./club-decision-rules";

export {
  APPROVAL_STATUSES,
  APPROVED_CLUB_WHERE,
  DRAFT_CLUB_WHERE,
  PENDING_CLUB_WHERE,
  REJECTED_CLUB_WHERE,
  SUSPENDED_CLUB_WHERE,
  UNAPPROVED_CLUB_WHERE,
  SELF_JOIN_CLUB_WHERE,
  SERVING_CLUB_WHERE,
  servingClubWhere,
  isClubApproved,
  isClubOperational,
  type ApprovalStatus,
} from "./club-approval-state";
import {
  APPROVED_CLUB_WHERE,
  PENDING_CLUB_WHERE,
  UNAPPROVED_CLUB_WHERE,
  servingClubWhere,
} from "./club-approval-state";
import { billingQuietWhere, isBillingEnabled } from "./club-billing-rules";

// ── Flags ───────────────────────────────────────────────────────────────

/**
 * `SELF_JOIN_ENABLED`: OFF unless explicitly "1"/"true"/"on"/"yes".
 * Slice 1 uses it for one thing: with self-join on, the in-group
 * self-setup is retired (decision 4). No trigger starts a session, no
 * session continues, and the Pi is told to ignore "@MatchTime setup".
 */
export function isSelfJoinEnabled(value: string | undefined = process.env.SELF_JOIN_ENABLED): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}

/** The legacy "@MatchTime setup" trigger: on exactly while self-join is off. */
export function isLegacySetupTriggerEnabled(
  value: string | undefined = process.env.SELF_JOIN_ENABLED,
): boolean {
  return !isSelfJoinEnabled(value);
}

// ── The draft state (slice 4) ─────────────────────────────────────────

/**
 * The fields a club created on the website through self-join starts
 * with: DRAFT. It stays silent (the bot is off, and the CHECK constraint
 * forbids turning it on) until the organiser connects a group and the
 * platform owner approves it. The one place a club is BORN unapproved;
 * spread into `organisation.create` by src/lib/self-join-club.ts.
 */
export function draftClubFields(): { approvalStatus: "draft" } {
  return { approvalStatus: "draft" };
}

// ── The group add (slice 6) ─────────────────────────────────────────

/** The one method both writers need, so a transaction client or `db`
 *  itself can be passed. */
type OrgWriter = {
  organisation: { updateMany(args: { where: object; data: object }): Promise<{ count: number }> };
};

/**
 * draft -> pending: MatchTime was added to a group and the add was linked
 * to this club's connect request (plan 4.1). Compare-and-set on "draft",
 * so it can never move an approved club (Sutton FC), a rejected one or a
 * suspended one. The bot stays OFF: `whatsappBotEnabled` is not touched
 * here, and the CHECK constraint forbids it on a pending club anyway.
 * `whatsappGroupId` is not set either; that happens at approval (3.1).
 * True when this call moved the club.
 */
export async function markClubPendingOnLink(orgId: string, client: OrgWriter = db): Promise<boolean> {
  const { count } = await client.organisation.updateMany({
    where: { id: orgId, approvalStatus: "draft" },
    data: { approvalStatus: "pending" },
  });
  return count === 1;
}

/**
 * pending -> draft: MatchTime was removed from the group before the
 * owner decided (plan 4.1, 5.7). Compare-and-set on "pending": an
 * approved club removing MatchTime is today's business (a mute, a
 * churn), never this.
 */
export async function returnPendingClubToDraft(orgId: string, client: OrgWriter = db): Promise<boolean> {
  const { count } = await client.organisation.updateMany({
    where: { id: orgId, approvalStatus: "pending" },
    data: { approvalStatus: "draft" },
  });
  return count === 1;
}

// ── Silent groups ───────────────────────────────────────────────────────

export interface SilentGroupSources {
  /** `whatsappGroupId` of clubs that are not approved (suspended, rejected). */
  unapprovedOrgGroups: Array<string | null>;
  /** `ClubConnect.groupId` whose club is not approved (pending, rejected, draft again). */
  unapprovedConnectGroups: Array<string | null>;
  /** `UnsolicitedGroup.groupId` not yet left. */
  unsolicitedGroups: Array<string | null>;
  /** `whatsappGroupId` of APPROVED clubs, muted or not. Never silent. */
  approvedOrgGroups: Array<string | null>;
  /** Slice 2a: every club's linked admin group. Never silent: the Pi
   *  forwards its messages to the admin-group route (never to analyze).
   *  Absent means none. */
  adminGroups?: Array<string | null>;
  /** Club fee billing (B1): the `whatsappGroupId` AND `adminGroupId` of
   *  approved clubs that are billing-paused. Silent (the caller leaves a
   *  paused club's admin group out of `adminGroups`). Only ever filled
   *  while BILLING_ENABLED is on; absent means none. */
  pausedOrgGroups?: Array<string | null>;
}

/**
 * The groups MatchTime must stay silent in. An approved club's group is
 * never silent, whatever stale row names it: the failure this protects
 * against is a leftover connect or unsolicited row silencing Sutton FC.
 */
export function computeSilentGroups(src: SilentGroupSources): string[] {
  const ok = (g: string | null): g is string => typeof g === "string" && g.length > 0;
  const approved = new Set([...src.approvedOrgGroups, ...(src.adminGroups ?? [])].filter(ok));
  const silent = new Set<string>();
  for (const g of [
    ...src.unapprovedOrgGroups,
    ...src.unapprovedConnectGroups,
    ...src.unsolicitedGroups,
    ...(src.pausedOrgGroups ?? []),
  ]) {
    if (ok(g) && !approved.has(g)) silent.add(g);
  }
  return [...silent];
}

/**
 * Read the sources and compute the silent set. Five small queries, plus a
 * sixth (the billing-paused clubs) only while BILLING_ENABLED is on.
 *
 * "approved, never silent" is the SERVING clubs: with the flag on, a
 * billing-paused club's group is not protected by that rule, and is
 * listed silent, so the Pi drops its messages (plan 4.3 point 3). With
 * the flag off the queries are exactly today's.
 */
export async function loadSilentGroupIds(): Promise<string[]> {
  const billing = isBillingEnabled();
  const [approvedOrgs, unapprovedOrgs, connects, unsolicited, adminGroups, pausedOrgs] = await Promise.all([
    db.organisation.findMany({
      where: { ...servingClubWhere(), whatsappGroupId: { not: null } },
      select: { whatsappGroupId: true },
    }),
    db.organisation.findMany({
      where: { ...UNAPPROVED_CLUB_WHERE, whatsappGroupId: { not: null } },
      select: { whatsappGroupId: true },
    }),
    db.clubConnect.findMany({
      where: { groupId: { not: null }, org: UNAPPROVED_CLUB_WHERE },
      select: { groupId: true },
    }),
    db.unsolicitedGroup.findMany({
      where: { leftAt: null },
      select: { groupId: true },
    }),
    // Admin groups are never silent, except (flag on) a billing-paused
    // club's, which is listed silent below. `billingQuietWhere()` is empty
    // while the flag is off, so this query is today's.
    db.organisation.findMany({
      where: { adminGroupId: { not: null }, ...billingQuietWhere() },
      select: { adminGroupId: true },
    }),
    billing
      ? db.organisation.findMany({
          where: { ...APPROVED_CLUB_WHERE, billingStatus: "paused" },
          select: { whatsappGroupId: true, adminGroupId: true },
        })
      : Promise.resolve([] as Array<{ whatsappGroupId: string | null; adminGroupId: string | null }>),
  ]);
  return computeSilentGroups({
    approvedOrgGroups: approvedOrgs.map((o) => o.whatsappGroupId),
    unapprovedOrgGroups: unapprovedOrgs.map((o) => o.whatsappGroupId),
    unapprovedConnectGroups: connects.map((c) => c.groupId),
    unsolicitedGroups: unsolicited.map((u) => u.groupId),
    adminGroups: (adminGroups ?? []).map((o) => o.adminGroupId),
    ...(billing
      ? { pausedOrgGroups: (pausedOrgs ?? []).flatMap((o) => [o.whatsappGroupId, o.adminGroupId]) }
      : {}),
  });
}

/** Is this one group silent? */
export async function isSilentGroup(groupId: string): Promise<boolean> {
  return (await loadSilentGroupIds()).includes(groupId);
}

/**
 * May the legacy in-group setup (OnboardingSession, which calls a model)
 * run for this group? null = yes. Otherwise the reason it may not:
 *   "self-join-mode"  self-join is on, which retires it (decision 4);
 *   "silent-group"    the group is silent.
 * Called by the analyze route's onboarding gate and by `bot-added`, in
 * both cases AFTER their live-club check, so a live club is never
 * affected.
 */
export async function inGroupSetupRefusal(groupId: string): Promise<"self-join-mode" | "silent-group" | null> {
  if (isSelfJoinEnabled()) return "self-join-mode";
  if (await isSilentGroup(groupId)) return "silent-group";
  return null;
}

/**
 * Does this DM sender belong ONLY to clubs that are not approved? True
 * means the DM must go nowhere near the model paths (`dm-intent`,
 * `dm-qa`, ...): an organiser chatting to MatchTime before approval
 * costs nothing (plan section 4.3, layer 6). A sender with no clubs at
 * all is NOT caught: that is today's handling, unchanged.
 */
export async function onlyUnapprovedClubs(orgIds: string[]): Promise<boolean> {
  if (orgIds.length === 0) return false;
  const approved = await db.organisation.count({ where: { id: { in: orgIds }, ...APPROVED_CLUB_WHERE } });
  return approved === 0;
}

/**
 * The dm-reply rail (club fee billing B1, plan 4.3 point 7): does this DM
 * sender belong ONLY to clubs MatchTime is not serving? null = no (carry
 * on). Otherwise why: "club-not-approved" (every club unapproved, today's
 * rail, today's reason) or "club-billing-paused" (approved, but every
 * approved one is paused). Either way the DM goes nowhere near a model.
 *
 * With BILLING_ENABLED off this is exactly `onlyUnapprovedClubs`: the
 * same single query, the same answer.
 */
export async function nonServingClubsReason(
  orgIds: string[],
): Promise<"club-not-approved" | "club-billing-paused" | null> {
  if (await onlyUnapprovedClubs(orgIds)) return "club-not-approved";
  if (orgIds.length === 0 || !isBillingEnabled()) return null;
  const serving = await db.organisation.count({ where: { id: { in: orgIds }, ...servingClubWhere() } });
  return serving === 0 ? "club-billing-paused" : null;
}

// ── The decision (slice 7) ──────────────────────────────────────────────

export type ClubDecision = "approve" | "reject" | "suspend";

export type DecideClubResult =
  | {
      ok: true;
      decision: ClubDecision;
      orgId: string;
      club: string;
      /** The connect request's code (the ref in the owner's DM), when there was one. */
      code: string | null;
      groupId: string | null;
      groupSubject: string | null;
    }
  | { ok: false; reason: "not-found" }
  | {
      ok: false;
      reason: "not-pending" | "not-approved";
      club: string;
      status: string;
      decidedAt: Date | null;
    }
  | { ok: false; reason: "not-self-join" | "confirm-mismatch" | "no-linked-group"; club: string }
  | { ok: false; reason: "group-taken"; club: string; takenBy: string };

class DecisionRaceLost extends Error {}

/**
 * The organiser's links in the "approved" DM (2026-10-01): the weekly
 * game, the seed editor and Settings. Each one signs the organiser in to
 * this club (`buildAdminLink`); the DM goes to the organiser's own phone.
 * A link that cannot be minted falls back to the page's plain address, so
 * the DM always goes.
 */
async function organiserLinks(userId: string, orgId: string) {
  const link = async (nextPath: string): Promise<string> => {
    try {
      return await buildAdminLink({ userId, orgId, nextPath });
    } catch (err) {
      console.error(`[club-approval] ${orgId}: signed-in link to ${nextPath} failed; sending the plain address:`, err);
      return appUrl(nextPath);
    }
  };
  return {
    scheduleUrl: await link("/admin/activities"),
    ratingsUrl: await link("/admin/players/ratings"),
    settingsUrl: await link("/admin/settings"),
  };
}

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * THE ONE WRITER OF A DECISION. Approve, reject or suspend a club, from
 * the owner's WhatsApp reply or from /admin/clubs. Every move is a
 * compare-and-set inside one transaction, so a DM and a button press at
 * the same moment cannot both act: the loser is told the club was already
 * decided, and queues nothing.
 *
 *   approve  pending -> approved. Refused when another approved club owns
 *            the group. Sets `whatsappGroupId` (from the connect request;
 *            it is never set while pending, plan 3.1), `approvedAt` (the
 *            start of the club's free month, see ai-budget.ts
 *            `aiWindowStart`), and turns the bot ON (the CHECK constraint
 *            allows it now). Queues the hello as the club's first group
 *            BotJob; the Pi picks the group up on its next org refresh.
 *            Then imports the roster from the add's snapshot and DMs the
 *            organiser.
 *   reject   pending -> rejected. The bot stays off. MatchTime leaves the
 *            group without a word in it, and the organiser gets one polite
 *            DM (decision 1).
 *   suspend  approved -> suspended, the owner page's off switch. ONLY a
 *            club that came in through self-join (`approvedAt` set) and
 *            only with its name typed: Sutton FC (approved by the column
 *            default, `approvedAt` NULL) can never be turned off or left
 *            from here. The bot goes off in the same write, then MatchTime
 *            leaves the group. Nobody is messaged.
 *
 * `decidedBy` is "whatsapp:<phone>" or a user id. No model, anywhere.
 */
export async function decideClub(
  orgId: string,
  decision: ClubDecision,
  decidedBy: string,
  opts: { now?: Date; confirmName?: string | null } = {},
): Promise<DecideClubResult> {
  const now = opts.now ?? new Date();

  type Done = {
    result: DecideClubResult;
    after?: {
      language: string | null;
      link: {
        id: string;
        /** The organiser: their "approved" DM carries links that sign them in. */
        userId: string;
        phone: string;
        groupId: string | null;
        groupSubject: string | null;
        participants: unknown;
      } | null;
      leaveGroupId: string | null;
    };
  };

  let done: Done;
  try {
    done = await db.$transaction(async (tx): Promise<Done> => {
      const org = await tx.organisation.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          name: true,
          language: true,
          approvalStatus: true,
          approvedAt: true,
          approvalDecidedAt: true,
          whatsappGroupId: true,
        },
      });
      if (!org) return { result: { ok: false, reason: "not-found" } };
      const refusedAs = (reason: "not-pending" | "not-approved"): Done => ({
        result: { ok: false, reason, club: org.name, status: org.approvalStatus, decidedAt: org.approvalDecidedAt },
      });
      const decided = { approvalDecidedAt: now, approvalDecidedBy: decidedBy };

      if (decision === "suspend") {
        const refusal = suspendRefusal(org, opts.confirmName);
        if (refusal === "not-approved") return refusedAs("not-approved");
        if (refusal) return { result: { ok: false, reason: refusal, club: org.name } };
        const { count } = await tx.organisation.updateMany({
          where: { id: orgId, approvalStatus: "approved", approvedAt: { not: null } },
          data: { approvalStatus: "suspended", whatsappBotEnabled: false, ...decided },
        });
        if (count !== 1) throw new DecisionRaceLost();
        return {
          result: {
            ok: true,
            decision,
            orgId,
            club: org.name,
            code: null,
            groupId: org.whatsappGroupId,
            groupSubject: null,
          },
          after: { language: org.language, link: null, leaveGroupId: org.whatsappGroupId },
        };
      }

      if (org.approvalStatus !== "pending") return refusedAs("not-pending");
      const link = await tx.clubConnect.findFirst({
        where: { orgId, status: "group_linked", botRemovedAt: null, groupId: { not: null } },
        orderBy: { linkedAt: "desc" },
        select: {
          id: true,
          userId: true,
          code: true,
          phone: true,
          groupId: true,
          groupSubject: true,
          participants: true,
        },
      });

      if (decision === "reject") {
        const { count } = await tx.organisation.updateMany({
          where: { id: orgId, approvalStatus: "pending" },
          data: { approvalStatus: "rejected", ...decided },
        });
        if (count !== 1) throw new DecisionRaceLost();
        if (link) {
          await tx.clubConnect.updateMany({ where: { id: link.id, status: "group_linked" }, data: { status: "closed" } });
        }
        return {
          result: {
            ok: true,
            decision,
            orgId,
            club: org.name,
            code: link?.code ?? null,
            groupId: link?.groupId ?? null,
            groupSubject: link?.groupSubject ?? null,
          },
          after: { language: org.language, link, leaveGroupId: link?.groupId ?? null },
        };
      }

      // approve
      if (!link || !link.groupId) return { result: { ok: false, reason: "no-linked-group", club: org.name } };
      const groupId = link.groupId;
      // The same lock the group add takes, so two clubs can never both end
      // up owning one group.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-add:${groupId}`}))`;
      const taken = await tx.organisation.findFirst({
        where: { ...APPROVED_CLUB_WHERE, whatsappGroupId: groupId, id: { not: orgId } },
        select: { id: true, name: true },
      });
      if (taken) return { result: { ok: false, reason: "group-taken", club: org.name, takenBy: taken.name } };

      const { count } = await tx.organisation.updateMany({
        where: { id: orgId, approvalStatus: "pending" },
        data: {
          approvalStatus: "approved",
          approvedAt: now,
          whatsappBotEnabled: true,
          whatsappGroupId: groupId,
          ...decided,
        },
      });
      if (count !== 1) throw new DecisionRaceLost();
      await tx.clubConnect.updateMany({ where: { id: link.id, status: "group_linked" }, data: { status: "closed" } });

      // The hello: the first thing MatchTime ever says in this group. A
      // plain group BotJob, so it goes out through due-posts with every
      // guard every other post has.
      const organiser = await tx.user.findUnique({ where: { id: link.userId }, select: { name: true } });
      await tx.botJob.create({
        data: { orgId, kind: "group", text: t(org.language).sj_group_hello({ organiser: firstName(organiser?.name) }) },
      });
      return {
        result: {
          ok: true,
          decision,
          orgId,
          club: org.name,
          code: link.code,
          groupId,
          groupSubject: link.groupSubject,
        },
        after: { language: org.language, link, leaveGroupId: null },
      };
    });
  } catch (err) {
    if (!(err instanceof DecisionRaceLost)) throw err;
    // Somebody else decided between our read and our write. Report what
    // they decided, from a fresh read.
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: { name: true, approvalStatus: true, approvalDecidedAt: true },
    });
    if (!org) return { ok: false, reason: "not-found" };
    return {
      ok: false,
      reason: decision === "suspend" ? "not-approved" : "not-pending",
      club: org.name,
      status: org.approvalStatus,
      decidedAt: org.approvalDecidedAt,
    };
  }

  const { result, after } = done;
  if (!result.ok || !after) return result;
  console.log(
    `[club-approval] ${result.decision} ${orgId} ("${result.club}") by ${decidedBy}` +
      `${result.groupId ? `, group ${result.groupId}` : ""}`,
  );

  // Everything below happens after the decision is committed. A failure
  // here is logged and never undoes the decision.
  const s = t(after.language);

  // Club fee billing (slice B2): with BILLING_ENABLED on, the club's free
  // month starts at its approval, through the one writer (it reads
  // `approvedAt`, just committed). A failure leaves the club "exempt",
  // which bills nobody, and is logged; the approval stands. A club whose
  // free month did start gets the club fee tip in its "you're live" DM.
  let feeTip: string | null = null;
  if (result.decision === "approve" && isBillingEnabled()) {
    try {
      const started = await setBillingState(orgId, { type: "approved" }, now);
      if (started.ok && started.to === "trial") {
        const tip = await loadClubFeeTip(orgId);
        if (tip) feeTip = approvedTipText(after.language, tip);
      }
    } catch (err) {
      console.error(`[club-approval] ${orgId}: the free month did NOT start (the club stays exempt):`, err);
    }
  }

  // Club fee billing (plan 4.2, decision 7; PR #181 review fix 11): the
  // owner's off switch cancels a billed club's live subscription at once,
  // no proration and no automatic refund. Stripe being down never undoes
  // the suspension: it is logged and recorded on /admin/health.
  if (result.decision === "suspend") {
    try {
      const { cancelSubscriptionOnSuspend } = await import("./club-billing-stripe");
      const r = await cancelSubscriptionOnSuspend(orgId);
      if (r.action !== "no-subscription") console.log(`[club-approval] ${orgId}: club fee subscription on suspend: ${r.action}`);
    } catch (err) {
      console.error(`[club-approval] ${orgId}: suspended, but its club fee subscription was NOT cancelled:`, err);
      const { BILLING_ALERT_KIND, recordOpsEvent } = await import("./ops-alerts");
      await recordOpsEvent({
        orgId,
        kind: BILLING_ALERT_KIND,
        severity: "critical",
        title: "Suspended club's subscription not cancelled",
        detail: `Cancel it in Stripe by hand: ${(err as Error).message}`,
        dedupeKey: `suspend-cancel-failed:${now.toISOString()}`,
      });
    }
  }

  if (result.decision === "approve" && after.link) {
    const snapshot = parseParticipantSnapshot(after.link.participants);
    try {
      // Imported here, not at the top: participant-sync pulls in the squad
      // extractor, which imports ai-budget, which imports this module.
      const { importParticipants } = await import("./participant-sync");
      const imported = await importParticipants(orgId, snapshot);
      console.log(`[club-approval] ${orgId}: roster imported (${imported.added} new, ${imported.alreadyKnown} known)`);
    } catch (err) {
      console.error(`[club-approval] ${orgId}: roster import FAILED; the next participant sweep fills it:`, err);
    }
    await queueOrganiserDecisionDm(
      `${after.link.id}:approved`,
      after.link.phone,
      s.sj_dm_approved({
        club: result.club,
        group: after.link.groupSubject,
        ...(await organiserLinks(after.link.userId, orgId)),
        tip: feeTip,
      }),
    );
  }
  if (result.decision === "reject" && after.link) {
    await queueOrganiserDecisionDm(
      `${after.link.id}:rejected`,
      after.link.phone,
      s.sj_dm_rejected({ group: after.link.groupSubject }),
    );
  }
  if (after.leaveGroupId) {
    const leave = await queuePlatformLeaveGroup({ groupId: after.leaveGroupId, refId: after.link?.id ?? orgId });
    if ("refused" in leave) {
      console.error(`[club-approval] ${orgId}: leaving ${after.leaveGroupId} refused (${leave.refused})`);
    }
  }
  return result;
}

/** One decision DM per request and outcome, ever. */
async function queueOrganiserDecisionDm(refId: string, phone: string, text: string): Promise<void> {
  const already = await db.platformJob.findFirst({ where: { purpose: "organiser-decision", refId }, select: { id: true } });
  if (already) return;
  try {
    await queuePlatformDm({ phone, text, purpose: "organiser-decision", refId });
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[club-approval] organiser DM ${refId} not queued: ${err.reason}`);
      return;
    }
    throw err;
  }
}

// ── The Leave button for an unsolicited group (slice 7) ─────────────────

export type LeaveUnsolicitedResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "already-left" | "approved-club-group" | "admin-group" | "not-a-group" };

/**
 * Leave a group somebody added MatchTime to with no code. Goes through
 * `queuePlatformLeaveGroup`, which refuses any group an approved club owns
 * (Sutton FC's included), at queue time and again at dispatch.
 */
export async function leaveUnsolicitedGroup(id: string): Promise<LeaveUnsolicitedResult> {
  const row = await db.unsolicitedGroup.findUnique({ where: { id }, select: { id: true, groupId: true, leftAt: true } });
  if (!row) return { ok: false, reason: "not-found" };
  if (row.leftAt) return { ok: false, reason: "already-left" };
  const r = await queuePlatformLeaveGroup({ groupId: row.groupId, refId: row.id });
  if ("refused" in r) return { ok: false, reason: r.refused };
  console.log(`[club-approval] leaving unsolicited group ${row.groupId} (${row.id}) from the owner page`);
  return { ok: true };
}

// ── The owner's WhatsApp reply (slice 7, plan 6.2) ──────────────────────

export interface ApproverDmInput {
  text: string;
  /** The sender's phone as the Pi forwarded it. */
  phone?: string | null;
  /** The phone on the envelope's alt address, when there was one. */
  senderAltPhone?: string | null;
  waMessageId: string;
  now?: Date;
}

export interface ApproverDmOutcome {
  handled: "approver-dm";
  result:
    | "not-approver"
    | "approved"
    | "rejected"
    | "ambiguous"
    | "none-waiting"
    | "unknown-ref"
    | "already"
    | "group-taken";
}

/** Clubs waiting for a decision, oldest first, one per club. */
async function loadWaitingClubs(): Promise<WaitingClub[]> {
  const rows = await db.clubConnect.findMany({
    where: { status: "group_linked", botRemovedAt: null, org: PENDING_CLUB_WHERE },
    orderBy: { linkedAt: "asc" },
    select: { code: true, orgId: true, org: { select: { name: true } } },
  });
  const out: WaitingClub[] = [];
  for (const r of rows) {
    if (!out.some((w) => w.orgId === r.orgId)) out.push({ orgId: r.orgId, code: r.code, club: r.org.name });
  }
  return out;
}

const DECIDED = new Set(["approved", "rejected", "suspended"]);

/** Decided clubs whose request carried this ref, newest first. */
async function loadDecidedForRef(ref: string): Promise<DecidedClub[]> {
  const rows = await db.clubConnect.findMany({
    where: { code: ref, status: "closed" },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { code: true, org: { select: { name: true, approvalStatus: true, approvalDecidedAt: true } } },
  });
  return rows
    .filter((r) => DECIDED.has(r.org.approvalStatus))
    .map((r) => ({
      code: r.code,
      club: r.org.name,
      status: r.org.approvalStatus as DecidedClub["status"],
      decidedAt: r.org.approvalDecidedAt,
    }));
}

/**
 * "APPROVE 7KQ2" / "REJECT 7KQ2" from the owner's phone. Runs at the TOP
 * of /api/whatsapp/dm-reply while SELF_JOIN_ENABLED is on, before every
 * other handler and every model path. Deterministic.
 *
 *   - not a command (the whole message must be one): null, today's
 *     handling, untouched;
 *   - a command WITH a ref from anybody who is not an approver: swallowed,
 *     logged, nothing decided, nothing sent, no model (a bare "approve"
 *     from anybody else is left to today's handling);
 *   - from an approver: resolved, decided through `decideClub`, and
 *     answered with one line through `queueOwnerDm`, keyed on the WhatsApp
 *     message id, so a re-forwarded DM is never answered twice.
 */
export async function handleApproverDm(input: ApproverDmInput): Promise<ApproverDmOutcome | null> {
  const cmd = parseApproverCommand(input.text);
  if (!cmd) return null;
  const now = input.now ?? new Date();
  const approvers = parseApproverPhones(process.env.SELF_JOIN_APPROVER_PHONES);
  if (!isApproverSender(input, approvers)) {
    if (cmd.ref === null) return null;
    console.warn(
      `[club-approval] "${cmd.verb.toUpperCase()} ${cmd.ref}" from a number that is not an approver ` +
        `(phone=${input.phone ?? "-"}, alt=${input.senderAltPhone ?? "-"}); ignored`,
    );
    return { handled: "approver-dm", result: "not-approver" };
  }
  const approver =
    [input.phone, input.senderAltPhone]
      .map((p) => (typeof p === "string" && p.trim() ? e164Digits(p) : null))
      .find((d): d is string => !!d && approvers.includes(d)) ?? "unknown";

  const [waiting, decided] = await Promise.all([
    loadWaitingClubs(),
    cmd.ref ? loadDecidedForRef(cmd.ref) : Promise.resolve([] as DecidedClub[]),
  ]);
  const target = resolveApproverTarget(cmd, waiting, decided);

  let ack: OwnerAck;
  switch (target.kind) {
    case "ambiguous":
    case "none-waiting":
    case "unknown-ref":
    case "already":
      ack = target;
      break;
    case "decide": {
      const r = await decideClub(target.target.orgId, cmd.verb, `whatsapp:${approver}`, { now });
      if (r.ok) ack = { kind: r.decision === "approve" ? "approved" : "rejected", club: r.club };
      else if (r.reason === "group-taken") ack = { kind: "group-taken", club: r.club, takenBy: r.takenBy };
      else if ((r.reason === "not-pending" || r.reason === "not-approved") && DECIDED.has(r.status)) {
        ack = {
          kind: "already",
          decided: {
            code: target.target.code,
            club: r.club,
            status: r.status as DecidedClub["status"],
            decidedAt: r.decidedAt,
          },
        };
      } else {
        ack = { kind: "unknown-ref", ref: target.target.code, waiting: waiting.filter((w) => w.orgId !== target.target.orgId) };
      }
      break;
    }
  }

  await queueOwnerDm(ownerAckText(ack), "owner-ack", `dm:${input.waMessageId}`, now);
  console.log(`[club-approval] owner DM "${input.text.trim()}" -> ${ack.kind}`);
  return { handled: "approver-dm", result: ack.kind };
}
