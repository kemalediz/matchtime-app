/**
 * Each public page names ITSELF as canonical and as og:url (review
 * 2026-11-15). The root layout used to set both to the home page, and no
 * page overrode them, so /contact, /pricing and the rest told search
 * engines their canonical page was the home page.
 */
import { describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "" });
  return { Inter: font, Plus_Jakarta_Sans: font, Geist_Mono: font };
});
vi.mock("../globals.css", () => ({}));
vi.mock("@/components/providers", () => ({ Providers: () => null }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/web-analytics", () => ({ WebAnalytics: () => null }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { SITE_META } from "@/components/landing/landing-content";
import { metadata as rootMeta } from "../layout";
import { metadata as homeMeta } from "../page";
import { metadata as contactMeta } from "../contact/page";
import { metadata as pricingMeta } from "../pricing/page";
import { metadata as privacyMeta } from "../privacy/page";
import { metadata as playersMeta } from "../players/page";
import { metadata as helpMeta } from "../help/page";
import { metadata as helpPlayerMeta } from "../help/player/page";
import { metadata as helpAdminMeta } from "../help/admin/page";

const ogUrl = (m: Metadata) => (m.openGraph as { url?: unknown } | undefined)?.url;

describe("canonical URLs", () => {
  it("the root layout names no page as canonical, so a page without its own never claims the home page", () => {
    expect(rootMeta.alternates?.canonical).toBeUndefined();
    expect(ogUrl(rootMeta)).toBeUndefined();
    expect(rootMeta.metadataBase).toBeInstanceOf(URL);
  });

  it("the home page keeps itself as canonical and og:url", () => {
    expect(homeMeta.alternates?.canonical).toBe("/");
    expect(ogUrl(homeMeta)).toBe("/");
  });

  it("/contact and /pricing are their own canonical and og:url", () => {
    expect(contactMeta.alternates?.canonical).toBe("/contact");
    expect(ogUrl(contactMeta)).toBe("/contact");
    expect(pricingMeta.alternates?.canonical).toBe("/pricing");
    expect(ogUrl(pricingMeta)).toBe("/pricing");
  });

  it("the other public pages are their own canonical too", () => {
    const cases: [Metadata, string][] = [
      [privacyMeta, "/privacy"],
      [playersMeta, "/players"],
      [helpMeta as Metadata, "/help"],
      [helpPlayerMeta as Metadata, "/help/player"],
      [helpAdminMeta as Metadata, "/help/admin"],
    ];
    for (const [m, path] of cases) {
      expect(m.alternates?.canonical).toBe(path);
      expect(ogUrl(m)).toBe(path);
    }
  });

  it("a page's own og:url keeps the site's card (Open Graph merges shallowly, so the page carries it)", () => {
    for (const m of [rootMeta, homeMeta, contactMeta, pricingMeta]) {
      expect(m.openGraph).toMatchObject({
        type: "website",
        siteName: "MatchTime",
        title: SITE_META.title,
        description: SITE_META.ogDescription,
      });
    }
  });

  // Review of #605: a page's own `openGraph` replaces the layout's whole,
  // and the root's opengraph-image.png only attaches where a segment sets
  // no `images`, so the seven pages below lost og:image. They carry the
  // site card themselves, as the root emits it (1200 x 630 PNG, no alt).
  it("every public page but the home page carries the site card image", () => {
    const card = [{ url: "/opengraph-image.png", type: "image/png", width: 1200, height: 630 }];
    for (const m of [contactMeta, pricingMeta, privacyMeta, playersMeta, helpMeta, helpPlayerMeta, helpAdminMeta] as Metadata[]) {
      expect((m.openGraph as { images?: unknown }).images).toEqual(card);
    }
  });

  it("the home page sets no image, so the root's opengraph-image.png still attaches to it as before", () => {
    expect(homeMeta.openGraph).not.toHaveProperty("images");
  });

  it("the page titles are unchanged", () => {
    expect(contactMeta.title).toBe("Contact");
    expect(pricingMeta.title).toBe("Pricing");
    expect(helpMeta.title).toBe("Help & guides");
  });
});
