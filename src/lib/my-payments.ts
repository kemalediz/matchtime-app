/**
 * The DM Q&A's read of ONE player's own payments (Kemal, 2026-10-20).
 * The rules are in `my-payments-rules.ts`; this file only reads.
 *
 * It selects the asker's own Attendance rows and nothing else: no other
 * player's payment ever reaches the CONTEXT, so none can reach an answer.
 */
import { db } from "./db";
import { PAY_METHOD_SELECT } from "./payments";
import { collectsMatchFees, paymentMessagesOn, type PaymentFlags } from "./payment-messages";
import { feeFact, type FeeFact } from "./fee-fact";
import { guestPaygPence } from "./monthly-week-asks";
import { normaliseSquadMode } from "./squad-month-rules";
import { payCollectorName } from "./direct-payment";
import { buildPayLinkUrl } from "./pay-link";
import {
  MY_PAYMENTS_MAX_MATCHES,
  decideMyPayments,
  payableMatchIds,
  type MyPayments,
} from "./my-payments-rules";

export interface LoadedMyPayments {
  payments: MyPayments;
  /** matchId to the asker's pay link, for each match he still owes. */
  payLinks: Record<string, string>;
}

/** The upcoming match's amounts, as `dm-qa.ts` reads them with the match. */
export interface UpcomingFeeRow {
  matchId: string;
  /** `Match.feePerPlayer`: the collector's confirmed fee, or null. */
  matchFee: number | null;
  /** `Activity.feePerPlayer` and `Activity.feeSplitTotal`. */
  gameFee: number | null;
  splitTotal: boolean;
}

/** The match's one fee fact (fee-fact.ts). The PAYG price is read only
 *  where it can be the answer: a club that collects (the only one whose
 *  block shows the fee), on a monthly squad, with no confirmed fee yet. */
async function upcomingFeeFact(u: UpcomingFeeRow, org: { squadMode: string | null } & PaymentFlags): Promise<FeeFact> {
  const collection = collectsMatchFees(org);
  const paygPence = collection && u.matchFee == null && normaliseSquadMode(org.squadMode) === "monthly" ? await guestPaygPence(u.matchId) : null;
  return feeFact({ matchFee: u.matchFee, gameFee: u.gameFee, splitTotal: u.splitTotal, paygPence, collection });
}

export interface MyPaymentsArgs {
  orgId: string;
  userId: string;
  /** The upcoming match's fee amounts, as read with the match, or null
   *  without one. Made into its one fee fact here (slice B5, K3), where the
   *  club's payment switches and squad mode are read anyway. */
  upcoming: UpcomingFeeRow | null;
  now?: Date;
}

/** His own payments with their pay links, for the DM Q&A's CONTEXT. */
export async function loadMyPayments(args: MyPaymentsArgs): Promise<LoadedMyPayments | null> {
  const payments = await readMyPayments(args);
  if (!payments) return null;
  const payLinks: Record<string, string> = {};
  for (const matchId of payableMatchIds(payments)) {
    payLinks[matchId] = await buildPayLinkUrl(args.userId, matchId);
  }
  return { payments, payLinks };
}

/** His own payments, read only: no pay link is minted (2026-11-04, for
 *  the DM help's "has he a fee to settle?", dm-reply/route.ts). */
export async function readMyPayments(args: MyPaymentsArgs): Promise<MyPayments | null> {
  const org = await db.organisation.findUnique({
    where: { id: args.orgId },
    select: {
      paymentTrackingEnabled: true,
      paymentHolderId: true,
      paymentInstructions: true,
      squadMode: true,
      // Carries `paymentCollectionEnabled` (club summary B3).
      ...PAY_METHOD_SELECT,
    },
  });
  if (!org) return null;
  const tracked = paymentMessagesOn(org);
  const isCollector = org.paymentHolderId === args.userId;
  const rows =
    tracked && !isCollector
      ? await db.attendance.findMany({
          where: {
            // His own rows only: the privacy line (see the header).
            userId: args.userId,
            status: "CONFIRMED",
            match: {
              activity: { orgId: args.orgId },
              isHistorical: false,
              status: { not: "CANCELLED" },
              date: { lt: args.now ?? new Date() },
            },
          },
          select: {
            paidAt: true,
            feeWaivedAt: true,
            paymentMethod: true,
            directPendingAt: true,
            match: {
              select: {
                id: true,
                date: true,
                feePerPlayer: true,
                paymentLinksReleasedAt: true,
                activity: { select: { name: true } },
              },
            },
          },
          orderBy: { match: { date: "desc" } },
          take: MY_PAYMENTS_MAX_MATCHES,
        })
      : [];
  return decideMyPayments({
    userId: args.userId,
    org,
    collectorName: tracked && !isCollector ? await payCollectorName(org.paymentHolderId).catch(() => null) : null,
    upcomingFee: args.upcoming ? await upcomingFeeFact(args.upcoming, org) : null,
    rows: rows.map((r) => ({
      matchId: r.match.id,
      activityName: r.match.activity.name,
      date: r.match.date,
      fee: r.match.feePerPlayer,
      paymentLinksReleasedAt: r.match.paymentLinksReleasedAt,
      paidAt: r.paidAt,
      feeWaivedAt: r.feeWaivedAt,
      paymentMethod: r.paymentMethod,
      directPendingAt: r.directPendingAt,
    })),
  });
}
