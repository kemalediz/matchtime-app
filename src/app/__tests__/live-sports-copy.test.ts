import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HERO, LANDING_SPOTLIGHTS, SITE_META, SPORTS } from "@/components/landing/landing-content";
import { SPORT_PRESETS } from "@/lib/sport-presets";
import { LIVE_SPORTS, isLiveSport, liveSports, notLiveSportNames, poolSportOfClubSport, type LiveSports } from "@/lib/pool/sports";

/**
 * FOOTBALL ONLY, FOR NOW (Kemal, 2026-10-25): "let's focus on football ...
 * update the website to indicate only football", and "keep it easily
 * extendable". The rule here is not "the site says football": it is
 * "public pages name no sport that is not live", read from the same switch
 * as everything else (`LIVE_SPORTS`, src/lib/pool/sports.ts). Switch a
 * sport on there and this guard lets its name through; nothing to edit here.
 *
 * Covers every public page and its metadata, the /play and manage page
 * copy (both languages), and the derived strings (sports chips, pool card).
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
  "src/app/privacy/privacy-policy-view.tsx",
  "src/lib/i18n/privacy-policy.en.ts",
  "src/lib/i18n/privacy-policy.tr.ts",
  "src/app/play/page.tsx",
  "src/app/play/play-signup.tsx",
  "src/app/play/manage/manage-view.tsx",
  "src/components/pool/pool-profile-fields.tsx",
  "src/lib/i18n/pool-play.en.ts",
  "src/lib/i18n/pool-play.tr.ts",
];

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * The sports a visitor must not read about: the catalogue's that are not
 * live, and the club presets' whose pool sport is not live (netball,
 * volleyball, cricket have no pool entry at all). Futsal is football.
 */
function forbiddenNames(live: LiveSports = LIVE_SPORTS): string[] {
  const presets = SPORT_PRESETS.filter((p) => {
    const s = poolSportOfClubSport({ preset: p.key, name: p.name, playersPerTeam: p.playersPerTeam });
    return !s || !isLiveSport(s.sport, live);
  }).map((p) => p.name.split(" ")[0].toLowerCase());
  return [...new Set([...notLiveSportNames(live), ...presets])];
}

const mentions = (text: string, names: readonly string[]) =>
  names.filter((n) => new RegExp(`(^|[^\\p{L}])${n.replace(/\s+/g, "\\s+")}($|[^\\p{L}])`, "iu").test(text));

const sources = PUBLIC_FILES.map((f) => ({ file: f, text: stripComments(readFileSync(path.join(ROOT, f), "utf8")) }));

describe("public pages name no sport that is not live", () => {
  it("the forbidden list is the switch's, not a typed list", () => {
    expect(forbiddenNames()).toEqual(expect.arrayContaining(["basketball", "netball", "volleyball", "cricket", "tennis", "padel", "badminton", "squash", "table tennis", "snooker", "billiards"]));
    expect(forbiddenNames()).not.toContain("football");
    expect(forbiddenNames()).not.toContain("futsal");
    // Switching basketball on lets it through, with nothing to edit here.
    expect(forbiddenNames({ sports: ["football", "basketball"], other: false })).not.toContain("basketball");
  });

  it.each(sources)("$file", ({ text }) => {
    expect(mentions(text, forbiddenNames())).toEqual([]);
  });

  it("the derived copy (chips, pool card, metadata, hero) too", () => {
    const pool = LANDING_SPOTLIGHTS.find((s) => s.id === "player-pool")!;
    const derived = [...SPORTS, ...pool.points.flatMap((p) => [p.title, p.body]), pool.lead, ...Object.values(SITE_META).flat(), ...Object.values(HERO)].join("\n");
    expect(mentions(derived, forbiddenNames())).toEqual([]);
    expect(derived).not.toMatch(/any sport|custom sport|and more sports|football and more/i);
  });
});

describe("the sports the site shows come from the switch", () => {
  it("the chips are each live sport's formats, from the catalogue", () => {
    expect(SPORTS).toEqual(liveSports().flatMap((s) => s.formats.map((n) => `${s.label.en} ${n}-a-side`)));
    expect(SPORTS).toEqual(["Football 5-a-side", "Football 7-a-side", "Football 8-a-side", "Football 9-a-side", "Football 11-a-side"]);
  });

  it("the pool card lists the live sport and its formats", () => {
    const card = LANDING_SPOTLIGHTS.find((s) => s.id === "player-pool")!.points.find((p) => p.key === "sports")!;
    expect(card.body).toContain("Football 5, 7, 8, 9 or 11-a-side");
  });

  it("search and link-preview text say football", () => {
    expect(SITE_META.title).toMatch(/football/i);
    expect(SITE_META.description).toMatch(/football/i);
    expect(SITE_META.ogDescription).toMatch(/football/i);
    expect(SITE_META.keywords.every((k) => !/sports group|basketball/i.test(k))).toBe(true);
    const layout = readFileSync(path.join(ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("SITE_META");
  });
});
