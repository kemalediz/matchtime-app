import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { longDayTimeLabel, timeLabel, dayLabel } from "@/lib/i18n/dates";
import { inviteCopy } from "@/lib/i18n/pool-invite";
import { loadMyInvitations } from "@/lib/pool/my-invitations";
import { POOL_INVITATIONS_PATH, POOL_MANAGE_PATH } from "@/lib/pool/paths";
import { InvitationAnswer } from "./answer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MatchTime", robots: { index: false, follow: false } };

/**
 * MY INVITATIONS (local player pool L8): the player's own page. His open
 * club invitations, each with Join / No thanks, and his open game offers.
 * Every DM about an invitation links here, signed (`buildPoolInvitationsLink`).
 * His session only: signed out, the login page brings him back. Full-bleed,
 * like every /play page (a pool player may belong to no club).
 */
export default async function MyInvitationsPage() {
  const userId = (await auth())?.user?.id;
  if (!userId) redirect(`/login?callbackUrl=${encodeURIComponent(POOL_INVITATIONS_PATH)}`);
  const view = await loadMyInvitations(userId);
  const c = inviteCopy(view.lang);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-10" data-testid="my-invitations" lang={view.lang}>
      <div className="max-w-xl mx-auto space-y-6">
        <header>
          <h1 className="text-xl font-bold text-slate-900">{c.inv_title}</h1>
          <p className="mt-1 text-sm text-slate-600">{c.inv_intro}</p>
        </header>

        <section aria-labelledby="inv-clubs" className="space-y-3">
          <h2 id="inv-clubs" className="text-base font-semibold text-slate-800">
            {c.inv_clubs}
          </h2>
          {view.invitations.length === 0 ? (
            <p data-testid="my-invitations-none" className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-500">
              {c.inv_none_clubs}
            </p>
          ) : (
            <ul className="space-y-3">
              {view.invitations.map((i) => (
                <li key={i.id} data-testid="my-invitation" data-state={i.state} className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm space-y-2">
                  <h3 className="font-semibold text-slate-900 break-words" data-testid="my-invitation-club">
                    {i.club}
                  </h3>
                  <ul className="space-y-1 text-sm text-slate-700">
                    {i.sport && <li data-testid="my-invitation-sport">{i.sport}</li>}
                    {i.venue && <li className="break-words">{i.venue}</li>}
                    {i.about && <li>{i.about}</li>}
                    {i.gamesHere > 0 && <li data-testid="my-invitation-games">{c.inv_games_here({ n: i.gamesHere })}</li>}
                  </ul>
                  <InvitationAnswer invitationId={i.id} state={i.state} language={view.lang} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="inv-offers" className="space-y-3">
          <h2 id="inv-offers" className="text-base font-semibold text-slate-800">
            {c.inv_offers}
          </h2>
          {view.offers.length === 0 ? (
            <p data-testid="my-offers-none" className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-500">
              {c.inv_none_offers}
            </p>
          ) : (
            <ul className="space-y-3">
              {view.offers.map((o) => (
                <li key={o.id} data-testid="my-offer" className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm space-y-2">
                  <h3 className="font-semibold text-slate-900 break-words">{o.club}</h3>
                  <p className="text-sm text-slate-700">{longDayTimeLabel(view.lang, o.kickoff)}</p>
                  {o.venue && <p className="text-sm text-slate-700 break-words">{o.venue}</p>}
                  <div className="flex flex-wrap items-center gap-3">
                    <a href={o.path} data-testid="my-offer-open" className="inline-flex h-10 items-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700">
                      {c.inv_open_offer}
                    </a>
                    <span className="text-xs text-slate-500">{c.inv_offer_until({ time: `${dayLabel(view.lang, o.expiresAt)} ${timeLabel(o.expiresAt)}` })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-xs text-slate-500">
          <a href={POOL_MANAGE_PATH} className="underline" data-testid="my-invitations-settings">
            {c.inv_settings}
          </a>
        </p>
      </div>
    </main>
  );
}
