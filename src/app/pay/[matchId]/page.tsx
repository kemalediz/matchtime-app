import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { availablePayMethods, directPayInstructions, priceMethods, gbp, type PayMethodSwitches } from "@/lib/payments";
import { CLUB_ROW_SELECT, clubRowFactsOf } from "@/lib/club-row-facts";
import { t } from "@/lib/i18n/t";
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
          // The club's row, for its facts (club summary, slice A4): the
          // collector, the pay methods, the club's own words on paying the
          // collector directly (2026-10-16), the squad mode.
          org: { select: CLUB_ROW_SELECT },
        },
      },
    },
  });
  if (!match) redirect("/");

  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { paidAt: true, directPendingAt: true, paymentMethod: true, feeWaivedAt: true },
  });

  const me = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = me?.name?.split(" ")[0] ?? "there";
  const row = match.activity.org;
  // The club's facts (club summary, slice A4), else, when they cannot be
  // built, today's reads of the same row.
  const club = clubRowFactsOf(row, "pay");
  const org: PayClub = club
    ? {
        name: row.name,
        language: row.language,
        collectorId: club.payments.collector?.userId ?? null,
        payMethodPayByBank: club.payments.switches.payByBank,
        payMethodCard: club.payments.switches.card,
        payMethodDirect: club.payments.switches.direct,
        stripeChargesEnabled: club.payments.stripe.chargesEnabled,
        paymentInstructions: club.payments.instructions,
        squadMode: club.squad.mode,
      }
    : {
        name: row.name,
        language: row.language,
        collectorId: row.paymentHolderId,
        payMethodPayByBank: row.payMethodPayByBank,
        payMethodCard: row.payMethodCard,
        payMethodDirect: row.payMethodDirect,
        stripeChargesEnabled: row.stripeChargesEnabled,
        paymentInstructions: row.paymentInstructions,
        squadMode: row.squadMode,
      };
  // "Pay Raihan directly", as the pay link DM says. "the organiser" when
  // no collector name is on record.
  const collector = (await payCollectorName(org.collectorId))?.split(" ")[0] ?? null;
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

  // A free place (2026-10-16, fee-waiver.ts): nothing to pay, no buttons
  // (the actions refuse it too, `payBlockedReason`). Paid wins: a free
  // place that was paid anyway shows as paid below.
  if (attendance?.feeWaivedAt && !attendance.paidAt && paid !== "1") {
    const w = t(org.language);
    return (
      <Shell>
        <div className="text-center" data-testid="pay-free">
          <div className="text-5xl mb-3">🎁</div>
          <h1 className="text-xl font-bold text-slate-900">{w.pay_free_title}</h1>
          <p className="text-sm text-slate-500 mt-2">{w.pay_free_body({ firstName: first, activityName: match.activity.name })}</p>
          {/* Review of #301, item 4: a guest's fee cannot ride on a free row
              (the pay actions refuse it, `payBlockedReason`), so say where
              to settle it instead. */}
          <p className="text-sm text-slate-500 mt-2" data-testid="pay-free-guests">{w.pay_free_guests}</p>
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

/** What this page reads of the club: the pay method switches with
 *  `stripeChargesEnabled` (the input of `availablePayMethods`), the club's
 *  payment instructions and squad mode (`directPayInstructions`), the
 *  collector, the name and the language. */
type PayClub = PayMethodSwitches & {
  name: string;
  language: string | null;
  collectorId: string | null;
  paymentInstructions: string | null;
  squadMode: string | null;
};

function Methods({
  matchId,
  base,
  org,
  collector,
}: {
  matchId: string;
  base: number;
  org: PayClub;
  collector: string | null;
}) {
  // The one availability rule, shared with the pay link DM and the chase
  // (card/bank only once the collector's Stripe account can take charges).
  const prices = priceMethods(base, availablePayMethods(org), collector);
  // The club's payment instructions, verbatim as plain text (React
  // escapes it; nothing is turned into a link), only when paying the
  // collector directly is offered. The pay link and chase quote the same.
  const instructions = directPayInstructions(org);
  return (
    <>
      <PayOptions matchId={matchId} prices={prices} collector={collector} />
      {instructions && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3" data-testid="pay-instructions">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t(org.language).pi_pay_heading({ collector })}
          </p>
          <p className="mt-1 whitespace-pre-line break-words text-sm text-slate-700" data-testid="pay-instructions-text">
            {instructions}
          </p>
        </div>
      )}
    </>
  );
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
