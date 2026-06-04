import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { requireMatchCollectorOrAdmin } from "@/app/actions/payments";
import { gbp } from "@/lib/payments";
import { PaymentRoster } from "@/components/pay/payment-roster";

export const dynamic = "force-dynamic";

/**
 * Money-collector dashboard for one match (2026-06-04). The collector
 * (Organisation.paymentHolderId — not necessarily an org admin) lands
 * here from the "mark it paid" DM or a chaser. Shows who's paid, who
 * hasn't, and lets them tick off direct (cash/transfer) payments.
 */
export default async function CollectPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  try {
    await requireMatchCollectorOrAdmin(session.user.id, matchId);
  } catch {
    redirect("/");
  }

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { select: { name: true, org: { select: { name: true } } } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!match) redirect("/");

  const rows = match.attendances.map((a) => ({
    userId: a.userId,
    name: a.user.name ?? "Player",
    paid: a.paidAt != null,
    method: a.paymentMethod,
    directPending: a.directPendingAt != null && a.paidAt == null,
    amount: a.paymentAmount,
    quantity: a.paymentQuantity,
  }));

  const paidCount = rows.filter((r) => r.paid).length;
  const collected = rows.reduce((s, r) => s + (r.paid ? r.amount ?? 0 : 0), 0);
  const base = match.feePerPlayer;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="text-center mb-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">
            {match.activity.org.name}
          </p>
          <h1 className="text-xl font-bold text-slate-900 mt-1">{match.activity.name}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {base != null ? <>Fee {gbp(base)} per player · </> : null}
            <span className="font-semibold text-slate-700">
              {paidCount}/{rows.length} paid
            </span>
            {collected > 0 && <> · {gbp(collected)} collected</>}
          </p>
        </div>

        {base == null && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            No fee set yet. Reply to MatchTime in WhatsApp with the amount per
            player to send everyone their pay link.
          </div>
        )}

        <PaymentRoster matchId={matchId} rows={rows} />
      </div>
    </div>
  );
}
