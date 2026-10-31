"use client";

/**
 * His own place, on his friend link's page (2026-11-01): shown only when he
 * is signed in as the friend the link booked and the game is still to play.
 * One button gives the place back (`pullOutFriendLinkAction`).
 */
import { useState, useTransition } from "react";
import { PoolPageShell } from "@/components/pool/pool-page-shell";
import { useBrowserLang } from "@/lib/i18n/browser-lang";
import { dayCommaTimeLabel } from "@/lib/i18n/dates";
import { friendLinkCopy } from "@/lib/i18n/friend-link";
import type { Lang } from "@/lib/i18n/lang";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { pullOutFriendLinkAction } from "../actions";

export function FriendLinkHeld({ token, club, kickoffIso }: { token: string; club: string; kickoffIso: string }) {
  const browserLang = useBrowserLang();
  const [chosen, setChosen] = useState<Lang | null>(null);
  const lang = chosen ?? browserLang;
  const c = friendLinkCopy(lang);
  const [state, setState] = useState<"held" | "out" | "started">("held");
  const [pending, start] = useTransition();
  return (
    <PoolPageShell lang={lang} onLang={setChosen} copy={poolPageCopy(lang)}>
      <div data-testid="friend-link-held" data-state={state}>
        {state === "held" && (
          <>
            <p className="text-lg font-semibold text-slate-900">{c.page_held({ club, day: dayCommaTimeLabel(lang, new Date(kickoffIso)) })}</p>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await pullOutFriendLinkAction(token);
                  setState(r.state === "out" ? "out" : r.state === "started" ? "started" : "held");
                })
              }
              className="mt-5 inline-flex rounded-xl border border-red-300 bg-white px-5 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {c.page_pull_out}
            </button>
          </>
        )}
        {state === "out" && <p className="text-lg font-semibold text-slate-900">{c.page_out}</p>}
        {state === "started" && <p className="text-lg font-semibold text-slate-900">{c.page_started}</p>}
      </div>
    </PoolPageShell>
  );
}
