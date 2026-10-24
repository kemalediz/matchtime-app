import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { firstMonthsFree, firstMonthsFreeBadge } from "@/lib/i18n/free-period";

/**
 * House rules for the public website copy (Kemal): no em dashes or en
 * dashes anywhere a visitor can read them, the real domain is
 * matchtime.ai (never matchtime.app), the bot is tagged as "@Match Time",
 * no fee talk, no "free" claims (MatchTime costs up to £9.99 a month per
 * group, charged only for the weeks played, with the first two months
 * free: one month since 2026-10-01, two since 2026-10-12),
 * hello@matchtime.ai as the contact email, no published
 * MatchTime number, and no real club or player names on public pages.
 *
 * Checks the source of every public page with comments stripped, so the
 * rendered strings, metadata and JSON-LD are all covered. The one thing
 * rendered first is the free period's length: the pages build that sentence
 * from `FREE_PERIOD_MONTHS` (i18n/free-period.ts), so the checks read what
 * a visitor reads, and a page that hardcodes the length fails.
 */
const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_FILES = [
  "src/components/landing/landing-page.tsx",
  "src/components/landing/landing-content.ts",
  "src/components/landing/landing-sections.tsx",
  "src/components/landing/stats-showcase.tsx",
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
const FIRST_FREE = firstMonthsFree("en"); // "Your first two months are free"
const FIRST_FREE_BADGE = firstMonthsFreeBadge(); // "First two months free"
function renderFreePeriod(src: string): string {
  return src
    .replace(/^import \{[^}]*\} from "@\/lib\/i18n\/free-period";\n/m, "") // the module's name is not copy
    .replaceAll('{firstMonthsFree("en")}', FIRST_FREE)
    .replaceAll("{firstMonthsFreeBadge()}", FIRST_FREE_BADGE);
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

  // Kemal (2026-10-01): MatchTime is no longer free. It costs up to £9.99
  // a month per group, only for the weeks played (2026-10-02), with the
  // first two months free (2026-10-12), so the only "free" a visitor may
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

    it("the free period is two months, in the words the pages use", () => {
      expect(FIRST_FREE).toBe("Your first two months are free");
      expect(FIRST_FREE_BADGE).toBe("First two months free");
    });

    it("the landing page has a pricing section with the price and the free first two months", () => {
      expect(landing).toMatch(/id="pricing"/);
      expect(landing).toMatch(/£9\.99/);
      expect(landing).not.toMatch(/£5(?![\d.])/);
      expect(landing).toMatch(/per group/i);
      expect(landing).toContain(FIRST_FREE_BADGE);
      expect(flat(landing)).toContain(`${FIRST_FREE}, so you can see how it runs your week before you pay.`);
      expect(flat(landing)).toContain(`${FIRST_FREE}, and you can remove it from your group any time.`);
      expect(flat(landing)).toContain(`${FIRST_FREE}, then it&apos;s up to £9.99 a month`);
      expect(landing).not.toMatch(/first month/i);
      expect(landing).toMatch(/about 50p a player/);
      expect(landing).not.toMatch(/25p/);
    });

    // Kemal, 2026-10-02: the club fee is charged by games played, in
    // arrears, up to £9.99 a month. The site says so, and never states a
    // flat "£9.99 a month" that every month costs.
    it("the landing page says it is up to £9.99 a month and you only pay for the weeks you play", () => {
      expect(flat(landing)).toMatch(/up to £9\.99 a month/i);
      expect(flat(landing)).toMatch(/you only pay for the weeks you play/i);
      expect(flat(landing)).toMatch(/Play 3 weeks out of 4 and it&apos;s £7\.49/);
      expect(flat(landing)).not.toMatch(/then it&apos;s £9\.99 a month/i);
      expect(flat(landing)).not.toMatch(/(?<!up to )£9\.99 a month per WhatsApp group/i);
    });

    it("the hero, before the pricing section, carries no price", () => {
      expect(landing.slice(0, landing.indexOf('id="pricing"'))).not.toMatch(/£\d/);
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
        expect(flat(t)).toMatch(/up to £9\.99 a month/);
        expect(flat(t)).not.toMatch(/(?<!up to )£9\.99 a month/);
        expect(t).not.toMatch(/£5(?![\d.])/);
        expect(flat(t)).toContain(`${FIRST_FREE}.`);
        expect(t).not.toMatch(/first month/i);
        expect(flat(t)).toMatch(/only pay for the weeks you play/i);
      }
    });

    // The organiser guide's "Club fee" section (Kemal, P4 brief): the first
    // two months free from the day MatchTime goes live in the group; then only the games played, up to £9.99 a
    // month per group including VAT; the money collector or the owner adds
    // a card; reminders; a week's grace; then quiet until a card is added,
    // data kept; stop any time; the tip of 25p a player per game at most.
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
        /up to £9\.99 a month/i,
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
        /25p a player per game/,
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
