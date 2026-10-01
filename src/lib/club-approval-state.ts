/**
 * The PURE half of club approval (no database import), so pure modules
 * such as org-lifecycle.ts can share the one definition of "approved".
 * Everything here is re-exported from club-approval.ts, which is the
 * module every other caller should import. See that file for the design.
 *
 * Club fee billing (slice B1, 2026-10-01) adds the SERVING gate: approved
 * AND not billing-paused. "Paused" is read only through
 * `isBillingPaused` / `billingQuietWhere` (club-billing-rules.ts), which
 * are false / empty while BILLING_ENABLED is off, so with the flag off
 * every gate below is exactly the approval gate it was before.
 */
import { BILLING_NOT_PAUSED_WHERE, isBillingEnabled, isBillingPaused } from "./club-billing-rules";
export const APPROVAL_STATUSES = ["draft", "pending", "approved", "rejected", "suspended"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The one Prisma `where` fragment for "this club is approved". */
export const APPROVED_CLUB_WHERE = { approvalStatus: "approved" } as const;

/**
 * Approved AND not billing-paused (plan section 4.3): the clubs MatchTime
 * serves. Use `servingClubWhere()` in queries, never this constant
 * directly: the function honours the BILLING_ENABLED kill switch.
 */
export const SERVING_CLUB_WHERE = { ...APPROVED_CLUB_WHERE, ...BILLING_NOT_PAUSED_WHERE } as const;

/**
 * The Prisma `where` fragment for "MatchTime serves this club". With
 * BILLING_ENABLED off it IS `APPROVED_CLUB_WHERE` (the same object), so
 * every query that switched to it is byte for byte today's.
 */
export function servingClubWhere(
  env: Record<string, string | undefined> = process.env,
): typeof APPROVED_CLUB_WHERE | typeof SERVING_CLUB_WHERE {
  return isBillingEnabled(env) ? SERVING_CLUB_WHERE : APPROVED_CLUB_WHERE;
}

/** A club created through self-join that has not been linked to a group
 *  yet (or was removed from it while pending). Slice 6. */
export const DRAFT_CLUB_WHERE = { approvalStatus: "draft" } as const;

/** A club linked to a group and waiting for the owner's decision. Slice 6. */
export const PENDING_CLUB_WHERE = { approvalStatus: "pending" } as const;

/** Turned down by the owner (slice 7). */
export const REJECTED_CLUB_WHERE = { approvalStatus: "rejected" } as const;

/** Turned off by the owner's off switch (slice 7). */
export const SUSPENDED_CLUB_WHERE = { approvalStatus: "suspended" } as const;

/** Its complement, for the silent-group loader. */
export const UNAPPROVED_CLUB_WHERE = { approvalStatus: { not: "approved" } } as const;

/**
 * The clubs that came in through self-join (slice 4, 2026-09-29): any
 * club not approved, or one approved THROUGH the flow (`approvedAt` is
 * set only by an approval decision). Every club that existed before
 * self-join is approved with a NULL `approvedAt`, so none of them is
 * ever counted, which is what lets an existing admin still set up one
 * self-join club, and keeps Sutton FC out of the daily new-club cap.
 */
export const SELF_JOIN_CLUB_WHERE = {
  OR: [{ approvalStatus: { not: "approved" } }, { approvedAt: { not: null } }],
};

export function isClubApproved(org: { approvalStatus: string | null | undefined }): boolean {
  return org.approvalStatus === "approved";
}

/**
 * May MatchTime act for this club on its own initiative? Approved AND
 * not dormant AND not billing-paused (club fee billing, slice B1; never
 * paused while BILLING_ENABLED is off). Deliberately blind to the mute
 * switch, for the reason in org-lifecycle.ts: muting a live club must
 * never cost it a fixture.
 *
 * `billingStatus` is a REQUIRED key so every caller has to select it;
 * a caller that forgot would silently ignore the pause.
 */
export function isClubOperational(org: {
  approvalStatus: string | null | undefined;
  dormantAt: Date | null | undefined;
  billingStatus: string | null | undefined;
}): boolean {
  return (
    isClubApproved(org) && (org.dormantAt === null || org.dormantAt === undefined) && !isBillingPaused(org)
  );
}
