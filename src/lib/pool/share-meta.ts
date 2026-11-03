/**
 * The link preview of the pool's own pages (2026-11-03). PURE.
 *
 * WHY. /play had no Open Graph tags of its own, so a shared /play link
 * showed the root layout's card: the ORGANISERS' homepage pitch ("run your
 * weekly football on autopilot", bench, partner clubs, fees) with og:url
 * and the canonical link pointing at the homepage. Kemal's Nextdoor post
 * (764 views, no sign-ups) went out with that card.
 *
 * Next merges metadata one top-level key at a time, so an `openGraph` here
 * replaces the root layout's whole `openGraph` (its homepage og:url goes
 * with it). The picture comes from the segment's `opengraph-image.tsx` and
 * `twitter-image.tsx`, which Next adds on top.
 */
import type { Metadata } from "next";
import type { PoolLinkPreviewCopy } from "../i18n/pool-link-preview";
import { POOL_PLAY_PATH } from "./paths";

/**
 * `url`: the page's own path (resolved against the root `metadataBase`), or
 * null for a page whose URL is a personal token (a friend link, an offer):
 * then no og:url and no canonical at all, so a crawler keeps the very link
 * it fetched and a tap on the preview opens that link, never another page.
 */
export function poolShareMetadata(copy: PoolLinkPreviewCopy, { url }: { url: string | null }): Pick<Metadata, "openGraph" | "twitter" | "alternates"> {
  return {
    openGraph: {
      type: "website",
      siteName: "MatchTime",
      locale: "en_GB",
      title: copy.title,
      description: copy.description,
      ...(url ? { url } : {}),
    },
    twitter: { card: "summary_large_image", title: copy.title, description: copy.description },
    // /play is THE page for search engines, whatever code a link carries.
    alternates: { canonical: url ? POOL_PLAY_PATH : null },
  };
}

/**
 * /play's own URL with the codes it was opened with (as `readSignupSource`
 * read them, so a malformed one is dropped). Kept in og:url because
 * Facebook treats og:url as the link: a tap on the preview of
 * /play?src=fb-sutton must still land on /play?src=fb-sutton to be counted.
 */
export function poolPlaySharePath(source: { campaignCode: string | null; referralCode: string | null }): string {
  const q = new URLSearchParams();
  if (source.campaignCode) q.set("src", source.campaignCode);
  if (source.referralCode) q.set("ref", source.referralCode);
  const s = q.toString();
  return s ? `${POOL_PLAY_PATH}?${s}` : POOL_PLAY_PATH;
}
