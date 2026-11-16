import type { Metadata } from "next";
import { SITE_META } from "@/components/landing/landing-content";

/**
 * The site's Open Graph card, as the root layout sets it. A page that sets
 * its own og:url must carry the rest of the card too: Next.js merges
 * metadata SHALLOWLY, so a page's `openGraph` replaces the layout's whole.
 */
export const SITE_OPEN_GRAPH = {
  type: "website",
  siteName: "MatchTime",
  title: SITE_META.title,
  description: SITE_META.ogDescription,
} as const;

/**
 * The site card's picture, `src/app/opengraph-image.png` (1200 x 630), as
 * the root emits it: type, width and height, no alt (review of #605). The
 * file attaches by itself only to the root segment, and only where that
 * segment sets no `images`; a deeper page whose own `openGraph` replaces
 * the layout's loses it, so such a page carries it here.
 */
export const SITE_OG_IMAGE = { url: "/opengraph-image.png", type: "image/png", width: 1200, height: 630 } as const;

/**
 * A public page's own canonical URL and og:url (review 2026-11-15). The
 * root layout names no canonical, so a page without this names none rather
 * than the home page. `path` is resolved against the layout's metadataBase.
 * `imageFromFile`: the page sits in the root segment (the home page), where
 * opengraph-image.png still attaches by itself, so no image is named here
 * and its og:image stays exactly the file's.
 */
export function ownPageUrlMetadata(path: string, opts: { imageFromFile?: boolean } = {}): Pick<Metadata, "alternates" | "openGraph"> {
  return {
    alternates: { canonical: path },
    openGraph: { ...SITE_OPEN_GRAPH, url: path, ...(opts.imageFromFile ? {} : { images: [{ ...SITE_OG_IMAGE }] }) },
  };
}
