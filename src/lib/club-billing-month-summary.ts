/**
 * CLUB FEE BILLING, slice P4 (games played): what the billing page, the
 * settings card, the banner and /admin/clubs show about a club's months.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 8.1 to 8.3.
 *
 * READS ONLY. `club-billing-months.ts` stays the one writer of
 * `ClubBillingMonth`; this file never writes anything and never calls
 * Stripe (the receipt route does that, on a tap).
 *
 * This month's box is counted at page load with the same `countClubMonth`
 * the close uses, with `now` so games still to come show as upcoming. Its
 * "so far" amount uses the lower of the price when the month opened and
 * the plan's price now, as the close will (plan 2A.4).
 */
import { db } from "./db";
import { countClubMonth, monthFee } from "./club-billing-cycle-rules";
import { loadClubMonthInput, type MonthLoaderClient } from "./club-billing-month-loader";
import { STANDARD_PRICE_PENCE, planPricePence, receiptAllowed } from "./club-billing-rules";
import { billingRetriesOn } from "./club-billing-schedule-rules";
import type { UnpaidSummary } from "./club-billing-view";

/** Written by club-billing-stripe.ts for each applied card session, at the
 *  session's CREATED time (P2 review M1). Repeated here so this read-only
 *  file does not import the Stripe module; pinned by a unit test. */
export const CARD_SESSION_MARKER = "mt.card-session";

/** Months that are unpaid: the charge failed, or it is still being taken. */
export const UNPAID_MONTH_STATUSES = ["failed", "invoiced"] as const;

/** How many closed months the billing page lists. */
export const PAST_MONTHS_SHOWN = 12;

export interface CurrentMonth {
  id: string;
  startsAt: Date;
  endsAt: Date;
  played: number;
  scheduled: number;
  upcoming: number;
  /** The month's maximum: the lower of the price at its start and now. */
  pricePence: number;
  /** What it would charge if it closed now (0 when nothing would be). */
  soFarPence: number;
}

export interface PastMonth {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  played: number | null;
  scheduled: number | null;
  amountPence: number | null;
  games: Array<{ kickoff: Date; outcome: string }>;
  /** The viewer may open its receipt (`receiptAllowed`). */
  receipt: boolean;
}

export interface MonthsSummary {
  current: CurrentMonth | null;
  past: PastMonth[];
  unpaid: UnpaidSummary | null;
  retrying: boolean;
}

function gamesOf(json: unknown): Array<{ kickoff: Date; outcome: string }> {
  if (!Array.isArray(json)) return [];
  const out: Array<{ kickoff: Date; outcome: string }> = [];
  for (const g of json) {
    if (!g || typeof g !== "object") continue;
    const { kickoff, outcome } = g as { kickoff?: unknown; outcome?: unknown };
    if (typeof kickoff !== "string" || typeof outcome !== "string") continue;
    const at = new Date(kickoff);
    if (!Number.isNaN(at.getTime())) out.push({ kickoff: at, outcome });
  }
  return out;
}

/** The open month containing `now`, counted so far; null when none is open
 *  yet (the hourly cron opens it) or the club does not exist. */
export async function loadCurrentMonth(
  orgId: string,
  now: Date,
  plan: { plan: string; pricePence: number | null },
): Promise<CurrentMonth | null> {
  const m = await db.clubBillingMonth.findFirst({
    where: { orgId, status: "open", startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { index: "desc" },
    select: { id: true, startsAt: true, endsAt: true, priceAtStartPence: true },
  });
  if (!m) return null;
  const input = await loadClubMonthInput(db as unknown as MonthLoaderClient, orgId, { startsAt: m.startsAt, endsAt: m.endsAt }, { now });
  if (!input) return null;
  const count = countClubMonth(input);
  const nowPrice = planPricePence(plan.plan, plan.pricePence) ?? STANDARD_PRICE_PENCE;
  const fee = monthFee({ priceAtStartPence: m.priceAtStartPence, priceAtClosePence: nowPrice, played: count.played, scheduled: count.scheduled });
  return {
    id: m.id,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    played: count.played,
    scheduled: count.scheduled,
    upcoming: count.upcoming,
    pricePence: fee.pricePence,
    soFarPence: fee.charge ? fee.amountPence : 0,
  };
}

/** The club's unpaid months: their total, how many, the latest one's dates. */
export async function loadUnpaidSummary(orgId: string): Promise<UnpaidSummary | null> {
  const rows = await db.clubBillingMonth.findMany({
    where: { orgId, status: { in: [...UNPAID_MONTH_STATUSES] }, amountPence: { not: null } },
    orderBy: { index: "desc" },
    select: { startsAt: true, endsAt: true, amountPence: true },
  });
  if (rows.length === 0) return null;
  return {
    totalPence: rows.reduce((sum, r) => sum + (r.amountPence ?? 0), 0),
    count: rows.length,
    startsAt: rows[0].startsAt,
    endsAt: rows[0].endsAt,
  };
}

/** When the card on file went on: the latest applied card session. */
async function cardSince(orgId: string): Promise<Date | null> {
  const ev = await db.billingEvent.findFirst({
    where: { orgId, type: CARD_SESSION_MARKER },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true },
  });
  return ev?.receivedAt ?? null;
}

/** The closed months, newest first, with the receipt rule applied for
 *  this viewer. */
export async function loadPastMonths(
  orgId: string,
  viewer: { role: string; userId: string; cardHolderUserId: string | null },
  take: number = PAST_MONTHS_SHOWN,
): Promise<PastMonth[]> {
  const rows = await db.clubBillingMonth.findMany({
    where: { orgId, status: { not: "open" } },
    orderBy: { index: "desc" },
    take,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      played: true,
      scheduled: true,
      amountPence: true,
      games: true,
      stripeInvoiceId: true,
      closedAt: true,
    },
  });
  const ownCard = viewer.cardHolderUserId !== null && viewer.cardHolderUserId === viewer.userId;
  const since = viewer.role === "contact" && ownCard && rows.some((r) => r.status === "paid") ? await cardSince(orgId) : null;
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status,
    played: r.played,
    scheduled: r.scheduled,
    amountPence: r.amountPence,
    games: gamesOf(r.games),
    receipt: receiptAllowed({
      role: viewer.role,
      ownCard,
      status: r.status,
      hasInvoice: !!r.stripeInvoiceId,
      invoicedAt: r.closedAt,
      cardSince: since,
    }),
  }));
}

/** Everything the billing page and the settings card show about months. */
export async function loadMonthsSummary(
  orgId: string,
  p: {
    now: Date;
    plan: string;
    pricePence: number | null;
    role: string;
    viewerUserId: string;
    cardHolderUserId: string | null;
    take?: number;
  },
): Promise<MonthsSummary> {
  const [current, past, unpaid] = await Promise.all([
    loadCurrentMonth(orgId, p.now, { plan: p.plan, pricePence: p.pricePence }),
    loadPastMonths(orgId, { role: p.role, userId: p.viewerUserId, cardHolderUserId: p.cardHolderUserId }, p.take),
    loadUnpaidSummary(orgId),
  ]);
  return { current, past, unpaid, retrying: billingRetriesOn() };
}

/**
 * A month's receipt for the billing contact: the Stripe invoice id, only
 * when `receiptAllowed` says this viewer may open it. The receipt route
 * then asks Stripe for the hosted page.
 */
export async function receiptInvoiceFor(
  orgId: string,
  monthId: string,
  viewer: { role: string; userId: string; cardHolderUserId: string | null },
): Promise<string | null> {
  const m = await db.clubBillingMonth.findUnique({
    where: { id: monthId },
    select: { orgId: true, status: true, stripeInvoiceId: true, closedAt: true },
  });
  if (!m || m.orgId !== orgId || !m.stripeInvoiceId) return null;
  const ownCard = viewer.cardHolderUserId !== null && viewer.cardHolderUserId === viewer.userId;
  const ok = receiptAllowed({
    role: viewer.role,
    ownCard,
    status: m.status,
    hasInvoice: true,
    invoicedAt: m.closedAt,
    cardSince: viewer.role === "contact" && ownCard ? await cardSince(orgId) : null,
  });
  return ok ? m.stripeInvoiceId : null;
}
