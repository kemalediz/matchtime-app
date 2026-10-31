/**
 * THE MATCH A FRIEND LINK IS FOR, LOADED (2026-10-31). Thin I/O: the club,
 * the kick-off, the venue and the fee a guest pays, read the way the pool
 * offer reads them (`pool/offer-facts.ts` `poolFeeOf`, the monthly PAYG
 * price from `monthly-week-asks.ts`, PR #462), but for ANY sport: a friend
 * link is the club's own game, not a pool offer, so it never needs a pool
 * sport. Also the facts `friendLinkState` decides on.
 */
import { db } from "../db";
import { guestPaygPence } from "../monthly-week-asks";
import { poolFeeOf } from "../pool/offer-facts";
import type { PoolFee } from "../pool/offer-copy";

export interface FriendMatchFacts {
  matchId: string;
  orgId: string;
  club: string;
  language: string;
  kickoff: Date;
  status: string;
  isHistorical: boolean;
  venue: string | null;
  address: string | null;
  fee: PoolFee;
  /** The fee is the club's pay-as-you-go price (a running month). */
  monthly: boolean;
  benchPickMode: string | null;
}

export async function loadFriendMatchFacts(matchId: string): Promise<FriendMatchFacts | null> {
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      feePerPlayer: true,
      activity: {
        select: {
          orgId: true,
          venue: true,
          feePerPlayer: true,
          feeSplitTotal: true,
          venueRef: { select: { name: true, formattedAddress: true } },
          org: { select: { name: true, language: true, benchPickMode: true, paymentCollectionEnabled: true, paymentTrackingEnabled: true } },
        },
      },
    },
  });
  if (!m) return null;
  const a = m.activity;
  const monthlyPaygPence = await guestPaygPence(matchId);
  return {
    matchId: m.id,
    orgId: a.orgId,
    club: a.org.name,
    language: a.org.language,
    kickoff: m.date,
    status: m.status,
    isHistorical: m.isHistorical,
    venue: a.venueRef?.name ?? a.venue ?? null,
    address: a.venueRef?.formattedAddress ?? null,
    fee: poolFeeOf({
      matchFee: m.feePerPlayer,
      activityFee: a.feePerPlayer,
      feeSplitTotal: a.feeSplitTotal,
      paymentsOn: a.org.paymentCollectionEnabled || a.org.paymentTrackingEnabled,
      monthlyPaygPence,
    }),
    monthly: monthlyPaygPence != null && m.feePerPlayer == null,
    benchPickMode: a.org.benchPickMode,
  };
}
