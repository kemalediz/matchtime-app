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
  accountChargesEnabled,
  createCheckoutSession,
} from "@/lib/stripe";
import { totalForMethod, type PayMethod } from "@/lib/payments";

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
  const url = await createCheckoutSession({
    connectedAccountId: org.stripeConnectAccountId,
    amount: total,
    method,
    quantity: qty,
    description: `${match.activity.name} — match fee${qty > 1 ? ` (${qty} players)` : ""}`,
    metadata: { matchId, userId, quantity: String(qty), orgId: org.id },
    successPath: `/pay/${matchId}?paid=1`,
    cancelPath: `/pay/${matchId}`,
  });
  await db.attendance.update({
    where: { matchId_userId: { matchId, userId } },
    data: { paymentMethod: method, paymentAmount: total, paymentQuantity: qty },
  });
  return { url };
}

/** "Pay the collector directly" → flag pending + DM the collector to confirm. */
export async function payDirect(matchId: string, quantity = 1): Promise<{ ok: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const userId = session.user.id;
  const { match, org, base } = await loadPayContext(userId, matchId);
  if (!org.payMethodDirect) throw new Error("Direct payment is off");

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

  // Notify the collector so they can confirm when the cash/transfer lands.
  if (org.paymentHolderId) {
    const me = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
    const holder = await db.user.findUnique({
      where: { id: org.paymentHolderId },
      select: { phoneNumber: true },
    });
    if (holder?.phoneNumber) {
      const { signMagicLinkToken, buildMagicLinkUrl, MAGIC_LINK_TTL } = await import("@/lib/magic-link");
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
            `Mark it paid once it lands:\n${buildMagicLinkUrl(token)}`,
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
