import type { Metadata } from "next";
import { longDayTimeLabel } from "@/lib/i18n/dates";
import { poolCopy } from "@/lib/i18n/pool-offer";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { isOfferHolder, loadOfferPage } from "@/lib/pool/accept";
import { proofCookieName } from "@/lib/pool/offer-proof-rules";
import { poolEnvForRequest } from "@/lib/pool/switch-env";
import type { OfferPageState } from "@/lib/pool/accept-rules";
import { poolOfferLines } from "@/lib/pool/offer-copy";
import { offerIdFromToken } from "@/lib/pool/offer-token";
import { POOL_MANAGE_PATH } from "@/lib/pool/paths";
import { PoolOfferAnswer } from "./answer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MatchTime", robots: { index: false, follow: false } };

/**
 * A POOL OFFER'S TAP LINK (local player pool L5a, 2026-10-24): the game's
 * facts (the same lines as the DM, with the map), and Yes / No thanks.
 * Public: the signed token in the path names the offer. Opening it changes
 * nothing (WhatsApp fetches links for previews); the answer is a button,
 * and answering needs proof it is HIM (review of #400, M2): signed in as
 * him, or his last 4 digits. Unproved (a forwarded link), the game's facts
 * only, never his distance. In HIS language. Never a group name, a member's name or a phone
 * number (the facts carry none).
 */
export default async function PoolOfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const offerId = offerIdFromToken(token);
  // Is it HIM (review of #400, M2)? Signed in as him, or this phone proved
  // his digits for this offer. Otherwise the game's facts only.
  const verified = offerId
    ? await isOfferHolder(offerId, {
        sessionUserId: (await auth())?.user?.id ?? null,
        proof: (await cookies()).get(proofCookieName(offerId))?.value ?? null,
      })
    : false;
  const page = offerId ? await loadOfferPage(offerId, { verified, env: await poolEnvForRequest() }) : null;
  const lang = page?.lang ?? "en";
  const c = poolCopy(lang);

  if (!page || !page.facts) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-10" data-testid="pool-offer-page" data-state="invalid">
        <div className="max-w-md mx-auto">
          <h1 className="text-xl font-bold text-slate-900">{c.page_title}</h1>
          <p className="mt-3 text-sm text-slate-600">{c.page_invalid}</p>
        </div>
      </main>
    );
  }

  const f = page.facts;
  const game = { club: f.club, day: longDayTimeLabel(lang, f.kickoff), venue: f.venueName };
  const message: Partial<Record<OfferPageState, string>> = {
    in: c.placed_in(game),
    bench: c.placed_bench(game),
    declined: c.page_declined,
    gone: c.page_gone,
    expired: c.page_expired,
    off: c.page_off,
    withdrawn: c.page_pulled_out,
    invalid: c.page_invalid,
    busy: c.page_busy,
  };

  // Unproved (perhaps a forwarded link): the game's facts only, never HIS
  // offer's state (second review of #400, item 4).
  const shown: OfferPageState | "unproved" = page.verified ? page.state : "unproved";
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10" data-testid="pool-offer-page" data-state={shown}>
      <div className="max-w-md mx-auto">
        <h1 className="text-xl font-bold text-slate-900">{c.page_title}</h1>
        <ul className="mt-4 space-y-2 rounded-xl bg-white border border-slate-200 p-4 text-sm text-slate-800" data-testid="pool-offer-facts">
          {poolOfferLines(lang, f).map((line) => (
            <li key={line} className="break-words">
              {line.replace(/\*/g, "")}
            </li>
          ))}
        </ul>
        {f.mapUrl && (
          <a
            href={f.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="pool-offer-map"
            className="mt-3 inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-100"
          >
            {c.page_map}
          </a>
        )}
        {page.verified && message[page.state] && (
          <p className="mt-5 text-base text-slate-900" data-testid="pool-offer-state">
            {message[page.state]!.replace(/\*/g, "")}
          </p>
        )}
        <PoolOfferAnswer token={token} language={lang} state={page.state} verified={page.verified} />
        <p className="mt-8 text-xs text-slate-500">
          <a href={POOL_MANAGE_PATH} className="underline" data-testid="pool-offer-manage">
            {c.page_manage}
          </a>
        </p>
      </div>
    </main>
  );
}
