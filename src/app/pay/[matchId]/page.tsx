import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { availablePayMethods, priceMethods, gbp, PAY_METHOD_SELECT, type PayMethodSwitches } from "@/lib/payments";
import { payCollectorName } from "@/lib/direct-payment";
import { PayOptions } from "@/components/pay/pay-options";

export const dynamic = "force-dynamic";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ matchId: string }>;
  searchParams: Promise<{ paid?: string }>;
}) {
  const { matchId } = await params;
  const { paid } = await searchParams;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: {
        select: {
          name: true,
          org: {
            select: {
              name: true,
              paymentHolderId: true,
              ...PAY_METHOD_SELECT,
            },
          },
        },
      },
    },
  });
  if (!match) redirect("/");

  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { paidAt: true, directPendingAt: true, paymentMethod: true },
  });

  const me = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = me?.name?.split(" ")[0] ?? "there";
  const org = match.activity.org;
  // "Pay Raihan directly", as the pay link DM says. "the organiser" when
  // no collector name is on record.
  const collector = (await payCollectorName(org.paymentHolderId))?.split(" ")[0] ?? null;
  const collectorLabel = collector ?? "the organiser";

  // Monthly squad (slice 5): a regular's place is paid for by the month.
  // No pay buttons, so the "monthly" mark on their row cannot be replaced
  // by a per-match method (the actions refuse it too, `payBlockedReason`).
  if (attendance?.paymentMethod === "monthly" && !attendance.paidAt) {
    return (
      <Shell>
        <div className="text-center" data-testid="pay-monthly">
          <div className="text-5xl mb-3">📋</div>
          <h1 className="text-xl font-bold text-slate-900">Nothing to pay for this match</h1>
          <p className="text-sm text-slate-500 mt-2">
            {first}, your place for {match.activity.name} is paid for by the month. If that&apos;s not right, speak to the
            organiser.
          </p>
        </div>
      </Shell>
    );
  }

  // Already paid (or returned from a successful Stripe checkout).
  if (attendance?.paidAt || paid === "1") {
    return (
      <Shell>
        <div className="text-center">
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-slate-900">You&apos;re all paid</h1>
          <p className="text-sm text-slate-500 mt-2">
            Thanks {first}, your fee for {match.activity.name} is settled.
          </p>
        </div>
      </Shell>
    );
  }

  // Chose "pay directly", awaiting the collector's confirmation.
  if (attendance?.directPendingAt && attendance.paymentMethod === "direct") {
    return (
      <Shell>
        <div className="text-center">
          <div className="text-5xl mb-3">🤝</div>
          <h1 className="text-xl font-bold text-slate-900">Paying {collectorLabel} directly</h1>
          <p className="text-sm text-slate-500 mt-2">
            Noted, {first}. {collector ?? "The organiser"} will confirm once they&apos;ve received it.
            {availablePayMethods(org).length > 1 ? " Changed your mind? Pick another method below." : ""}
          </p>
        </div>
        {match.feePerPlayer != null && (
          <Methods matchId={matchId} base={match.feePerPlayer} org={org} collector={collector} />
        )}
      </Shell>
    );
  }

  if (match.feePerPlayer == null) {
    return (
      <Shell>
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-900">No fee set yet</h1>
          <p className="text-sm text-slate-500 mt-2">
            The organiser hasn&apos;t set the fee for {match.activity.name} yet. Check back shortly.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="text-center mb-5">
        <p className="text-xs uppercase tracking-wider text-slate-400">{org.name}</p>
        <h1 className="text-xl font-bold text-slate-900 mt-1">{match.activity.name}</h1>
        <p className="text-sm text-slate-500 mt-1">
          Match fee: <span className="font-semibold text-slate-800">{gbp(match.feePerPlayer)}</span>
        </p>
      </div>
      <Methods matchId={matchId} base={match.feePerPlayer} org={org} collector={collector} />
    </Shell>
  );
}

function Methods({
  matchId,
  base,
  org,
  collector,
}: {
  matchId: string;
  base: number;
  org: PayMethodSwitches;
  collector: string | null;
}) {
  // The one availability rule, shared with the pay link DM and the chase
  // (card/bank only once the collector's Stripe account can take charges).
  const prices = priceMethods(base, availablePayMethods(org), collector);
  return <PayOptions matchId={matchId} prices={prices} collector={collector} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-5 bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
        {children}
      </div>
    </div>
  );
}
