/**
 * The link preview a shared /play link shows (2026-11-03). Kemal's Nextdoor
 * post of matchtime.ai/play had 764 views and no sign-ups, and its preview
 * was the ORGANISERS' homepage card ("run your weekly football on
 * autopilot", bench, partner clubs, fees) with og:url the homepage, because
 * /play had no Open Graph tags of its own and inherited the root layout's.
 */
import { describe, expect, it } from "vitest";
import { SITE_META } from "@/components/landing/landing-content";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { poolPlaySharePath, poolShareMetadata } from "../share-meta";

const EN = { share: poolLinkPreviewCopy("en") };

describe("the player-facing preview", () => {
  const m = poolShareMetadata(EN.share, { url: "/play?src=fb-sutton" });

  it("says what a player gets, in one plain sentence", () => {
    expect(EN.share.title).toBe("Get offered local football games on WhatsApp");
    expect(EN.share.description.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length).toBe(1);
    for (const word of ["free", "area", "days", "WhatsApp", "player short", "choose"]) expect(EN.share.description.toLowerCase()).toContain(word.toLowerCase());
  });

  it("Open Graph: the player title, description and the page's own URL, never the homepage's", () => {
    expect(m.openGraph).toMatchObject({
      type: "website",
      siteName: "MatchTime",
      title: EN.share.title,
      description: EN.share.description,
      url: "/play?src=fb-sutton",
    });
    expect(JSON.stringify(m)).not.toContain(SITE_META.title);
    expect(JSON.stringify(m)).not.toContain(SITE_META.ogDescription);
  });

  it("Twitter: a large picture card with the same words", () => {
    expect(m.twitter).toMatchObject({ card: "summary_large_image", title: EN.share.title, description: EN.share.description });
  });

  it("no prices and no organiser features in any of it", () => {
    const all = [EN.share.title, EN.share.description, EN.share.imageAlt, EN.share.imageBadge].join(" ");
    expect(all).not.toMatch(/£|\bfee|price|pay\b|bench|partner club|autopilot|organis/i);
  });

  it("a page with no own URL (a token link) carries no og:url and no canonical, so a crawler keeps the link it fetched", () => {
    const t = poolShareMetadata(EN.share, { url: null });
    expect(t.openGraph).not.toHaveProperty("url");
    expect(t.alternates).toEqual({ canonical: null });
  });

  it("/play itself is canonical for search engines, whatever code the link carries", () => {
    expect(m.alternates).toEqual({ canonical: "/play" });
  });
});

describe("the page's own URL", () => {
  it("/play with no code", () => expect(poolPlaySharePath({ campaignCode: null, referralCode: null })).toBe("/play"));
  it("keeps a campaign code, so a click through the preview is still counted under it", () =>
    expect(poolPlaySharePath({ campaignCode: "fb-sutton", referralCode: null })).toBe("/play?src=fb-sutton"));
  it("keeps a friend's share code", () => expect(poolPlaySharePath({ campaignCode: null, referralCode: "AB12cd" })).toBe("/play?ref=AB12cd"));
  it("both, as the page reads them", () => expect(poolPlaySharePath({ campaignCode: "fb-sutton", referralCode: "AB12cd" })).toBe("/play?src=fb-sutton&ref=AB12cd"));
});
