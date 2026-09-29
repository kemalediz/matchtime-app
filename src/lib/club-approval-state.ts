/**
 * The PURE half of club approval (no database import), so pure modules
 * such as org-lifecycle.ts can share the one definition of "approved".
 * Everything here is re-exported from club-approval.ts, which is the
 * module every other caller should import. See that file for the design.
 */
export const APPROVAL_STATUSES = ["draft", "pending", "approved", "rejected", "suspended"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The one Prisma `where` fragment for "this club is approved". */
export const APPROVED_CLUB_WHERE = { approvalStatus: "approved" } as const;

/** A club created through self-join that has not been linked to a group
 *  yet (or was removed from it while pending). Slice 6. */
export const DRAFT_CLUB_WHERE = { approvalStatus: "draft" } as const;

/** A club linked to a group and waiting for the owner's decision. Slice 6. */
export const PENDING_CLUB_WHERE = { approvalStatus: "pending" } as const;

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
 * not dormant. Deliberately blind to the mute switch, for the reason in
 * org-lifecycle.ts: muting a live club must never cost it a fixture.
 */
export function isClubOperational(org: {
  approvalStatus: string | null | undefined;
  dormantAt: Date | null | undefined;
}): boolean {
  return isClubApproved(org) && (org.dormantAt === null || org.dormantAt === undefined);
}
