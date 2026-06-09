"use server";

/**
 * Payment server actions (2026-06-03).
 *   Admin:  startCollectorOnboarding, refreshCollectorStatus
 *   Player: payByMethod, payDirect
 *   Collector/admin: confirmDirectPayment
 *
 * Charges are created ON the org's connected account (Connect), so funds
 * settle to the money collector. MatchTime never holds the money.
 */

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import {
  isStripeConfigured,
  createConnectAccount,
  createOnboardingLink,
  createDashboardLoginLink,
  accountChargesEnabled,
  createCheckoutSession,
} from "@/lib/stripe";
import { totalForMethod, platformFeePence, type PayMethod } from "@/lib/payments";
import { formatLondon } from "@/lib/london-time";

// ── Connect onboarding (money collector links their bank) ────────────

export async function startCollectorOnboarding(orgId: string): Promise<{ url: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  if (!isStripeConfigured()) throw new Error("Stripe is not configured yet");

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, stripeConnectAccountId: true, paymentHolderId: true },
  });
  if (!org) throw new Error("Org not found");

  let accountId = org.stripeConnectAccountId;
  if (!accountId) {
    // Use the collector's real email if we have one (skip synthetic
    // provisional/wa-sync addresses — Stripe will collect it in onboarding).
    let email: string | null = null;
    if (org.paymentHolderId) {
      const holder = await db.user.findUnique({
        where: { id: org.paymentHolderId },
        select: { email: true },
      });
      if (holder?.email && !holder.email.endsWith("@matchtime.local")) email = holder.email;
    }
    accountId = await createConnectAccount({ email, orgName: org.name });
    await db.organisation.update({
      where: { id: orgId },
      data: { stripeConnectAccountId: accountId, stripeChargesEnabled: false },
    });
  }

  const url = await createOnboardingLink(accountId, "/admin/settings");
  return { url };
}

export async function refreshCollectorStatus(orgId: string): Promise<{ chargesEnabled: boolean }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { stripeConnectAccountId: true },
  });
  if (!org?.stripeConnectAccountId || !isStripeConfigured()) return { chargesEnabled: false };

  const enabled = await accountChargesEnabled(org.stripeConnectAccountId);
  await db.organisation.update({
    where: { id: orgId },
    data: { stripeChargesEnabled: enabled },
  });
  revalidatePath("/admin/settings");
  return { chargesEnabled: enabled };
}

/**
 * Detach the org's Stripe connected account so the collector can start
 * "Connect bank" from scratch — e.g. they onboarded the wrong identity, or
 * a stale test-mode account is bound. This only clears MatchTime's
 * reference (`stripeConnectAccountId` + `stripeChargesEnabled`); the
 * abandoned Stripe account is left as-is (delete it in the Stripe
 * dashboard if desired). The next onboarding creates a fresh account.
 */
/**
 * One-time link to the collector's Stripe Express dashboard so they can
 * CHANGE THEIR PAYOUT BANK or review payouts later, on their existing
 * account — no disconnect, no re-onboarding, history preserved. This is
 * the right tool for "I want the money to go to a different account now"
 * (vs. resetCollectorConnect, which wipes the account entirely).
 */
export async function openCollectorDashboard(orgId: string): Promise<{ url: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  if (!isStripeConfigured()) throw new Error("Stripe is not configured");

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { stripeConnectAccountId: true },
  });
  if (!org?.stripeConnectAccountId) throw new Error("No connected bank to manage yet");

  const url = await createDashboardLoginLink(org.stripeConnectAccountId);
  return { url };
}

/**
 * Set which org member is the money collector (`paymentHolderId`) — the
 * person who gets the "how much per player?" prompt, receives the
 * "pay you directly" confirmations, and whose connected bank the Stripe
 * payouts settle to. Does NOT touch the connected Stripe account: that
 * stays as connected. The chosen member must have a phone number, or the
 * post-match collector DMs would have nowhere to go.
 */
export async function setPaymentHolder(
  orgId: string,
  userId: string,
): Promise<{ ok: true; name: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  // The collector must be a member of this org (and have a phone to be DM'd).
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { user: { select: { name: true, phoneNumber: true } } },
  });
  if (!membership) throw new Error("That person isn't a member of this group");
  if (!membership.user.phoneNumber) {
    throw new Error("That person has no phone number on file — they can't receive collection messages");
  }

  await db.organisation.update({ where: { id: orgId }, data: { paymentHolderId: userId } });
  revalidatePath("/admin/settings");
  return { ok: true, name: membership.user.name };
}

export async function resetCollectorConnect(orgId: string): Promise<{ ok: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  await db.organisation.update({
    where: { id: orgId },
    data: { stripeConnectAccountId: null, stripeChargesEnabled: false },
  });
  revalidatePath("/admin/settings");
  return { ok: true };
}

// ── Player pays ──────────────────────────────────────────────────────

async function loadPayContext(userId: string, matchId: string) {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: {
        select: {
          name: true,
          orgId: true,
          org: {
            select: {
              id: true,
              name: true,
              stripeConnectAccountId: true,
              stripeChargesEnabled: true,
              payMethodPayByBank: true,
              payMethodCard: true,
              payMethodDirect: true,
              paymentHolderId: true,
            },
          },
        },
      },
    },
  });
  if (!match) throw new Error("Match not found");
  if (match.feePerPlayer == null) throw new Error("No fee set for this match yet");
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (!attendance) throw new Error("You weren't in this squad");
  return { match, org: match.activity.org, attendance, base: match.feePerPlayer };
}

/** Card / Pay by Bank → create a Checkout session on the connected
 *  account and return its URL for the client to redirect to. */
export async function payByMethod(
  matchId: string,
  method: "card" | "pay_by_bank",
  quantity = 1,
): Promise<{ url: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const userId = session.user.id;
  const { match, org, base } = await loadPayContext(userId, matchId);

  if (method === "card" && !org.payMethodCard) throw new Error("Card payments are off");
  if (method === "pay_by_bank" && !org.payMethodPayByBank) throw new Error("Pay by Bank is off");
  if (!org.stripeConnectAccountId || !org.stripeChargesEnabled) {
    throw new Error("The organiser hasn't finished connecting their bank yet");
  }

  const qty = Math.max(1, Math.min(10, Math.floor(quantity)));
  const total = totalForMethod(base, method as PayMethod, qty);
  // Collector-facing label so they can tell who paid: "Amir - 9th June"
  // (name + match date, no time). +N when paying for guests.
  const payer = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  const matchDay = formatLondon(match.date, "do MMMM");
  const payerDescription =
    `${payer?.name ?? "Player"}${qty > 1 ? ` +${qty - 1}` : ""} - ${matchDay}`;
  const url = await createCheckoutSession({
    connectedAccountId: org.stripeConnectAccountId,
    amount: total,
    applicationFeePence: platformFeePence(base, method as PayMethod, qty),
    method,
    quantity: qty,
    description: `${match.activity.name} — match fee${qty > 1 ? ` (${qty} players)` : ""}`,
    payerDescription,
    metadata: { matchId, userId, quantity: String(qty), orgId: org.id },
    successPath: `/pay/${matchId}?paid=1`,
    cancelPath: `/pay/${matchId}`,
  });
  await db.attendance.update({
    where: { matchId_userId: { matchId, userId } },
    // Switching to a card/bank method supersedes any earlier "pay directly"
    // intent — clear directPendingAt so the player isn't mislabelled as
    // "paying you directly" (with the card amount) on the collect page if
    // they tapped direct first and then changed their mind.
    data: { paymentMethod: method, paymentAmount: total, paymentQuantity: qty, directPendingAt: null },
  });
  return { url };
}

/** "Pay the collector directly" → flag pending + DM the collector to confirm. */
export async function payDirect(matchId: string, quantity = 1): Promise<{ ok: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const userId = session.user.id;
  const { match, org, base, attendance } = await loadPayContext(userId, matchId);
  if (!org.payMethodDirect) throw new Error("Direct payment is off");

  // Was this player ALREADY in "will pay directly" (unpaid) before this tap?
  // If so, this is a repeat tap — refresh state silently, don't re-DM the
  // collector (one nudge per player per match). A fresh selection (no prior
  // pending, or after the state cleared) still notifies.
  const alreadyPending = attendance.directPendingAt != null && attendance.paidAt == null;

  const qty = Math.max(1, Math.min(10, Math.floor(quantity)));
  const amount = base * qty;
  await db.attendance.update({
    where: { matchId_userId: { matchId, userId } },
    data: {
      paymentMethod: "direct",
      paymentAmount: amount,
      paymentQuantity: qty,
      directPendingAt: new Date(),
    },
  });

  // Notify the collector so they can confirm when the cash/transfer lands —
  // but only on a NEW direct selection, not a repeat tap while still pending.
  if (org.paymentHolderId && !alreadyPending) {
    const me = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
    const holder = await db.user.findUnique({
      where: { id: org.paymentHolderId },
      select: { phoneNumber: true },
    });
    if (holder?.phoneNumber) {
      const { signMagicLinkToken, MAGIC_LINK_TTL } = await import("@/lib/magic-link");
      const { buildShortMagicLinkUrl } = await import("@/lib/short-link");
      const token = signMagicLinkToken({
        userId: org.paymentHolderId,
        purpose: "sign-in",
        nextPath: `/collect/${matchId}`,
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      const { gbp } = await import("@/lib/payments");
      await db.botJob.create({
        data: {
          orgId: org.id,
          kind: "dm",
          phone: holder.phoneNumber.replace(/^\+/, ""),
          text:
            `💸 *${me?.name ?? "A player"}* says they'll pay you directly for *${match.activity.name}* — ` +
            `*${gbp(amount)}*${qty > 1 ? ` (${qty} players)` : ""}.\n\n` +
            `Mark it paid once it lands:\n${await buildShortMagicLinkUrl(token)}`,
        },
      });
    }
  }
  return { ok: true };
}

/** Confirm a direct payment was received. Authorised for an org admin OR
 *  the org's money collector (paymentHolderId) — the collector is often
 *  not an admin (e.g. Elvin collects for Sutton, Kemal owns). */
export async function confirmDirectPayment(matchId: string, userId: string): Promise<{ ok: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireMatchCollectorOrAdmin(session.user.id, matchId);

  await db.attendance.update({
    where: { matchId_userId: { matchId, userId } },
    data: { paidAt: new Date(), directConfirmedByUserId: session.user.id, directPendingAt: null },
  });
  revalidatePath(`/collect/${matchId}`);
  return { ok: true };
}

/** Throws unless `userId` is an org admin or the org's money collector for
 *  the match's org. Shared by the collector-facing confirm flow. */
export async function requireMatchCollectorOrAdmin(userId: string, matchId: string): Promise<string> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { org: { select: { id: true, paymentHolderId: true } } } } },
  });
  if (!match) throw new Error("Match not found");
  const org = match.activity.org;
  if (org.paymentHolderId === userId) return org.id; // collector
  await requireOrgAdmin(userId, org.id); // else must be an admin (throws otherwise)
  return org.id;
}
