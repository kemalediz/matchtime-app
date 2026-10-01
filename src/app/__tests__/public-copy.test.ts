import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * House rules for the public website copy (Kemal): no em dashes or en
 * dashes anywhere a visitor can read them, the real domain is
 * matchtime.ai (never matchtime.app), the bot is tagged as "@Match Time",
 * no fee talk, no "free" claims (MatchTime costs £9.99 a month per group
 * with the first month free, since 2026-10-01), hello@matchtime.ai as the contact email, no published
 * MatchTime number, and no real club or player names on public pages.
 *
 * Checks the source of every public page with comments stripped, so the
 * rendered strings, metadata and JSON-LD are all covered.
 */
const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_FILES = [
  "src/components/landing/landing-page.tsx",
  "src/components/landing/stats-showcase.tsx",
  "src/app/help/layout.tsx",
  "src/app/help/page.tsx",
  "src/app/help/player/page.tsx",
  "src/app/help/admin/page.tsx",
  "src/app/layout.tsx",
  "src/app/create-org/page.tsx",
];

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const sources = PUBLIC_FILES.map((f) => ({
  file: f,
  text: stripComments(readFileSync(path.join(ROOT, f), "utf8")),
}));

describe("public website copy", () => {
  it.each(sources)("$file has no em dash or en dash", ({ text }) => {
    const hits = text.split("\n").filter((l) => /[—–]|&mdash;|&ndash;/.test(l));
    expect(hits).toEqual([]);
  });

  it.each(sources)("$file never says matchtime.app", ({ text }) => {
    expect(text).not.toMatch(/matchtime\.app/i);
  });

  it.each(sources)("$file spells the bot tag @Match Time", ({ text }) => {
    expect(text).not.toMatch(/@MatchTime/);
  });

  // Kemal (PR #137 review): payments are described as a feature only;
  // no platform, card or processing fee talk on public pages.
  it.each(sources)("$file does not talk about fees", ({ text }) => {
    expect(text).not.toMatch(/(^|[^\d])1\s?%|MatchTime fee|card fee|payment fee|processing fee|platform fee/i);
  });

  // Kemal (2026-10-01): MatchTime is no longer free. It costs £9.99 a
  // month per group with the first month free, so the only "free" a visitor may
  // read is "first month free". Catches "free to use", "it's free",
  // "for free", "Free WhatsApp organiser" and the like.
  it.each(sources)("$file does not claim MatchTime is free", ({ text }) => {
    // Collapse whitespace first so a sentence wrapped across source lines
    // ("Your first month\n is free") reads as the sentence a visitor sees.
    const flat = text.replace(/\s+/g, " ").replace(/first month (is )?free/gi, "");
    const hits = [...flat.matchAll(/.{0,40}\bfree\b.{0,40}/gi)].map((m) => m[0]);
    expect(hits).toEqual([]);
  });

  // Kemal: the public contact address is hello@matchtime.ai, and the
  // MatchTime WhatsApp number is never published or implied.
  it.each(sources)("$file uses hello@matchtime.ai as the only contact email", ({ text }) => {
    const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
    expect(emails.filter((e) => e !== "hello@matchtime.ai")).toEqual([]);
  });

  it.each(sources)("$file never asks visitors to add a MatchTime number", ({ text }) => {
    expect(text).not.toMatch(/MatchTime number|MatchTime's number|MatchTime&apos;s number|our number|bot's number/i);
  });

  it.each(sources)("$file names no real club, player or venue", ({ text }) => {
    expect(text).not.toMatch(/Sutton|\bAbid\b|\bElvin\b|\bIbrahim\b|\bEhtisham\b|\bKarahan\b|\bNajib\b|at Goals\b|call Goals/);
  });

  describe("pricing", () => {
    const landing = sources.find((s) => s.file.endsWith("landing-page.tsx"))!.text;
    const layout = sources.find((s) => s.file === "src/app/layout.tsx")!.text;
    const help = sources.find((s) => s.file === "src/app/help/page.tsx")!.text;
    const admin = sources.find((s) => s.file === "src/app/help/admin/page.tsx")!.text;

    it("the landing page has a pricing section with the price and the free first month", () => {
      expect(landing).toMatch(/id="pricing"/);
      expect(landing).toMatch(/£9\.99/);
      expect(landing).not.toMatch(/£5(?![\d.])/);
      expect(landing).toMatch(/per group/i);
      expect(landing).toMatch(/first month (is )?free/i);
      expect(landing).toMatch(/about 50p a player/);
      expect(landing).not.toMatch(/25p/);
    });

    // Kemal, 2026-10-01: no price in Google results or link previews.
    // The price lives on the page (pricing section) only.
    it("search and link-preview text carry no price and no free claim", () => {
      expect(layout).not.toMatch(/£\d/);
      expect(layout).not.toMatch(/\bfree\b/i);
      expect(landing).not.toMatch(/offers:\s*\{/);
      expect(landing).not.toMatch(/priceCurrency/);
    });

    it("the help pages state the price", () => {
      for (const t of [help, admin]) {
        expect(t).toMatch(/£9\.99 a month/);
        expect(t).not.toMatch(/£5(?![\d.])/);
        expect(t).toMatch(/first month (is )?free/i);
      }
    });

    it("never claims MatchTime collects the club fee itself", () => {
      for (const { text } of sources) {
        expect(text).not.toMatch(/(collects?|charges?) the (club|monthly) fee (for you|automatically)|automatically (collect|split|charge)/i);
      }
    });
  });
});
