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
 * good, on every device.
 *
 * Read again on every new page, and whenever his pool state changes
 * without one (`banner-events.ts`): joining on the "Play elsewhere too"
 * card, pause, stop or delete on /play/manage, "Not interested" in his
 * other tab, or coming back to the tab. Only the newest answer is drawn. A phone gets the text on one line and the
 * buttons under it.
 *
 * Solid brand blue with white text (2026-10-28, Kemal: the pale strip was
 * too easy to miss) and sticky: it stays pinned under the top bar while
 * the page scrolls. On a phone the dark top bar is itself sticky at top 0
 * and 3.5rem tall, so the banner sticks at top 3.5rem; on desktop there is
 * no top bar (the sidebar is fixed on the left), so it sticks at top 0.
 * Sticky keeps its height in the flow, so it never covers the content at
 * the top. z-20: above the page, below the phone menu (z-30), the top bar
 * (z-40) and every dialog, the ⓘ sheet included (z-50).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { InfoButton } from "@/components/stats/info-button";
import { poolBannerCopy } from "@/lib/i18n/pool-banner";
import { t } from "@/lib/i18n/t";
import type { PoolBannerView } from "@/lib/pool/banner";
import { announcePoolStateChanged, subscribePoolStateChanged } from "@/lib/pool/banner-events";
import { PLAY_ELSEWHERE_FOCUS_EVENT, PLAY_ELSEWHERE_PATH, POOL_CLUB_SHARE_SETTINGS_PATH } from "@/lib/pool/paths";

const POOL_BANNER_API = "/api/pool-banner";

export function PoolBanner() {
  const pathname = usePathname();
  const [view, setView] = useState<PoolBannerView | null>(null);
  // Each read gets a number; an older answer that lands late is dropped.
  const latest = useRef(0);

  const load = useCallback(() => {
    const n = ++latest.current;
    void fetch(POOL_BANNER_API, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<PoolBannerView | null>) : null))
      .then((v) => n === latest.current && setView(v))
      .catch(() => n === latest.current && setView(null));
  }, []);

  // Every page, and every change to his pool state that keeps the page.
  useEffect(() => {
    load();
  }, [pathname, load]);
  useEffect(() => subscribePoolStateChanged(load), [load]);

  if (!view) return null;
  const c = poolBannerCopy(view.language);
  const s = t(view.language);
  const banner = view.kind === "join" ? c.join : c.share;

  const dismiss = () => {
    const kind = view.kind;
    ++latest.current;
    setView(null);
    // Stored first, then his other tabs read again (a read before the
    // store would bring it back).
    void fetch(POOL_BANNER_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) })
      .then((r) => r.ok && announcePoolStateChanged())
      .catch(() => {});
  };

  const action =
    view.kind === "join" ? (
      <Link
        href={PLAY_ELSEWHERE_PATH}
        // Already on /profile: Next scrolls to the anchor but fires no
        // hashchange, so tell the card to light up.
        onClick={() => pathname === "/profile" && window.dispatchEvent(new Event(PLAY_ELSEWHERE_FOCUS_EVENT))}
        data-testid="pool-banner-join"
        className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 text-sm font-bold text-blue-700 shadow-sm hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-blue-700"
      >
        {banner.button}
      </Link>
    ) : (
      <a
        href={view.whatsApp ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="pool-banner-share"
        className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-bold text-blue-700 shadow-sm hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-blue-700"
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
      className="sticky top-14 z-20 border-b border-blue-800 bg-blue-700 px-4 py-2 text-sm text-white shadow-md lg:top-0"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 basis-full font-medium sm:basis-auto" data-testid="pool-banner-text">
          {banner.text}{" "}
          <InfoButton title={banner.info.title} label={s.info_open({ title: banner.info.title })} closeLabel={s.info_close} testId="pool-banner" tone="onDark">
            {banner.info.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </InfoButton>
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {action}
          {view.adminLine && (
            <Link href={POOL_CLUB_SHARE_SETTINGS_PATH} data-testid="pool-banner-admin" className="font-semibold text-white underline">
              {c.adminLine}
            </Link>
          )}
          <button type="button" onClick={dismiss} data-testid="pool-banner-dismiss" className="text-xs text-blue-100 underline hover:text-white">
            {c.notInterested}
          </button>
        </div>
      </div>
    </aside>
  );
}
