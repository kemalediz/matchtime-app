import type { MetadataRoute } from "next";
import { PRIVACY_PATH } from "@/lib/privacy-policy";
import { PLAYERS_PAGE_PATH, POOL_PLAY_PATH } from "@/lib/pool/paths";

const BASE =
  process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";

/**
 * Sitemap lists only public-discoverable URLs. The authenticated app
 * routes (/admin, /matches/*, /profile/*, magic-link /r/[token], invite
 * /join/[code]) stay out of the sitemap so search engines don't waste
 * crawl budget on gated or single-use pages.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${BASE}/`,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${BASE}/help`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE}/help/player`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE}/help/admin`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      // The website's page for players (2026-10-25).
      url: `${BASE}${PLAYERS_PAGE_PATH}`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      // The player pool's sign-up (slice L2), linked from the landing page.
      url: `${BASE}${POOL_PLAY_PATH}`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE}${PRIVACY_PATH}`,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${BASE}/login`,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${BASE}/signup`,
      changeFrequency: "yearly",
      priority: 0.5,
    },
  ];
}
