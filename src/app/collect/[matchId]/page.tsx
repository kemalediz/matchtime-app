import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { requireMatchCollectorOrAdmin } from "@/app/actions/payments";
import { gbp } from "@/lib/payments";
import { PaymentRoster } from "@/components/pay/payment-roster";
import { RefreshButton } from "@/components/pay/refresh-button";
import { collectRowState } from "@/lib/fee-waiver-rules";
import { t } from "@/lib/i18n/t";
import { MatchContextHeader } from "@/components/match/match-context-header";
import { resolveTeamLabels } from "@/lib/team-labels";

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
      activity: {
        select: {
          name: true,
          venue: true,
          sport: { select: { name: true, teamLabels: true } },
          org: { select: { name: true, paymentHolderId: true, language: true, teamLabels: true } },
        },
      },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!match) redirect("/");

  // The collector collects — they don't pay themselves, so don't list them.
  const collectorId = match.activity.org.paymentHolderId;
  const rows = match.attendances
    .filter((a) => a.userId !== collectorId)
    // Monthly squad (slice 5): a regular's place is paid for by the month.
    .filter((a) => a.paymentMethod !== "monthly")
    .map((a) => ({
    userId: a.userId,
    name: a.user.name ?? "Player",
    paid: a.paidAt != null,
    // A free place (2026-10-16): owes nothing, so it is neither in
    // "N/M paid" nor in "collected". Paid wins (money moved).
    free: collectRowState(a, false) === "free",
    method: a.paymentMethod,
    directPending: a.directPendingAt != null && a.paidAt == null,
    // What the collector RECEIVES (base × qty), not the gross the player
    // paid. The gross-up nets the collector exactly base per head on every
    // method; the Stripe + platform fees are the player's and would only
    // confuse the collector. Fall back to stored amount if no fee set.
    amount:
      match.feePerPlayer != null
        ? match.feePerPlayer * (a.paymentQuantity ?? 1)
        : a.paymentAmount,
    quantity: a.paymentQuantity,
  }));

  const owing = rows.filter((r) => !r.free);
  const freeCount = rows.length - owing.length;
  const paidCount = owing.filter((r) => r.paid).length;
  const collected = owing.reduce((s, r) => s + (r.paid ? r.amount ?? 0 : 0), 0);
  const base = match.feePerPlayer;
  const words = t(match.activity.org.language);
  const teamLabels = resolveTeamLabels(match, match.activity.org, match.activity.sport, match.activity.org.language);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        {/* Which match this is (Kemal, 2026-10-18): day, kickoff, venue,
            status and score, with the way back to the match. */}
        <div className="mb-4">
          <MatchContextHeader
            matchId={matchId}
            title={match.activity.name}
            sportName={match.activity.sport?.name}
            clubName={match.activity.org.name}
            venue={match.activity.venue}
            date={match.date}
            status={match.status}
            redScore={match.redScore}
            yellowScore={match.yellowScore}
            teamLabels={teamLabels}
            lang={match.activity.org.language}
          />
        </div>
        <div className="text-center mb-5">
          <p className="text-sm text-slate-500 mt-1">
            {base != null ? <>Fee {gbp(base)} per player · </> : null}
            <span className="font-semibold text-slate-700">
              {paidCount}/{owing.length} paid
            </span>
            {freeCount > 0 && <span data-testid="collect-free-count"> · {words.collect_free_count({ count: freeCount })}</span>}
            {collected > 0 && <> · {gbp(collected)} collected</>}
          </p>
          <div className="mt-3 flex justify-center">
            <RefreshButton />
          </div>
        </div>

        {base == null && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            No fee set yet. Reply to MatchTime in WhatsApp with the amount per
            player to send everyone their pay link.
          </div>
        )}

        <PaymentRoster
          matchId={matchId}
          rows={rows}
          words={{
            free: words.collect_free,
            markFree: words.collect_mark_free,
            undoFree: words.collect_undo_free,
            markedFree: words.collect_marked_free,
            unmarkedFree: words.collect_unmarked_free,
            nothingChanged: words.collect_nothing_changed,
          }}
        />
      </div>
    </div>
  );
}
