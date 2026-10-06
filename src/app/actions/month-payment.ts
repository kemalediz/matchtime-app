"use server";

/**
 * Monthly squad, slice 4 (MDs/monthly-squad-plan-2026-10-05.md, 4.2, 4.3
 * and 9.2): the server actions behind the price form and the "Confirm
 * paid" buttons on /admin/months, and "I've paid" on the player's page.
 *
 * - The price is the organiser's (D1): OWNER and ADMIN.
 * - A payment is confirmed by the club's money collector and nobody else
 *   (D3): `confirmMonthPaid` refuses anybody else, an admin included.
 * - "I've paid" is a CLAIM. It never sets `paidAt`.
 * Refusals come back as `{ ok: false, error }` for the page to put into
 * words.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { londonDateTimeToUtc } from "@/lib/london-time";
import { claimMonthPaid, confirmMonthPaid, mayConfirmPayments, priceMonth, unconfirmMonthPaid, type ConfirmPaidError, type PriceMonthError } from "@/lib/month-payment";
import { parsePounds } from "@/lib/squad-month-rules";

async function requireAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);
  return session.user.id;
}

/**
 * The club's money collector OR an organiser (slice 6): the collector need
 * not be an OWNER or ADMIN to confirm a payment. WHO may actually confirm
 * is still decided by `mayConfirmPayments` in the library (D3): the
 * collector, and with none set the owner and admins.
 */
async function requireCollectorOrAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { isOrgAdmin } = await import("@/lib/org");
  if (!(await isOrgAdmin(session.user.id, orgId)) && !(await mayConfirmPayments(orgId, session.user.id))) throw new Error("Not allowed");
  return session.user.id;
}

/** "" is "not given"; anything else must be a price. */
function optionalPounds(text: string): { ok: true; pence: number | null } | { ok: false } {
  if (typeof text !== "string") return { ok: false };
  if (text.trim() === "") return { ok: true, pence: null };
  const pence = parsePounds(text);
  return pence === null ? { ok: false } : { ok: true, pence };
}

/**
 * Set the month's price. Amounts are typed in pounds ("7.50"); the pay-by
 * date is a London wall-clock "YYYY-MM-DDTHH:mm".
 */
export async function setMonthPrice(
  orgId: string,
  monthId: string,
  form: { share: string; concession: string; venue: string; payBy: string },
): Promise<{ ok: true } | { ok: false; error: PriceMonthError }> {
  await requireAdmin(orgId);
  const share = parsePounds(form?.share);
  if (share === null) return { ok: false, error: "bad-share" };
  const concession = optionalPounds(form.concession);
  if (!concession.ok) return { ok: false, error: "bad-concession" };
  const venue = optionalPounds(form.venue);
  if (!venue.ok) return { ok: false, error: "bad-venue" };
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(typeof form.payBy === "string" ? form.payBy : "");
  if (!m) return { ok: false, error: "bad-pay-by" };
  let payByAt: Date;
  try {
    payByAt = londonDateTimeToUtc(m[1], m[2]);
  } catch {
    return { ok: false, error: "bad-pay-by" };
  }
  const res = await priceMonth({
    orgId,
    monthId,
    input: { sharePence: share, concessionPence: concession.pence, venueCostPence: venue.pence, payByAt },
  });
  if (res.ok) revalidatePath("/admin/months");
  return res;
}

/** The collector confirms (or takes back) one regular's payment. */
export async function setMonthPaid(
  orgId: string,
  monthId: string,
  userId: string,
  paid: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: ConfirmPaidError }> {
  const actorUserId = await requireCollectorOrAdmin(orgId);
  const res = paid
    ? await confirmMonthPaid({ orgId, monthId, userId, actorUserId })
    : await unconfirmMonthPaid({ orgId, monthId, userId, actorUserId });
  if (res.ok) {
    revalidatePath("/admin/months");
    revalidatePath("/month/collect");
  }
  return res;
}

/** A player says, on their own page, that they have paid for the month. */
export async function sayMonthPaid(monthId: string): Promise<{ ok: boolean }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (typeof monthId !== "string") return { ok: false };
  await claimMonthPaid({ monthId, userId: session.user.id, source: "page" });
  revalidatePath("/month");
  return { ok: true };
}
