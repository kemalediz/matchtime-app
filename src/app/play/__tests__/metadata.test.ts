/**
 * /play's own link preview (2026-11-03), as the page and the /play layout
 * export it: player words, the page's own URL with the code it was opened
 * with, never the organisers' homepage card it used to inherit.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pool/growth", () => ({ poolInvitedByName: vi.fn() }));
vi.mock("@/lib/pool/flags-page", () => ({ signupGoesOnEarlyListForPage: vi.fn() }));
vi.mock("../play-signup", () => ({ PlaySignup: () => null }));
vi.mock("../funnel-beacon", () => ({ PoolFunnelBeacon: () => null }));

import { SITE_META } from "@/components/landing/landing-content";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { POOL_CAMPAIGN_SOURCES } from "@/lib/pool/vocab";
import { POOL_CAMPAIGN_OWNER_SOURCES } from "@/lib/pool/growth-rules";
import { generateMetadata } from "../page";
import { metadata as layoutMetadata } from "../layout";

const EN = { ...poolPageCopy("en"), share: poolLinkPreviewCopy("en") };
const meta = (q: Record<string, string>) => generateMetadata({ searchParams: Promise.resolve(q) });

describe("/play's metadata", () => {
  it("plain /play: the player title and description, og:url /play", async () => {
    const m = await meta({});
    expect(m.title).toBe(EN.title);
    expect(m.description).toBe(EN.description);
    expect(m.openGraph).toMatchObject({ title: EN.share.title, description: EN.share.description, url: "/play" });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", title: EN.share.title });
    expect(m.alternates).toEqual({ canonical: "/play" });
  });

  it("a campaign link: og:url keeps the code, read as the page reads it", async () => {
    expect((await meta({ src: "FB-Sutton" })).openGraph).toMatchObject({ url: "/play?src=fb-sutton" });
    expect((await meta({ c: "nd-cheam" })).openGraph).toMatchObject({ url: "/play?src=nd-cheam" });
  });

  it("a code the page would ignore is dropped from og:url", async () => {
    expect((await meta({ src: "not a code!" })).openGraph).toMatchObject({ url: "/play" });
  });

  it("never the homepage's card", async () => {
    const s = JSON.stringify(await meta({ src: "fb-sutton" }));
    expect(s).not.toContain(SITE_META.title);
    expect(s).not.toContain(SITE_META.ogDescription);
  });
});

describe("every /play page (friend link, partner invite, offer) shares the player preview", () => {
  it("the /play layout's Open Graph and Twitter are the player's, with no og:url and no homepage canonical", () => {
    expect(layoutMetadata.openGraph).toMatchObject({ title: EN.share.title, description: EN.share.description });
    expect(layoutMetadata.openGraph).not.toHaveProperty("url");
    expect(layoutMetadata.twitter).toMatchObject({ title: EN.share.title });
    expect(layoutMetadata.alternates).toEqual({ canonical: null });
  });
});

describe("campaign sources", () => {
  it("Facebook and Nextdoor are sources the owner can pick", () => {
    expect(POOL_CAMPAIGN_SOURCES).toEqual(expect.arrayContaining(["facebook", "nextdoor"]));
    expect(POOL_CAMPAIGN_OWNER_SOURCES).toEqual(expect.arrayContaining(["facebook", "nextdoor"]));
    expect(POOL_CAMPAIGN_OWNER_SOURCES).not.toContain("club");
  });
});
