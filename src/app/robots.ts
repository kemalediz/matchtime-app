import type { MetadataRoute } from "next";

const BASE =
  process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";

/**
 * robots.txt: the landing page and help guides are public; everything
 * behind a sign-in, and every single-use link (magic links, invites,
 * payment pages), stays out of search results.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/api/",
        "/r/",
        "/join/",
        "/pay/",
        "/collect",
        "/profile",
        "/matches/",
        "/onboarding",
        "/create-org",
        "/finish-setup",
      ],
    },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
