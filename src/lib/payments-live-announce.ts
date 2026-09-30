/**
 * ONE GROUP POST WHEN A CLUB'S PAYMENT COLLECTION GOES LIVE (2026-09-30).
 *
 * Kemal: when a club switches payments on, post one announcement that
 * explains how it works, so players are not surprised by the first pay
 * link. "Live" is BOTH switches, because nothing can be charged until
 * both are on (the schema's own words on `paymentCollectionEnabled`):
 *
 *   - `paymentCollectionEnabled`, the organiser's toggle in settings
 *     (`setOrgFeature("paymentCollection")`), and
 *   - a connected Stripe account that can take charges
 *     (`stripeChargesEnabled`, written by `refreshCollectorStatus`).
 *
 * Whichever happens SECOND is the activation. Both call sites read the
 * org's state before their write and hand it here as `wasLive`, so a
 * club that was already live is never told again: `refreshCollectorStatus`
 * runs on every settings page load, and Sutton FC has been live since
 * 2026-06-09.
 *
 * Idempotent on top of that: a `SentNotification` row keyed on the org
 * AND the connected account is claimed before the post (the
 * squad-announce pattern, first writer wins), so a double click, a
 * concurrent page load or a toggle off and back on with the same account
 * posts nothing. A NEW connected account (the collector reset and
 * reconnected) is a new activation and is announced once.
 *
 * Never throws: an announcement must not fail the settings action that
 * caused it.
 */
import { db } from "@/lib/db";
import { t } from "@/lib/i18n/t";
import { normaliseLang, type Lang } from "@/lib/i18n/lang";

export const PAYMENTS_LIVE_KIND = "payments-live";

export interface PaymentLiveFields {
  paymentCollectionEnabled: boolean;
  stripeConnectAccountId: string | null;
  stripeChargesEnabled: boolean;
}

/** Can this club actually be charged right now? */
export function isPaymentCollectionLive(org: PaymentLiveFields | null | undefined): boolean {
  return !!org && org.paymentCollectionEnabled && !!org.stripeConnectAccountId && org.stripeChargesEnabled;
}

/** The ledger key: one announcement per org per connected account. */
export function paymentsLiveKey(orgId: string, accountId: string): string {
  return `org-${orgId}:${PAYMENTS_LIVE_KIND}:${accountId}`;
}

export function buildPaymentsLiveAnnouncement(args: {
  lang: Lang;
  collector: string | null;
  card: boolean;
  bank: boolean;
  direct: boolean;
}): string {
  return t(args.lang).payments_live_announcement({
    collector: args.collector,
    card: args.card,
    bank: args.bank,
    direct: args.direct,
  });
}

/** The state `wasLive` should be computed from, read before a write. */
export async function readPaymentLiveState(orgId: string): Promise<boolean> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { paymentCollectionEnabled: true, stripeConnectAccountId: true, stripeChargesEnabled: true },
  });
  return isPaymentCollectionLive(org);
}

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

export type PaymentsLiveResult =
  | { announced: true }
  | {
      announced: false;
      reason: "was-already-live" | "not-live" | "no-group" | "already-announced" | "error";
    };

export async function announcePaymentsLiveIfJustLive(
  orgId: string,
  opts: { wasLive: boolean },
): Promise<PaymentsLiveResult> {
  try {
    if (opts.wasLive) return { announced: false, reason: "was-already-live" };
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        language: true,
        whatsappGroupId: true,
        whatsappBotEnabled: true,
        paymentCollectionEnabled: true,
        stripeConnectAccountId: true,
        stripeChargesEnabled: true,
        payMethodCard: true,
        payMethodPayByBank: true,
        payMethodDirect: true,
        paymentHolderId: true,
      },
    });
    if (!org || !isPaymentCollectionLive(org)) return { announced: false, reason: "not-live" };
    // No group to speak in, or the bot is switched off for it: say
    // nothing and leave the key unspent, so the club is told when it is.
    if (!org.whatsappGroupId || !org.whatsappBotEnabled) return { announced: false, reason: "no-group" };

    try {
      await db.sentNotification.create({
        data: { key: paymentsLiveKey(orgId, org.stripeConnectAccountId!), kind: PAYMENTS_LIVE_KIND },
      });
    } catch {
      return { announced: false, reason: "already-announced" };
    }

    const holder = org.paymentHolderId
      ? await db.user.findUnique({ where: { id: org.paymentHolderId }, select: { name: true } })
      : null;
    const text = buildPaymentsLiveAnnouncement({
      lang: normaliseLang(org.language),
      collector: firstName(holder?.name),
      card: org.payMethodCard,
      bank: org.payMethodPayByBank,
      direct: org.payMethodDirect,
    });
    await db.botJob.create({ data: { orgId, kind: "group", text } });
    return { announced: true };
  } catch (err) {
    console.error(`[payments-live] announcement for ${orgId} failed:`, err);
    return { announced: false, reason: "error" };
  }
}
