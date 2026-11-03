import type { Metadata } from "next";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { poolShareMetadata } from "@/lib/pool/share-meta";

/**
 * Every /play page's link preview (2026-11-03): the player's words and
 * picture (`opengraph-image.tsx`), never the organisers' homepage card the
 * root layout carries. A friend link (/play/f), a partner player's invite
 * (/play/j) and an offer (/play/offer) are forwarded in WhatsApp, and used
 * to show "run your weekly football on autopilot" with the homepage as
 * og:url. Their URLs are personal tokens, so no og:url and no canonical
 * here; /play itself sets its own (page.tsx). English, as /play is.
 */
export const metadata: Metadata = poolShareMetadata(poolLinkPreviewCopy("en"), { url: null });

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
