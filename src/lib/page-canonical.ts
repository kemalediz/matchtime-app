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
 * A public page's own canonical URL and og:url (review 2026-11-15). The
 * root layout names no canonical, so a page without this names none rather
 * than the home page. `path` is resolved against the layout's metadataBase.
 */
export function ownPageUrlMetadata(path: string): Pick<Metadata, "alternates" | "openGraph"> {
  return {
    alternates: { canonical: path },
    openGraph: { ...SITE_OPEN_GRAPH, url: path },
  };
}
