/**
 * CLUB FEE BILLING, slice B4: the messages. Who is told what, and when.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.5, 6, 7.
 *
 *   sendScheduledBillingDms   day 21, day 28, day 30 and "paused", to the
 *                             billing contact (the money collector, else the
 *                             owner), from the hourly cron
 *   sendClubFeeTip            the club fee tip to the club's ADMINS through
 *                             their own admin channel, once per free month,
 *                             skipped when that would reach only the contact
 *   onBillingContactChanged   "payer changed", once, to a new collector
 *                             (called by `setPaymentHolder`)
 *   notePaymentProblem        a failed payment or a bank check (3DS), noted
 *                             by the billing webhook
 *   flushPendingBillingDms    sends what was noted, after checking it is
 *                             still true
 *   sendMonthCharged          slice P3: the month's receipt once its invoice
 *                             is PAID (from the webhook, and the cron)
 *   sendMonthDms              slice P3, the hourly cron: every recent paid
 *                             month's receipt and the FIRST month in a row
 *                             with no games ("nothing to pay"), once each
 *
 * ── Rules every message here keeps ───────────────────────────────────
 *   - DAYTIME ONLY: 10:00 to 20:00 London. A DM that becomes due at night
 *     is not queued for later: it is noted as PENDING (or simply not due
 *     yet) and the hourly cron's daytime run checks it is still true and
 *     sends it. So nobody is told "your free month has ended, add a card"
 *     at 10:00 after adding one at 07:00.
 *   - ONCE: every DM is claimed in `BillingNotice(orgId, kind, cycleKey)`
 *     before it is queued (`queueBillingDm`, the only queuer of purpose
 *     "billing").
 *   - TO THE BILLING CONTACT, resolved when the DM is queued, never stored.
 *     A personal signed-in link (9 days, `BILLING_LINK_TTL`) goes only to
 *     that person's own phone. Nobody: no DM, recorded on /admin/health.
 *   - NEVER THE PLATFORM OWNER for anything routine: no `queueOwnerDm`
 *     here; problems go to /admin/health (`recordOpsEvent`).
 *   - Skipped entirely with BILLING_ENABLED off, and for a club that is
 *     suspended, not approved, exempt, or predates self-join.
 */
import { db } from "./db";
import { isClubApproved } from "./club-approval-state";
import { buildAdminLink } from "./admin-link";
import { loadAdminChannel, sendAdminNotice } from "./admin-channel";
import { resolveAdminNoticeTargets } from "./admin-channel-rules";
import { CLAIM_STALE_MS, loadClubFeeTip, queueBillingDm, type BillingNoticeKind } from "./club-billing";
import {
  BILLING_LINK_TTL,
  STANDARD_PRICE_PENCE,
  billingContact,
  isBillingEnabled,
  planPricePence,
  type BillingContact,
} from "./club-billing-rules";
import {
  MONTH_DM_MAX_AGE_MS,
  PAYMENT_FAILED_HOLD_MS,
  PENDING_BILLING_DM_MAX_AGE_MS,
  billingDmsDue,
  feeTipDue,
  isBillingDmHour,
  monthDmFresh,
  type DueDm,
  type ScheduleClub,
} from "./club-billing-schedule-rules";
import {
  feeTipAdminText,
  monthChargedText,
  monthFreeText,
  paymentActionText,
  paymentFailedText,
  pausedText,
  payerChangedText,
  trialEndedText,
  trialReminderText,
} from "./club-billing-view";
import { BILLING_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { getBillingStripe } from "./stripe-billing";

/** The pending kinds this file sends (B3's "resumed" and "plan-billed"
 *  are sent by `flushPendingBillingNotices` in club-billing-stripe.ts). */
const PENDING_KINDS = ["payment-failed", "payment-action", "payer-changed"] as const;
type PendingKind = (typeof PENDING_KINDS)[number];

/** Where the admin tip's "choose a collector" line points. */
const COLLECTOR_SETTINGS_PATH = "/admin/settings#payments";

// ── Loading one club ────────────────────────────────────────────────────

async function loadDmClub(orgId: string) {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      language: true,
      approvalStatus: true,
      approvedAt: true,
      billingStatus: true,
      billingPlan: true,
      billingPricePence: true,
      paymentHolderId: true,
      memberships: {
        orderBy: { createdAt: "asc" },
        select: { userId: true, role: true, leftAt: true, user: { select: { name: true, phoneNumber: true } } },
      },
      clubBilling: {
        select: {
          trialEndsAt: true,
          graceEndsAt: true,
          currentPeriodEnd: true,
          pausedAt: true,
          pausedReason: true,
          paymentFailedAt: true,
          cardHolderUserId: true,
          stripePaymentMethodId: true,
          cardLast4: true,
        },
      },
    },
  });
  if (!org) return null;
  const members = org.memberships.map((m) => ({
    userId: m.userId,
    role: m.role as string,
    leftAt: m.leftAt,
    phoneNumber: m.user.phoneNumber,
    name: m.user.name,
  }));
  const contact = billingContact({ paymentHolderId: org.paymentHolderId }, members);
  return {
    id: org.id,
    name: org.name,
    language: org.language,
    approved: isClubApproved(org),
    approvedAt: org.approvedAt,
    status: org.billingStatus,
    pricePence: planPricePence(org.billingPlan, org.billingPricePence) ?? STANDARD_PRICE_PENCE,
    billing: org.clubBilling,
    members,
    contact,
  };
}

type DmClub = NonNullable<Awaited<ReturnType<typeof loadDmClub>>>;

/** Billed, approved, self-join, and the flag on: the only clubs told anything. */
function isMessageable(club: DmClub | null): club is DmClub & { billing: NonNullable<DmClub["billing"]> } {
  return (
    !!club &&
    isBillingEnabled() &&
    club.approved &&
    club.approvedAt !== null &&
    club.status !== "exempt" &&
    club.billing !== null
  );
}

function scheduleClubOf(club: DmClub & { billing: NonNullable<DmClub["billing"]> }): ScheduleClub {
  return {
    status: club.status,
    trialEndsAt: club.billing.trialEndsAt,
    graceEndsAt: club.billing.graceEndsAt,
    pausedAt: club.billing.pausedAt,
    pausedReason: club.billing.pausedReason,
  };
}

function billingLink(userId: string, orgId: string): Promise<string> {
  return buildAdminLink({ userId, orgId, nextPath: `/billing/${orgId}`, ttlSeconds: BILLING_LINK_TTL });
}

async function nameOf(club: DmClub, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const m = club.members.find((x) => x.userId === userId);
  if (m) return m.name;
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? null;
}

async function noContact(orgId: string, kind: string, cycleKey: string): Promise<void> {
  console.warn(`[club-billing-dms] ${orgId}: ${kind} not sent, no billing contact (no collector or owner with a phone)`);
  await recordOpsEvent({
    orgId,
    kind: BILLING_ALERT_KIND,
    severity: "warning",
    title: "No billing contact for a club fee message",
    detail: `The "${kind}" message could not be sent: the club has no money collector or owner with a phone number.`,
    dedupeKey: `no-contact:${kind}:${cycleKey}`,
  }).catch(() => undefined);
}

// ── Claims (for the admin tip, which is not a platform DM) ──────────────

const CLAIM_PREFIX = "claimed:";

/** Claim a `BillingNotice` row, as `queueBillingDm` does: a new row, a
 *  pending one, or a stale claim. Returns the claim token, or null when it
 *  is someone else's or already done. */
async function claimNotice(orgId: string, kind: BillingNoticeKind, cycleKey: string): Promise<string | null> {
  const where = { orgId, kind, cycleKey };
  const claim = `${CLAIM_PREFIX}${new Date().toISOString()}`;
  try {
    await db.billingNotice.create({ data: { ...where, platformJobId: claim }, select: { id: true } });
    return claim;
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
  const row = await db.billingNotice.findFirst({ where, select: { platformJobId: true } });
  const current = row?.platformJobId ?? null;
  const stale =
    !!current?.startsWith(CLAIM_PREFIX) && Date.now() - Date.parse(current.slice(CLAIM_PREFIX.length)) > CLAIM_STALE_MS;
  if (row && (current === null || stale)) {
    const { count } = await db.billingNotice.updateMany({ where: { ...where, platformJobId: current }, data: { platformJobId: claim } });
    if (count === 1) return claim;
  }
  return null;
}

async function settleClaim(orgId: string, kind: BillingNoticeKind, cycleKey: string, claim: string, value: string | null) {
  await db.billingNotice.updateMany({ where: { orgId, kind, cycleKey, platformJobId: claim }, data: { platformJobId: value } });
}

/** Never send this pending row (only a still-pending row is touched). */
async function skipPending(orgId: string, kind: string, cycleKey: string, why: string): Promise<void> {
  await db.billingNotice.updateMany({ where: { orgId, kind, cycleKey, platformJobId: null }, data: { platformJobId: `skipped:${why}` } });
  console.log(`[club-billing-dms] ${orgId}: pending ${kind} (${cycleKey}) not sent: ${why}`);
}

/** Did this notice reach someone (a real job, not skipped or mid-claim)? */
async function wasDelivered(orgId: string, kind: BillingNoticeKind, cycleKey: string): Promise<boolean> {
  const row = await db.billingNotice.findFirst({ where: { orgId, kind, cycleKey }, select: { platformJobId: true } });
  const v = row?.platformJobId ?? null;
  return v !== null && !v.startsWith("skipped:") && !v.startsWith(CLAIM_PREFIX);
}

// ── Day 21, 28, 30 and paused ───────────────────────────────────────────

/**
 * The billing contact's scheduled DM for this club, if one is due now
 * (`billingDmsDue`): nothing at night, nothing twice.
 */
export async function sendScheduledBillingDms(orgId: string, now: Date = new Date()): Promise<string[]> {
  const club = await loadDmClub(orgId);
  if (!isMessageable(club)) return [];
  const trialKey = club.billing.trialEndsAt.toISOString();
  const due = billingDmsDue(scheduleClubOf(club), now, { trial21Delivered: await wasDelivered(orgId, "trial-21", trialKey) });
  const sent: string[] = [];
  for (const dm of due) {
    const r = await sendOneScheduled(club, dm);
    sent.push(`${dm.kind}:${r}`);
  }
  return sent;
}

async function sendOneScheduled(club: DmClub & { billing: NonNullable<DmClub["billing"]> }, dm: DueDm): Promise<string> {
  const contact = club.contact;
  if (!contact) {
    await noContact(club.id, dm.kind, dm.cycleKey);
    return "no-contact";
  }
  const lang = club.language;
  const link = await billingLink(contact.userId, club.id);
  let text: (u: { name: string | null }) => string;
  switch (dm.kind) {
    case "trial-21":
    case "trial-28": {
      const tip = dm.withTip ? await loadClubFeeTip(club.id) : null;
      text = ({ name }) =>
        trialReminderText(lang, {
          kind: dm.kind as "trial-21" | "trial-28",
          name,
          club: club.name,
          trialEndsAt: club.billing.trialEndsAt,
          pricePence: club.pricePence,
          link,
          via: contact.via,
          tip,
        });
      break;
    }
    case "trial-ended":
      text = ({ name }) =>
        trialEndedText(lang, { name, club: club.name, graceEndsAt: club.billing.graceEndsAt!, pricePence: club.pricePence, link, via: contact.via });
      break;
    case "paused": {
      const reason = club.billing.pausedReason;
      if (reason !== "no-card" && reason !== "payment-failed" && reason !== "cancelled") return "no-reason";
      // Slice P3: what could not be taken is the unpaid month's charge.
      const unpaid = reason === "payment-failed" ? await latestUnpaidMonth(club.id) : null;
      const amountPence = unpaid?.amountPence ?? club.pricePence;
      text = ({ name }) => pausedText(lang, { name, club: club.name, amountPence, reason, link });
      break;
    }
  }
  return queueBillingDm({ orgId: club.id, kind: dm.kind, cycleKey: dm.cycleKey, userId: contact.userId, text });
}

// ── The club fee tip through the admin channel (7.1, 7.2 point 3) ───────

export type FeeTipResult = "off" | "not-billed" | "not-due" | "no-tip" | "already" | "skipped-only-contact" | "sent";

/**
 * The club fee tip to the club's admins, once per free month, through the
 * club's own admin channel (`sendAdminNotice`: one person, the admin group,
 * or each admin). Claimed first in `BillingNotice(orgId, "fee-tip",
 * trialEndsAt)`.
 *
 * Skipped (and never tried again) when the admin channel would reach only
 * the billing contact, who already has the tip in their card DM: "one
 * person" resolving to them, the common new club case. In "each admin"
 * mode the contact is left out of the DMs (`excludeUserId`); an admin
 * group's members cannot be seen by the server, so a contact who is in it
 * may read the tip twice (decision 17).
 */
export async function sendClubFeeTip(orgId: string, now: Date = new Date()): Promise<FeeTipResult> {
  if (!isBillingEnabled()) return "off";
  const club = await loadDmClub(orgId);
  if (!isMessageable(club)) return "not-billed";
  const due = feeTipDue(scheduleClubOf(club), now);
  if (!due) return "not-due";
  const tip = await loadClubFeeTip(orgId);
  if (!tip) return "no-tip";

  const claim = await claimNotice(orgId, "fee-tip", due.cycleKey);
  if (!claim) return "already";
  try {
    const ch = await loadAdminChannel(orgId);
    const contactId = club.contact?.userId ?? null;
    const toGroup = !!ch && ch.cfg.mode === "admin-group" && !!ch.cfg.adminGroupId;
    if (!ch || !toGroup) {
      const target = ch ? resolveAdminNoticeTargets(ch.cfg, ch.admins, { adminGroup: false }) : null;
      const others = target?.kind === "dm" ? target.users.filter((u) => u.id !== contactId) : [];
      if (others.length === 0) {
        await settleClaim(orgId, "fee-tip", due.cycleKey, claim, "skipped:only-contact");
        console.log(`[club-billing-dms] ${orgId}: admin fee tip skipped, the admin channel reaches only the billing contact`);
        return "skipped-only-contact";
      }
    }
    const noCollector = club.contact?.via !== "collector";
    const sent = await sendAdminNotice({
      orgId,
      now,
      nextPath: noCollector ? COLLECTOR_SETTINGS_PATH : null,
      excludeUserId: contactId,
      text: (link) => feeTipAdminText(club.language, tip, { noCollector, link }),
    });
    await settleClaim(orgId, "fee-tip", due.cycleKey, claim, `admin-channel:${sent.channel}:${sent.queued}`);
    console.log(`[club-billing-dms] ${orgId}: admin fee tip sent (${sent.channel}, ${sent.queued})`);
    return "sent";
  } catch (err) {
    await settleClaim(orgId, "fee-tip", due.cycleKey, claim, null).catch(() => undefined);
    throw err;
  }
}

// ── A new money collector (4.5 point 2) ─────────────────────────────────

/** Why "payer changed" would not go now, or null when it should. */
function payerChangedRefusal(club: DmClub | null, userId: string): string | null {
  if (!isMessageable(club)) return "not-billed";
  if (club.contact?.via !== "collector" || club.contact.userId !== userId) return "not-current";
  if (club.billing.cardHolderUserId === userId) return "own-card";
  return null;
}

async function sendPayerChanged(club: DmClub & { billing: NonNullable<DmClub["billing"]> }, userId: string) {
  const b = club.billing;
  const holder = b.cardHolderUserId;
  // Somebody else's card is still on file and keeps paying (slice P2: a
  // card on file, not a live subscription).
  const oldName = holder && holder !== userId && b.stripePaymentMethodId ? await nameOf(club, holder) : null;
  const state: "card" | "no-card" | "paused" | "removed" =
    club.status === "paused" ? (b.pausedReason === "removed" ? "removed" : "paused") : oldName ? "card" : "no-card";
  const date =
    club.status === "trial" ? b.trialEndsAt : club.status === "grace" || club.status === "past_due" ? (b.graceEndsAt ?? b.trialEndsAt) : (b.currentPeriodEnd ?? b.trialEndsAt);
  const tip = await loadClubFeeTip(club.id);
  const link = await billingLink(userId, club.id);
  return queueBillingDm({
    orgId: club.id,
    kind: "payer-changed",
    cycleKey: userId,
    userId,
    text: ({ name }) => payerChangedText(club.language, { name, club: club.name, pricePence: club.pricePence, link, state, oldName, date, tip }),
  });
}

/**
 * Called by `setPaymentHolder` after a new money collector is saved. For a
 * billed club, the new collector gets ONE DM (claimed by their user id, so
 * changing back and forth never repeats a DELIVERED one; a skipped one is
 * re-opened by the next real change): they now look after the card.
 * At night it is kept pending for the 10:00 run, which sends it only if
 * they are still the collector. Never throws into the caller's action.
 */
export async function onBillingContactChanged(orgId: string, now: Date = new Date()): Promise<string> {
  try {
    if (!isBillingEnabled()) return "skipped:off";
    const club = await loadDmClub(orgId);
    if (!isMessageable(club)) return "skipped:not-billed";
    const userId = club.contact?.via === "collector" ? club.contact.userId : null;
    if (!userId) return "skipped:no-collector";
    const refusal = payerChangedRefusal(club, userId);
    if (refusal) return `skipped:${refusal}`;
    // A notice for this person that was SKIPPED (not current any more when
    // it came to be sent, no phone then, too old) never reached them: this
    // real change re-opens it, with a fresh age. One that was delivered
    // stays delivered, so changing back and forth never repeats it.
    const reopened = await db.billingNotice.updateMany({
      where: { orgId, kind: "payer-changed", cycleKey: userId, platformJobId: { startsWith: "skipped:" } },
      data: { platformJobId: null, createdAt: now },
    });
    if (!isBillingDmHour(now)) {
      const { count } = await db.billingNotice.createMany({
        data: [{ orgId, kind: "payer-changed", cycleKey: userId, createdAt: now }],
        skipDuplicates: true,
      });
      return count === 1 || reopened.count === 1 ? "pending" : "already";
    }
    return await sendPayerChanged(club, userId);
  } catch (err) {
    console.error(`[club-billing-dms] ${orgId}: payer-changed DM failed:`, err);
    return "error";
  }
}

// ── Payment problems (5.3) ──────────────────────────────────────────────

/**
 * The billing webhook saw `invoice.payment_failed` ("payment-failed") or
 * `invoice.payment_action_required` ("payment-action", a bank check, 3DS)
 * for a club's invoice, AFTER syncing the subscription. Noted as a PENDING
 * notice, once per invoice and kind.
 *
 *   - "payment-action" in the daytime is sent at once, with the invoice's
 *     own Stripe page (where the check is done);
 *   - "payment-failed" always waits for the cron (at least 30 minutes), so
 *     that when the same invoice also needs a bank check only that DM goes.
 *
 * Never throws: the note is written first, and the cron sends what is left.
 */
export async function notePaymentProblem(args: {
  orgId: string;
  invoiceId: string;
  kind: "payment-failed" | "payment-action";
  hostedUrl: string | null;
  now?: Date;
}): Promise<string> {
  const now = args.now ?? new Date();
  try {
    if (!isBillingEnabled()) return "off";
    const club = await loadDmClub(args.orgId);
    if (!isMessageable(club)) return "not-billed";
    const ok = args.kind === "payment-failed" ? club.status === "past_due" : club.status === "past_due" || club.status === "subscribed";
    if (!ok) return "not-current";
    await db.billingNotice.createMany({
      data: [{ orgId: args.orgId, kind: args.kind, cycleKey: args.invoiceId, createdAt: now }],
      skipDuplicates: true,
    });
    if (args.kind === "payment-action" && args.hostedUrl && club.contact && isBillingDmHour(now)) {
      return await sendPaymentAction(club, args.invoiceId, args.hostedUrl);
    }
    return "pending";
  } catch (err) {
    console.error(`[club-billing-dms] ${args.orgId}: noting ${args.kind} for ${args.invoiceId} failed:`, err);
    return "error";
  }
}

/** The billing month an invoice charges (slice P3): its dates and amount
 *  for the payment DMs. Null when no month of the club carries it. */
async function monthOfInvoice(orgId: string, invoiceId: string) {
  const m = await db.clubBillingMonth.findFirst({
    where: { orgId, stripeInvoiceId: invoiceId },
    select: { id: true, startsAt: true, endsAt: true, amountPence: true },
  });
  return m && m.amountPence !== null ? { ...m, amountPence: m.amountPence } : null;
}

/** The club's latest month whose charge is still owed (slice P3). */
async function latestUnpaidMonth(orgId: string) {
  return db.clubBillingMonth.findFirst({
    where: { orgId, status: { in: ["failed", "invoiced"] }, amountPence: { not: null } },
    orderBy: { index: "desc" },
    select: { amountPence: true },
  });
}

async function sendPaymentAction(club: DmClub & { billing: NonNullable<DmClub["billing"]> }, invoiceId: string, hostedUrl: string) {
  const contact = club.contact!;
  const holder = club.billing.cardHolderUserId;
  const ownCard = holder === null || holder === contact.userId;
  const month = await monthOfInvoice(club.id, invoiceId);
  if (!month) return "no-month";
  const billingLinkUrl = ownCard ? "" : await billingLink(contact.userId, club.id);
  return queueBillingDm({
    orgId: club.id,
    kind: "payment-action",
    cycleKey: invoiceId,
    userId: contact.userId,
    text: ({ name }) =>
      paymentActionText(club.language, {
        name,
        club: club.name,
        amountPence: month.amountPence,
        startsAt: month.startsAt,
        endsAt: month.endsAt,
        link: hostedUrl,
        ownCard,
        billingLink: billingLinkUrl,
      }),
  });
}

async function sendPaymentFailed(club: DmClub & { billing: NonNullable<DmClub["billing"]> }, contact: BillingContact, invoiceId: string) {
  const month = await monthOfInvoice(club.id, invoiceId);
  if (!month) return "no-month";
  const link = await billingLink(contact.userId, club.id);
  const holder = club.billing.cardHolderUserId;
  const ownCard = holder === null || holder === contact.userId;
  return queueBillingDm({
    orgId: club.id,
    kind: "payment-failed",
    cycleKey: invoiceId,
    userId: contact.userId,
    text: ({ name }) =>
      paymentFailedText(club.language, {
        name,
        club: club.name,
        amountPence: month.amountPence,
        startsAt: month.startsAt,
        endsAt: month.endsAt,
        link,
        ownCard,
      }),
  });
}

/**
 * Send the club's PENDING payment and payer DMs that are still true, in the
 * daytime only. Each is checked against the club and Stripe RIGHT NOW:
 *
 *   expired       older than 3 days
 *   superseded    a failed payment whose invoice also needed a bank check
 *                 (that DM carries the link that matters)
 *   not-current   the club is no longer past due, the invoice is no longer
 *                 open, the collector changed again, or the club is no
 *                 longer billed
 *
 * A failed payment younger than 30 minutes is left for the next run. A
 * Stripe read that fails leaves the row pending for the next hour.
 */
export async function flushPendingBillingDms(orgId: string, now: Date = new Date()): Promise<number> {
  if (!isBillingEnabled() || !isBillingDmHour(now)) return 0;
  const rows = await db.billingNotice.findMany({
    where: { orgId, platformJobId: null, kind: { in: [...PENDING_KINDS] } },
    select: { kind: true, cycleKey: true, createdAt: true },
  });
  if (rows.length === 0) return 0;
  const club = await loadDmClub(orgId);
  let sent = 0;
  for (const row of rows) {
    const kind = row.kind as PendingKind;
    try {
      if (now.getTime() - row.createdAt.getTime() > PENDING_BILLING_DM_MAX_AGE_MS) {
        await skipPending(orgId, kind, row.cycleKey, "expired");
        continue;
      }
      if (!isMessageable(club)) {
        await skipPending(orgId, kind, row.cycleKey, "not-current");
        continue;
      }
      if (kind === "payer-changed") {
        const refusal = payerChangedRefusal(club, row.cycleKey);
        if (refusal) await skipPending(orgId, kind, row.cycleKey, "not-current");
        else if ((await sendPayerChanged(club, row.cycleKey)) === "queued") sent++;
        continue;
      }
      if (kind === "payment-failed") {
        if (now.getTime() - row.createdAt.getTime() < PAYMENT_FAILED_HOLD_MS) continue;
        const action = await db.billingNotice.findFirst({
          where: { orgId, kind: "payment-action", cycleKey: row.cycleKey },
          select: { platformJobId: true },
        });
        if (action) {
          await skipPending(orgId, kind, row.cycleKey, "superseded");
          continue;
        }
      }
      const statusOk = kind === "payment-failed" ? club.status === "past_due" : club.status === "past_due" || club.status === "subscribed";
      if (!statusOk) {
        await skipPending(orgId, kind, row.cycleKey, "not-current");
        continue;
      }
      const stripe = getBillingStripe();
      const invoice = stripe ? await stripe.retrieveInvoice(row.cycleKey) : undefined;
      if (stripe && (!invoice || invoice.status !== "open")) {
        await skipPending(orgId, kind, row.cycleKey, "not-current");
        continue;
      }
      if (!club.contact) {
        await noContact(orgId, kind, row.cycleKey);
        continue;
      }
      if (kind === "payment-action" && !invoice?.hostedInvoiceUrl) {
        await skipPending(orgId, kind, row.cycleKey, "no-link");
        continue;
      }
      const r =
        kind === "payment-action"
          ? await sendPaymentAction(club, row.cycleKey, invoice!.hostedInvoiceUrl!)
          : await sendPaymentFailed(club, club.contact, row.cycleKey);
      if (r === "no-month") await skipPending(orgId, kind, row.cycleKey, "no-month");
      else if (r === "queued") sent++;
    } catch (err) {
      console.error(`[club-billing-dms] ${orgId}: pending ${kind} (${row.cycleKey}) not sent yet:`, err);
    }
  }
  return sent;
}

// ── Slice P3 (games played): the month's receipt and "nothing to pay" ───

type MonthDmResult = "off" | "night" | "not-billed" | "not-found" | "not-paid" | "not-zero" | "stale" | "not-first" | "no-contact" | "queued" | "already" | "no-phone" | "refused";

/** The month a DM is about, with what the DM says. */
async function loadMonth(orgId: string, monthId: string) {
  const m = await db.clubBillingMonth.findUnique({
    where: { id: monthId },
    select: {
      id: true,
      orgId: true,
      index: true,
      startsAt: true,
      endsAt: true,
      status: true,
      scheduled: true,
      played: true,
      pricePence: true,
      priceAtStartPence: true,
      amountPence: true,
      closedAt: true,
      paidAt: true,
    },
  });
  return m && m.orgId === orgId ? m : null;
}

/**
 * The month's receipt (plan 7.3) to the billing contact, once the month's
 * invoice is PAID: "4 of 5 games played between 1 Nov and 30 Nov, GBP 7.99
 * charged". Only money actually taken: the month must be recorded paid.
 * ONCE per month (claimed by the month's id), 10:00 to 20:00 London only:
 * at night nothing is written and the hourly cron's daytime run sends it
 * (`sendMonthDms`), while the month is fresh (paid or closed in the last 3
 * days). Never to the platform owner.
 */
export async function sendMonthCharged(orgId: string, monthId: string, now: Date = new Date()): Promise<MonthDmResult> {
  if (!isBillingEnabled()) return "off";
  if (!isBillingDmHour(now)) return "night";
  const club = await loadDmClub(orgId);
  if (!isMessageable(club)) return "not-billed";
  const m = await loadMonth(orgId, monthId);
  if (!m) return "not-found";
  if (m.status !== "paid" || m.amountPence === null || m.played === null || m.scheduled === null) return "not-paid";
  if (!monthDmFresh(m, now)) return "stale";
  const contact = club.contact;
  if (!contact) {
    await noContact(orgId, "month-charged", monthId);
    return "no-contact";
  }
  const link = await billingLink(contact.userId, orgId);
  const holder = club.billing.cardHolderUserId;
  const ownCard = holder === null || holder === contact.userId;
  const amountPence = m.amountPence;
  const played = m.played;
  const scheduled = m.scheduled;
  return queueBillingDm({
    orgId,
    kind: "month-charged",
    cycleKey: monthId,
    userId: contact.userId,
    text: ({ name }) =>
      monthChargedText(club.language, {
        name,
        club: club.name,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        played,
        scheduled,
        amountPence,
        pricePence: m.pricePence ?? m.priceAtStartPence,
        last4: club.billing.cardLast4,
        ownCard,
        link,
      }),
  });
}

/**
 * "No games, nothing to pay" (plan 7.3) for a month closed as `no-games`,
 * only when it is the FIRST such month in a row: the club's month before it
 * was not also `no-games`, so a long summer break sends one DM, not one a
 * month. A later zero month is recorded as skipped and never sent. Once
 * per month, daytime only, while fresh.
 */
export async function sendMonthFree(orgId: string, monthId: string, now: Date = new Date()): Promise<MonthDmResult> {
  if (!isBillingEnabled()) return "off";
  if (!isBillingDmHour(now)) return "night";
  const club = await loadDmClub(orgId);
  if (!isMessageable(club)) return "not-billed";
  const m = await loadMonth(orgId, monthId);
  if (!m) return "not-found";
  if (m.status !== "no-games") return "not-zero";
  if (!monthDmFresh(m, now)) return "stale";
  // A paused club already knows MatchTime is off in its group; "nothing to
  // pay" would only confuse that.
  if (club.status === "paused") return "not-billed";
  const before = await db.clubBillingMonth.findFirst({
    where: { orgId, index: { lt: m.index } },
    orderBy: { index: "desc" },
    select: { status: true },
  });
  if (before?.status === "no-games") {
    await db.billingNotice.createMany({
      data: [{ orgId, kind: "month-free", cycleKey: monthId, platformJobId: "skipped:not-first", createdAt: now }],
      skipDuplicates: true,
    });
    return "not-first";
  }
  const contact = club.contact;
  if (!contact) {
    await noContact(orgId, "month-free", monthId);
    return "no-contact";
  }
  return queueBillingDm({
    orgId,
    kind: "month-free",
    cycleKey: monthId,
    userId: contact.userId,
    text: ({ name }) => monthFreeText(club.language, { name, club: club.name, startsAt: m.startsAt, endsAt: m.endsAt }),
  });
}

/**
 * The hourly cron's daytime step (slice P3): for every month of the club
 * paid or closed in the last 3 days, the receipt (paid) or "nothing to pay"
 * (no games), each at most once. The months a webhook paid at night, and
 * the ones the close paid on the spot, are all picked up here. Returns what
 * was queued, as "<kind>:<index>".
 */
export async function sendMonthDms(orgId: string, now: Date = new Date()): Promise<string[]> {
  if (!isBillingEnabled() || !isBillingDmHour(now)) return [];
  const since = new Date(now.getTime() - MONTH_DM_MAX_AGE_MS);
  const months = await db.clubBillingMonth.findMany({
    where: { orgId, status: { in: ["paid", "no-games"] }, OR: [{ closedAt: { gte: since } }, { paidAt: { gte: since } }] },
    orderBy: { index: "asc" },
    select: { id: true, index: true, status: true },
  });
  const sent: string[] = [];
  for (const m of months) {
    try {
      const r = m.status === "paid" ? await sendMonthCharged(orgId, m.id, now) : await sendMonthFree(orgId, m.id, now);
      if (r === "queued") sent.push(`${m.status === "paid" ? "month-charged" : "month-free"}:${m.index}`);
    } catch (err) {
      console.error(`[club-billing-dms] ${orgId}: month ${m.index} DM not sent yet:`, err);
    }
  }
  return sent;
}
