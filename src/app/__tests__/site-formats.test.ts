import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SITE_META, footballFormatsWords, liveFormatsPhrase } from "@/components/landing/landing-content";
import { liveSports } from "@/lib/pool/sports";

/**
 * EVERY FORMAT, NEVER A SUBSET (Kemal, 2026-10-25): the share preview said
 * "weekly 5, 7 and 11-a-side football"; "why restrict to this, there are
 * venues for 8 and 9 aside too". The site's format lists are derived from
 * the live catalogue (`LIVE_SPORTS`, src/lib/pool/sports.ts), so they say
 * what the sign-up offers. Any list still typed by hand on a public page
 * must name every live football format.
 */
const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_FILES = [
  "src/components/landing/landing-page.tsx",
  "src/components/landing/landing-content.ts",
  "src/components/landing/landing-sections.tsx",
  "src/components/landing/players-page.tsx",
  "src/app/players/page.tsx",
  "src/components/landing/pricing-section.tsx",
  "src/app/pricing/page.tsx",
  "src/app/help/layout.tsx",
  "src/app/help/page.tsx",
  "src/app/help/player/page.tsx",
  "src/app/help/admin/page.tsx",
  "src/app/layout.tsx",
  "src/app/play/page.tsx",
  "src/app/play/play-signup.tsx",
  "src/lib/i18n/pool-play.en.ts",
];

const footballFormats = (): number[] => [...(liveSports().find((s) => s.key === "football")?.formats ?? [])];

/** "5, 7 and 11-a-side", "5, 7, 8, 9 or 11-a-side": a list of two or more formats. */
const FORMAT_LIST = /\b\d+(?:,\s*\d+)*,?\s+(?:and|or)\s+\d+-a-side\b/g;
const numbersIn = (list: string) => (list.match(/\d+/g) ?? []).map(Number);

describe("the site's format lists name every live football format", () => {
  it("football is live with 5, 7, 8, 9 and 11-a-side", () => {
    expect(footballFormats()).toEqual([5, 7, 8, 9, 11]);
  });

  it("the derived phrase reads naturally", () => {
    expect(liveFormatsPhrase()).toBe("5, 7, 8, 9 and 11-a-side football");
    expect(liveFormatsPhrase("or")).toBe("5, 7, 8, 9 or 11-a-side football");
    expect(footballFormatsWords()).toBe("5, 7, 8, 9 or 11-a-side");
  });

  it("the organiser guide derives its format list too", () => {
    expect(readFileSync(path.join(ROOT, "src/app/help/admin/page.tsx"), "utf8")).toContain("{footballFormatsWords()}");
  });

  it("the link-preview text lists every format, and stays short", () => {
    for (const n of footballFormats()) expect(SITE_META.ogDescription).toMatch(new RegExp(`\\b${n}\\b`));
    expect(SITE_META.ogDescription).toContain(liveFormatsPhrase());
    expect(SITE_META.ogDescription.length).toBeLessThanOrEqual(160);
    expect(SITE_META.ogDescription).not.toMatch(/[\u2014\u2013]/);
  });

  it("the keywords include every format", () => {
    for (const n of footballFormats()) {
      expect(SITE_META.keywords.some((k) => k.startsWith(`${n}-a-side`))).toBe(true);
    }
  });

  it.each(PUBLIC_FILES)("%s: every hand-written list is complete", (file) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const list of text.match(FORMAT_LIST) ?? []) {
      expect({ list, formats: numbersIn(list) }).toEqual({ list, formats: footballFormats() });
    }
  });
});
