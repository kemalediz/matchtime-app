"use server";

/**
 * The owner page's buttons (/admin/clubs, self-join slice 7). Plan:
 * MDs/self-join-and-approval-plan-2026-09-28.md, section 6.4.
 *
 * OWNER ONLY: every action checks `User.isSuperadmin` itself, whatever the
 * page showed. Each one is a thin wrapper round the single writer,
 * `decideClub` (or `leaveUnsolicitedGroup`) in src/lib/club-approval.ts.
 *
 * Approve needs SELF_JOIN_ENABLED. Reject, Turn off and Leave do not:
 * they only ever make MatchTime quieter, so they keep working after the
 * flag is switched off as a rollback.
 *
 * "use server" modules may export async functions only (see
 * __tests__/platform-jobs-source-guard.test.ts).
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { decideClub, leaveUnsolicitedGroup, type DecideClubResult } from "@/lib/club-approval";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";

export interface ClubActionResult {
  ok: boolean;
  message: string;
}

async function requireOwner(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) throw new Error("Not allowed");
  return userId;
}

function describe(r: DecideClubResult): ClubActionResult {
  if (r.ok) {
    switch (r.decision) {
      case "approve":
        return { ok: true, message: `Approved ${r.club}. The hello goes out in the group within a few minutes.` };
      case "reject":
        return { ok: true, message: `Rejected ${r.club}. MatchTime is leaving the group.` };
      case "suspend":
        return { ok: true, message: `Turned off ${r.club}. MatchTime is leaving the group and stays silent.` };
    }
  }
  switch (r.reason) {
    case "not-found":
      return { ok: false, message: "That club no longer exists." };
    case "not-pending":
      return { ok: false, message: `${r.club} is not waiting any more (it is ${r.status}).` };
    case "not-approved":
      return { ok: false, message: `${r.club} is not live (it is ${r.status}).` };
    case "not-self-join":
      return {
        ok: false,
        message: `${r.club} was not set up through self-join, so it cannot be turned off from this page.`,
      };
    case "confirm-mismatch":
      return { ok: false, message: `Type the club's name exactly to turn ${r.club} off.` };
    case "no-linked-group":
      return { ok: false, message: `${r.club} has no WhatsApp group linked, so there is nothing to approve.` };
    case "group-taken":
      return { ok: false, message: `Can't approve ${r.club}: its group already belongs to ${r.takenBy}.` };
  }
}

async function run(orgId: string, decision: "approve" | "reject" | "suspend", confirmName?: string) {
  const userId = await requireOwner();
  if (decision === "approve" && !(await selfJoinEnabledForRequest())) {
    return { ok: false, message: "Self-join is switched off (SELF_JOIN_ENABLED), so nothing can be approved." };
  }
  const r = await decideClub(orgId, decision, userId, { confirmName });
  revalidatePath("/admin/clubs");
  return describe(r);
}

export async function approveClubAction(orgId: string): Promise<ClubActionResult> {
  return run(orgId, "approve");
}

export async function rejectClubAction(orgId: string): Promise<ClubActionResult> {
  return run(orgId, "reject");
}

export async function suspendClubAction(orgId: string, typedName: string): Promise<ClubActionResult> {
  return run(orgId, "suspend", typedName);
}

export async function leaveUnsolicitedAction(id: string): Promise<ClubActionResult> {
  await requireOwner();
  const r = await leaveUnsolicitedGroup(id);
  revalidatePath("/admin/clubs");
  if (r.ok) return { ok: true, message: "MatchTime is leaving the group." };
  switch (r.reason) {
    case "approved-club-group":
      return { ok: false, message: "A live club owns that group now, so MatchTime will not leave it from here." };
    case "already-left":
      return { ok: false, message: "MatchTime has already left that group." };
    default:
      return { ok: false, message: "That group could not be found." };
  }
}
