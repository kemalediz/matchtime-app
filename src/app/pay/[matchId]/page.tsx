import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { priceMethods, gbp, type PayMethod } from "@/lib/payments";
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
              payMethodPayByBank: true,
              payMethodCard: true,
              payMethodDirect: true,
              stripeChargesEnabled: true,
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

  // Already paid (or returned from a successful Stripe checkout).
  if (attendance?.paidAt || paid === "1") {
    return (
      <Shell>
        <div className="text-center">
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-slate-900">You&apos;re all paid</h1>
          <p className="text-sm text-slate-500 mt-2">
            Thanks {first} — your fee for {match.activity.name} is settled.
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
          <h1 className="text-xl font-bold text-slate-900">Paying the organiser directly</h1>
          <p className="text-sm text-slate-500 mt-2">
            Noted, {first}. The organiser will confirm once they&apos;ve received it. Changed your
            mind? Pick another method below.
          </p>
        </div>
        {match.feePerPlayer != null && (
          <Methods matchId={matchId} base={match.feePerPlayer} org={org} />
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
            The organiser hasn&apos;t set the fee for {match.activity.name} yet — check back shortly.
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
      <Methods matchId={matchId} base={match.feePerPlayer} org={org} />
    </Shell>
  );
}

function Methods({
  matchId,
  base,
  org,
}: {
  matchId: string;
  base: number;
  org: {
    payMethodPayByBank: boolean;
    payMethodCard: boolean;
    payMethodDirect: boolean;
    stripeChargesEnabled: boolean;
  };
}) {
  const enabled: PayMethod[] = [];
  // Card/bank only offered when the collector's bank is connected.
  if (org.payMethodPayByBank && org.stripeChargesEnabled) enabled.push("pay_by_bank");
  if (org.payMethodCard && org.stripeChargesEnabled) enabled.push("card");
  if (org.payMethodDirect) enabled.push("direct");
  const prices = priceMethods(base, enabled);
  return <PayOptions matchId={matchId} prices={prices} />;
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
