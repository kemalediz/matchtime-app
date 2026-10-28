import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { firstMonthsFree, firstMonthsFreeBadge } from "@/lib/i18n/free-period";
import {
  STANDARD_PER_GAME_MAX_LABEL,
  STANDARD_PRICE_LABEL,
  standardMonthSharedLabel,
  standardPerPlayerPerGameLabel,
  standardWeeksPlayedLabel,
} from "@/lib/club-price-words";

/**
 * House rules for the public website copy (Kemal): no em dashes or en
 * dashes anywhere a visitor can read them, the real domain is
 * matchtime.ai (never matchtime.app), the bot is tagged as "@Match Time",
 * no fee talk, no "free" claims (MatchTime costs up to £4.99 a month per
 * group since 2026-10-28, £9.99 before, charged only for the weeks played,
 * with a free period of one month since 2026-10-01, two since 2026-10-12
 * and three since 2026-10-28),
 * hello@matchtime.ai as the contact email, no published
 * MatchTime number, and no real club or player names on public pages.
 *
 * Checks the source of every public page with comments stripped, so the
 * rendered strings, metadata and JSON-LD are all covered. The one thing
 * rendered first is the free period's length and the price: the pages
 * build those from `FREE_PERIOD_MONTHS` (i18n/free-period.ts) and
 * `STANDARD_PRICE_PENCE` (club-price-words.ts), so the checks read what a
 * visitor reads, and a page that hardcodes them fails.
 */
const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_FILES = [
  "src/components/landing/landing-page.tsx",
  "src/components/landing/landing-content.ts",
  "src/components/landing/landing-sections.tsx",
  "src/components/landing/stats-showcase.tsx",
  "src/components/landing/landing-nav.tsx",
  "src/components/landing/players-page.tsx",
  "src/app/players/page.tsx",
  "src/components/landing/pricing-section.tsx",
  "src/app/pricing/page.tsx",
  "src/app/help/layout.tsx",
  "src/app/help/page.tsx",
  "src/app/help/player/page.tsx",
  "src/app/help/admin/page.tsx",
  "src/app/layout.tsx",
  "src/app/create-org/page.tsx",
  "src/app/privacy/page.tsx",
  "src/app/privacy/privacy-policy-view.tsx",
];

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The free period sentences, as the pages render them. */
const FIRST_FREE = firstMonthsFree("en"); // "Your first three months are free"
const FIRST_FREE_BADGE = firstMonthsFreeBadge(); // "First three months free"
/** The price words the pages read, as a visitor sees them. */
const PRICE_WORDS: Array<[string, string]> = [
  ["STANDARD_PRICE_LABEL", STANDARD_PRICE_LABEL],
  ["STANDARD_PER_GAME_MAX_LABEL", STANDARD_PER_GAME_MAX_LABEL],
  ["standardWeeksPlayedLabel(3, 4)", standardWeeksPlayedLabel(3, 4)],
  ["standardPerPlayerPerGameLabel(10)", standardPerPlayerPerGameLabel(10)],
  ["standardMonthSharedLabel(20)", standardMonthSharedLabel(20)],
];
function renderFreePeriod(src: string): string {
  let out = src
    .replace(/^import \{[^}]*\} from "@\/lib\/i18n\/free-period";\n/m, "") // the module's name is not copy
    .replace(/^import \{[^}]*\} from "@\/lib\/club-price-words";\n/m, "")
    .replaceAll('{firstMonthsFree("en")}', FIRST_FREE)
    .replaceAll("{firstMonthsFreeBadge()}", FIRST_FREE_BADGE);
  for (const [expr, words] of PRICE_WORDS) out = out.replaceAll(`\${${expr}}`, words).replaceAll(`{${expr}}`, words);
  // An explicit JSX space renders as a space. (Next's SWC drops the leading
  // space of a multi-line JSX text holding an entity such as &apos; when it
  // follows an expression, so the pages write {" "} after each price.)
  return out.replaceAll('{" "}', " ");
}
/** The only "free" a visitor may read: the two sentences above, and "free
 *  period" where the organiser guide refers back to them. */
function withoutFreePeriod(text: string): string {
  return text.replaceAll(FIRST_FREE, "").replaceAll(FIRST_FREE_BADGE, "").replace(/\bfree period\b/gi, "");
}

const sources = PUBLIC_FILES.map((f) => ({
  file: f,
  text: renderFreePeriod(stripComments(readFileSync(path.join(ROOT, f), "utf8"))),
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

  // Kemal (2026-10-01): MatchTime is no longer free. It costs up to £4.99
  // a month per group (2026-10-28), only for the weeks played (2026-10-02),
  // with the first three months free (2026-10-28), so the only "free" a visitor may
  // read is that sentence, its badge and "free period". Catches "free to
  // use", "it's free", "for free", "Free WhatsApp organiser" and the like.
  // The length is never typed into a page: it comes from the constant.
  it.each(sources)("$file does not hardcode the free period's length", ({ file }) => {
    const raw = stripComments(readFileSync(path.join(ROOT, file), "utf8")).replace(/\s+/g, " ");
    expect(raw).not.toMatch(/first (\w+ )?months? (is |are )?free/i);
    expect(raw).not.toMatch(/\bfree (for )?(\w+ )?months?\b/i);
  });

  it.each(sources)("$file does not claim MatchTime is free", ({ text }) => {
    // Collapse whitespace first so a sentence wrapped across source lines
    // ("Your first two months\n are free") reads as the sentence a visitor sees.
    const flat = withoutFreePeriod(text.replace(/\s+/g, " "));
    const hits = [...flat.matchAll(/.{0,40}\bfree\b.{0,40}/gi)].map((m) => m[0]);
    expect(hits).toEqual([]);
  });

  // Kemal: the public contact address is hello@matchtime.ai, and the
  // MatchTime WhatsApp number is never published or implied.
  it.each(sources)("$file uses hello@matchtime.ai as the only contact email", ({ text }) => {
    const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
    expect(emails.filter((e) => e !== "hello@matchtime.ai")).toEqual([]);
  });

  // "\bour number": a partner club's ask promises "Your number is not
  // shared", which is the player's own number, not MatchTime's.
  it.each(sources)("$file never asks visitors to add a MatchTime number", ({ text }) => {
    expect(text).not.toMatch(/MatchTime number|MatchTime's number|MatchTime&apos;s number|\bour number|bot's number/i);
  });

  it.each(sources)("$file names no real club, player or venue", ({ text }) => {
    expect(text).not.toMatch(/Sutton|\bAbid\b|\bElvin\b|\bIbrahim\b|\bEhtisham\b|\bKarahan\b|\bNajib\b|at Goals\b|call Goals/);
  });

  describe("pricing", () => {
    const landing = sources.find((s) => s.file.endsWith("landing-page.tsx"))!.text;
    const layout = sources.find((s) => s.file === "src/app/layout.tsx")!.text;
    const help = sources.find((s) => s.file === "src/app/help/page.tsx")!.text;
    const admin = sources.find((s) => s.file === "src/app/help/admin/page.tsx")!.text;

    const flat = (t: string) => t.replace(/\s+/g, " ");

    it("the free period is three months, in the words the pages use", () => {
      expect(FIRST_FREE).toBe("Your first three months are free");
      expect(FIRST_FREE_BADGE).toBe("First three months free");
    });

    it("no page types the price: it is read from STANDARD_PRICE_PENCE", () => {
      for (const f of PUBLIC_FILES) {
        const raw = stripComments(readFileSync(path.join(ROOT, f), "utf8"));
        for (const typed of [STANDARD_PRICE_LABEL, STANDARD_PER_GAME_MAX_LABEL, standardWeeksPlayedLabel(3, 4), "£9.99", "£7.49", "£2.50"]) {
          expect(raw, `${f} types ${typed}`).not.toContain(typed);
        }
      }
    });

    const pricing = sources.find((s) => s.file.endsWith("pricing-section.tsx"))!.text;

    // Kemal, 2026-10-25: the price has its own page (/pricing,
    // pricing-section.tsx); the home page keeps only its teaser, which
    // renders the same headline.
    it("the pricing section has the price and the free first three months", () => {
      expect(pricing).toMatch(/id="pricing"/);
      expect(pricing).toMatch(/£4\.99/);
      expect(pricing).not.toMatch(/£9\.99/);
      expect(pricing).not.toMatch(/£5(?![\d.])/);
      expect(pricing).toMatch(/per WhatsApp group/i);
      expect(pricing).toContain(FIRST_FREE_BADGE);
      expect(flat(pricing)).toContain(`${FIRST_FREE}, so you can see how it runs your week before you pay.`);
      expect(pricing).not.toMatch(/first month/i);
      expect(flat(pricing)).toMatch(/Even a month charged in full at £4\.99, shared by 20 players, works out at about 25p a player\./);
      expect(pricing).not.toMatch(/50p/);
    });

    it("the home page keeps the free period in its steps and its closing line, free months before the price", () => {
      expect(landing).toContain("<PricingTeaser />");
      expect(flat(landing)).toContain(`${FIRST_FREE}, and you can remove it from your group any time.`);
      expect(flat(landing)).toContain(`${FIRST_FREE}, then it&apos;s up to £4.99 a month`);
      expect(landing).not.toMatch(/first month/i);
    });

    // Kemal, 2026-10-25: lead with the free months, not the price. The
    // pricing section's paragraph states the free period before any price.
    it("the pricing paragraph puts the free months before the price", () => {
      const f = flat(pricing);
      expect(f.indexOf(FIRST_FREE)).toBeGreaterThan(-1);
      const para = f.slice(f.indexOf("<p className=\"mt-5"), f.indexOf("</p>", f.indexOf("<p className=\"mt-5")));
      expect(para.indexOf(FIRST_FREE)).toBeLessThan(para.indexOf("£4.99"));
    });

    // Kemal, 2026-10-02: the club fee is charged by games played, in
    // arrears, up to £4.99 a month (2026-10-28). The site says so, and never
    // states a flat "£4.99 a month" that every month costs.
    it.each([
      ["pricing", () => pricing],
      ["landing", () => landing],
    ] as const)("%s says up to £4.99 a month, never a flat £4.99 a month", (_n, src) => {
      expect(flat(src())).toMatch(/up to (<span[^>]*>)?£4\.99 a month/i);
      expect(flat(src())).not.toMatch(/then it&apos;s £4\.99 a month/i);
      expect(flat(src())).not.toMatch(/(?<!up to )£4\.99 a month per WhatsApp group/i);
    });

    it("the pricing section says you only pay for the weeks you play", () => {
      expect(flat(pricing)).toMatch(/you only pay for the weeks you play/i);
      expect(flat(pricing)).toMatch(/Play 3 weeks out of 4 and it&apos;s £3\.74/);
    });

    it("the home page, before the pricing teaser, carries no price", () => {
      expect(landing.slice(0, landing.indexOf("<PricingTeaser />"))).not.toMatch(/£\d/);
    });

    // Kemal, 2026-10-01: no price in Google results or link previews.
    // The price lives on the page (pricing section) only.
    it("search and link-preview text carry no price and no free claim", () => {
      expect(layout).not.toMatch(/£\d/);
      expect(layout).not.toMatch(/\bfree\b/i);
      expect(landing).not.toMatch(/offers:\s*\{/);
      expect(landing).not.toMatch(/priceCurrency/);
    });

    it("the help pages state the price as a maximum, for the weeks played", () => {
      for (const t of [help, admin]) {
        expect(flat(t)).toMatch(/up to £4\.99 a month/);
        expect(flat(t)).not.toMatch(/(?<!up to )£4\.99 a month/);
        expect(t).not.toMatch(/£9\.99/);
        expect(t).not.toMatch(/£5(?![\d.])/);
        expect(flat(t)).toContain(`${FIRST_FREE}.`);
        expect(t).not.toMatch(/first month/i);
        expect(flat(t)).toMatch(/only pay for the weeks you play/i);
      }
    });

    // The organiser guide's "Club fee" section (Kemal, P4 brief): the first
    // three months free from the day MatchTime goes live in the group; then only the games played, up to £4.99 a
    // month per group including VAT; the money collector or the owner adds
    // a card; reminders; a week's grace; then quiet until a card is added,
    // data kept; stop any time; the tip of 13p a player per game at most
    // (£1.25 a game, £4.99 over four weeks).
    it("the organiser guide has a Club fee section covering every point", () => {
      const start = admin.indexOf('id="club-fee"');
      expect(start).toBeGreaterThan(-1);
      const end = admin.indexOf("<h2", start);
      const section = flat(admin.slice(start, end === -1 ? undefined : end));
      for (const re of [
        // From go-live, not approval (owner decision 2, 2026-10-12): true for a
        // club that is held while it sets up, and for one that is not (for
        // it the approval is the moment MatchTime goes live in its group).
        new RegExp(`${FIRST_FREE}, counted from the day MatchTime goes live in your group\\.`),
        /Nine days before your free period ends/,
        /If the free period ends without a card, MatchTime keeps running for a week/,
        /goes live in your group/i,
        /only (pay|charged) for the (games|weeks) (you play|played)/i,
        /up to £4\.99 a month/i,
        /Play 3 weeks out of 4 and it&apos;s £3\.74/,
        /at most £1\.25 \(£4\.99 over four weeks\)/,
        /per WhatsApp group/i,
        /VAT/,
        /money collector/i,
        /owner/i,
        /add(s)? a card/i,
        /reminder/i,
        /a week/i,
        /quiet/i,
        /(data|players, matches and stats) (is|are) (all )?kept/i,
        /Stop paying/,
        /13p a player per game/,
        /at most/i,
        /billing page/i,
      ]) {
        expect(section, String(re)).toMatch(re);
      }
    });

    it("never claims MatchTime collects the club fee itself", () => {
      for (const { text } of sources) {
        expect(text).not.toMatch(/(collects?|charges?) the (club|monthly) fee (for you|automatically)|automatically (collect|split|charge)/i);
      }
    });
  });
});
