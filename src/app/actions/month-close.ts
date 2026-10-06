"use server";

/**
 * Monthly squad, slice 6 (MDs/monthly-squad-plan-2026-10-05.md, 5.2, 7 and
 * 9): the server actions behind the credits ledger, the refund and
 * share-change controls on /admin/months, and a regular's away weeks on
 * /month.
 *
 * - "Add credit", "Remove credit" and changing the share are the
 *   organiser's: OWNER and ADMIN.
 * - A refund is recorded by the club's money collector and nobody else
 *   (`recordRefund` refuses anybody else, an admin included).
 * - Away weeks are only ever the signed-in player's own.
 * Refusals come back as `{ ok: false, error }` for the page to put into
 * words. Nothing here moves money or posts in the group.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import {
  addManualCredit,
  changeShareAfterPaid,
  recordRefund,
  removeCredit,
  setAwayWeeks,
  type AwayError,
  type ManualCreditError,
  type RefundError,
  type RemoveCreditError,
  type ShareChangeError,
} from "@/lib/month-close";
import { parsePounds } from "@/lib/squad-month-rules";

async function requireAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);
  return session.user.id;
}

/** "Add credit": games of credit for one player, with the organiser's reason. */
export async function addCredit(
  orgId: string,
  form: { userId: string; games: number; reason: string; token: string },
): Promise<{ ok: true; added: number } | { ok: false; error: ManualCreditError }> {
  const actorUserId = await requireAdmin(orgId);
  const res = await addManualCredit({ orgId, userId: form?.userId, games: form?.games, reason: form?.reason, token: form?.token, actorUserId });
  if (res.ok) revalidatePath("/admin/months/credits");
  return res;
}

/** "Remove credit": the row stays, voided, with who and why. */
export async function removeCreditAction(
  orgId: string,
  creditId: string,
  reason: string,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: RemoveCreditError }> {
  const actorUserId = await requireAdmin(orgId);
  if (typeof creditId !== "string") return { ok: false, error: "not-found" };
  const res = await removeCredit({ orgId, creditId, reason, actorUserId });
  if (res.ok) revalidatePath("/admin/months/credits");
  return res;
}

/** The collector records the total they gave back to one person for a month. */
export async function recordMonthRefund(
  orgId: string,
  monthId: string,
  userId: string,
  amount: string,
): Promise<{ ok: true; settledCredits: number } | { ok: false; error: RefundError }> {
  const actorUserId = await requireAdmin(orgId);
  const pence = parsePounds(amount);
  if (pence === null) return { ok: false, error: "bad-amount" };
  const res = await recordRefund({ orgId, monthId, userId, amountPence: pence, actorUserId });
  if (res.ok) revalidatePath("/admin/months");
  return res;
}

/** A new share for a month somebody has already paid for. */
export async function changeMonthShare(
  orgId: string,
  monthId: string,
  form: { share: string; concession: string; acknowledged: boolean },
): Promise<{ ok: true; changed: boolean } | { ok: false; error: ShareChangeError }> {
  const actorUserId = await requireAdmin(orgId);
  const share = parsePounds(form?.share);
  if (share === null) return { ok: false, error: "bad-share" };
  const concessionText = typeof form.concession === "string" ? form.concession.trim() : "";
  const concession = concessionText === "" ? null : parsePounds(concessionText);
  if (concessionText !== "" && concession === null) return { ok: false, error: "bad-concession" };
  const res = await changeShareAfterPaid({ orgId, monthId, sharePence: share, concessionPence: concession, acknowledged: form.acknowledged === true, actorUserId });
  if (res.ok) revalidatePath("/admin/months");
  return res;
}

/** A regular's own away weeks: the London days ("YYYY-MM-DD") they ticked. */
export async function saveAwayWeeks(
  monthId: string,
  days: string[],
): Promise<{ ok: true; changed: boolean } | { ok: false; error: AwayError }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const membership = await getUserOrg(session.user.id);
  if (!membership || typeof monthId !== "string") return { ok: false, error: "not-found" };
  const res = await setAwayWeeks({ orgId: membership.orgId, monthId, userId: session.user.id, days: Array.isArray(days) ? days.slice(0, 12) : [] });
  revalidatePath("/month");
  return res.ok ? { ok: true, changed: res.changed } : res;
}
