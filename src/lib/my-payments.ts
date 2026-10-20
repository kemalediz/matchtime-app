/**
 * The DM Q&A's read of ONE player's own payments (Kemal, 2026-10-20).
 * The rules are in `my-payments-rules.ts`; this file only reads.
 *
 * It selects the asker's own Attendance rows and nothing else: no other
 * player's payment ever reaches the CONTEXT, so none can reach an answer.
 */
import { db } from "./db";
import { PAY_METHOD_SELECT } from "./payments";
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

export async function loadMyPayments(args: {
  orgId: string;
  userId: string;
  /** The upcoming match's fee (or its format's usual one), or null. */
  upcomingFee: number | null;
  now?: Date;
}): Promise<LoadedMyPayments | null> {
  const org = await db.organisation.findUnique({
    where: { id: args.orgId },
    select: {
      paymentTrackingEnabled: true,
      paymentCollectionEnabled: true,
      paymentHolderId: true,
      paymentInstructions: true,
      squadMode: true,
      ...PAY_METHOD_SELECT,
    },
  });
  if (!org) return null;
  const tracked = org.paymentTrackingEnabled || org.paymentCollectionEnabled;
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
  const payments = decideMyPayments({
    userId: args.userId,
    org,
    collectorName: tracked && !isCollector ? await payCollectorName(org.paymentHolderId).catch(() => null) : null,
    upcomingFee: args.upcomingFee,
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
  const payLinks: Record<string, string> = {};
  for (const matchId of payableMatchIds(payments)) {
    payLinks[matchId] = await buildPayLinkUrl(args.userId, matchId);
  }
  return { payments, payLinks };
}
