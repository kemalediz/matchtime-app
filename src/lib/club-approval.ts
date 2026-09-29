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
 * (`__tests__/club-approval-source-guard.test.ts`). Later slices add the
 * writer (`decideClub`) here.
 *
 * NOT the mute switch (`whatsappBotEnabled`) and NOT dormancy
 * (`dormantAt`). Both keep their meanings (see org-lifecycle.ts).
 */
import { db } from "./db";

export {
  APPROVAL_STATUSES,
  APPROVED_CLUB_WHERE,
  DRAFT_CLUB_WHERE,
  PENDING_CLUB_WHERE,
  UNAPPROVED_CLUB_WHERE,
  SELF_JOIN_CLUB_WHERE,
  isClubApproved,
  isClubOperational,
  type ApprovalStatus,
} from "./club-approval-state";
import { APPROVED_CLUB_WHERE, UNAPPROVED_CLUB_WHERE } from "./club-approval-state";

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
}

/**
 * The groups MatchTime must stay silent in. An approved club's group is
 * never silent, whatever stale row names it: the failure this protects
 * against is a leftover connect or unsolicited row silencing Sutton FC.
 */
export function computeSilentGroups(src: SilentGroupSources): string[] {
  const ok = (g: string | null): g is string => typeof g === "string" && g.length > 0;
  const approved = new Set(src.approvedOrgGroups.filter(ok));
  const silent = new Set<string>();
  for (const g of [...src.unapprovedOrgGroups, ...src.unapprovedConnectGroups, ...src.unsolicitedGroups]) {
    if (ok(g) && !approved.has(g)) silent.add(g);
  }
  return [...silent];
}

/** Read the sources and compute the silent set. Four small queries. */
export async function loadSilentGroupIds(): Promise<string[]> {
  const [approvedOrgs, unapprovedOrgs, connects, unsolicited] = await Promise.all([
    db.organisation.findMany({
      where: { ...APPROVED_CLUB_WHERE, whatsappGroupId: { not: null } },
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
  ]);
  return computeSilentGroups({
    approvedOrgGroups: approvedOrgs.map((o) => o.whatsappGroupId),
    unapprovedOrgGroups: unapprovedOrgs.map((o) => o.whatsappGroupId),
    unapprovedConnectGroups: connects.map((c) => c.groupId),
    unsolicitedGroups: unsolicited.map((u) => u.groupId),
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
