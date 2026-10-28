"use client";

/**
 * THE PLAYER POOL BANNER (2026-10-28): one line at the top of every
 * signed-in app page, under the nav. Which banner, if any, is decided on
 * the server for this request (`GET /api/pool-banner`, rule in
 * `src/lib/pool/banner-rules.ts`); this only draws it. No wording here
 * (`src/lib/i18n/pool-banner.ts`).
 *
 *   join   "Join the pool" goes to the "Play elsewhere too" card on his
 *          profile (`#play-elsewhere`), which scrolls to itself and lights
 *          up; joining is the card's own steps
 *   share  "Share" opens WhatsApp's chat picker with his own link
 *
 * "Not interested" hides it at once and stores it on his user row, for
 * good, on every device. In the page's flow, never over the content: a
 * phone gets the text on one line and the buttons under it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { InfoButton } from "@/components/stats/info-button";
import { poolBannerCopy } from "@/lib/i18n/pool-banner";
import { t } from "@/lib/i18n/t";
import type { PoolBannerView } from "@/lib/pool/banner";
import { PLAY_ELSEWHERE_FOCUS_EVENT, PLAY_ELSEWHERE_PATH, POOL_CLUB_SHARE_SETTINGS_PATH } from "@/lib/pool/paths";

const POOL_BANNER_API = "/api/pool-banner";

export function PoolBanner() {
  const pathname = usePathname();
  const [view, setView] = useState<PoolBannerView | null>(null);

  // Read again on every page: joining on /profile turns join into share,
  // and the switches are never cached.
  useEffect(() => {
    let alive = true;
    void fetch(POOL_BANNER_API, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<PoolBannerView | null>) : null))
      .then((v) => alive && setView(v))
      .catch(() => alive && setView(null));
    return () => {
      alive = false;
    };
  }, [pathname]);

  if (!view) return null;
  const c = poolBannerCopy(view.language);
  const s = t(view.language);
  const banner = view.kind === "join" ? c.join : c.share;

  const dismiss = () => {
    const kind = view.kind;
    setView(null);
    void fetch(POOL_BANNER_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => {});
  };

  const action =
    view.kind === "join" ? (
      <Link
        href={PLAY_ELSEWHERE_PATH}
        // Already on /profile: Next scrolls to the anchor but fires no
        // hashchange, so tell the card to light up.
        onClick={() => pathname === "/profile" && window.dispatchEvent(new Event(PLAY_ELSEWHERE_FOCUS_EVENT))}
        data-testid="pool-banner-join"
        className="inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
      >
        {banner.button}
      </Link>
    ) : (
      <a
        href={view.whatsApp ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="pool-banner-share"
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
      >
        <MessageCircle className="h-4 w-4" aria-hidden />
        {banner.button}
      </a>
    );

  return (
    <aside
      aria-label={c.region}
      lang={view.language}
      data-testid="pool-banner"
      data-kind={view.kind}
      className="border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-slate-800"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 basis-full sm:basis-auto" data-testid="pool-banner-text">
          {banner.text}{" "}
          <InfoButton title={banner.info.title} label={s.info_open({ title: banner.info.title })} closeLabel={s.info_close} testId="pool-banner">
            {banner.info.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </InfoButton>
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {action}
          {view.adminLine && (
            <Link href={POOL_CLUB_SHARE_SETTINGS_PATH} data-testid="pool-banner-admin" className="font-semibold text-blue-800 underline">
              {c.adminLine}
            </Link>
          )}
          <button type="button" onClick={dismiss} data-testid="pool-banner-dismiss" className="text-slate-500 underline hover:text-slate-700">
            {c.notInterested}
          </button>
        </div>
      </div>
    </aside>
  );
}
