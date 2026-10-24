/**
 * The landing page's content (src/components/landing/landing-content.ts).
 *
 * Everything a visitor reads in the feature lists and the spotlight
 * sections is data, so these checks read exactly what is rendered:
 * house rules (no em or en dashes, no slashes as separators, "bench" and
 * never "waiting list", no "free" claim), no real club or player names,
 * every claim the page must make present by key, and the numbers in the
 * partner clubs section taken from the rules modules that enforce them.
 * No model calls, no database.
 */
import { describe, it, expect } from "vitest";
import {
  ASK_CHAT,
  FEATURES,
  LANDING_NAV,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYER_STAT_CARDS,
  SPORTS,
  type Spotlight,
} from "../landing-content";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "@/lib/club-partnership-rules";
import { PARTNER_ASKS_PER_DAY } from "@/lib/partner-ask-rules";
import { MAX_RADIUS_MILES } from "@/lib/club-discovery-rules";

/** Fields that are identifiers or styling, never shown as words. */
const NOT_COPY = new Set(["id", "key", "href", "icon", "color", "tone", "from"]);

function copyStrings(value: unknown, path = "content"): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => copyStrings(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => (NOT_COPY.has(k) ? [] : copyStrings(v, `${path}.${k}`)));
  }
  return [];
}

const ALL = copyStrings({ ASK_CHAT, FEATURES, LANDING_NAV, LANDING_SPOTLIGHTS, PERSONAS, PLAYER_STAT_CARDS, SPORTS });

function spotlight(id: string): Spotlight {
  const s = LANDING_SPOTLIGHTS.find((x) => x.id === id);
  if (!s) throw new Error(`no spotlight ${id}`);
  return s;
}

const keysOf = (items: ReadonlyArray<{ key: string }> | undefined) => (items ?? []).map((i) => i.key);

describe("landing content: house rules", () => {
  it("has copy to check", () => {
    expect(ALL.length).toBeGreaterThan(60);
  });

  it("has no em dash or en dash", () => {
    expect(ALL.filter((s) => /[—–]|&mdash;|&ndash;/.test(s.text))).toEqual([]);
  });

  it("uses no slash as a separator", () => {
    expect(ALL.filter((s) => /\//.test(s.text))).toEqual([]);
  });

  it("says bench, never waiting list", () => {
    expect(ALL.filter((s) => /waiting list/i.test(s.text))).toEqual([]);
  });

  it("never claims MatchTime is free", () => {
    expect(ALL.filter((s) => /\bfree\b/i.test(s.text))).toEqual([]);
  });

  it("names no real club, player or venue", () => {
    const real = /\bFNF\b|Sutton|Hamzah|Erdal|Friday MT|\bGoals\b|\bAbid\b|\bElvin\b|\bIbrahim\b|\bNajib\b|Karahan|Ehtisham/;
    expect(ALL.filter((s) => real.test(s.text))).toEqual([]);
  });

  it("is plain text, not HTML entities", () => {
    expect(ALL.filter((s) => /&[a-z]+;/i.test(s.text))).toEqual([]);
  });

  it("spells the bot tag @Match Time", () => {
    expect(ALL.filter((s) => /@MatchTime/.test(s.text))).toEqual([]);
  });

  it("says nothing about a player pool yet (that section arrives with L2)", () => {
    expect(ALL.filter((s) => /\bpool\b/i.test(s.text))).toEqual([]);
  });
});

describe("landing content: structure", () => {
  it("has the spotlight sections in order, each with a unique anchor", () => {
    expect(LANDING_SPOTLIGHTS.map((s) => s.id)).toEqual(["partner-clubs", "admin-group", "your-way"]);
    const ids = LANDING_SPOTLIGHTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every spotlight has a heading, a lead and at least one point", () => {
    for (const s of LANDING_SPOTLIGHTS) {
      expect(s.eyebrow, s.id).toBeTruthy();
      expect(s.title, s.id).toBeTruthy();
      expect(s.lead, s.id).toBeTruthy();
      expect(s.points.length, s.id).toBeGreaterThan(0);
    }
  });

  it("keys are unique inside each list", () => {
    const lists: Array<ReadonlyArray<{ key: string }>> = [FEATURES, PLAYER_STAT_CARDS];
    for (const s of LANDING_SPOTLIGHTS) {
      lists.push(s.points);
      if (s.steps) lists.push(s.steps);
      if (s.note) lists.push(s.note.items);
    }
    for (const l of lists) expect(new Set(keysOf(l)).size).toBe(l.length);
  });

  it("the nav links every spotlight that has a nav label, and only anchors that exist", () => {
    const anchors = new Set(["features", "player-stats", "ask", "how-it-works", "pricing", ...LANDING_SPOTLIGHTS.map((s) => s.id)]);
    for (const n of LANDING_NAV) {
      if (n.href.startsWith("#")) expect(anchors.has(n.href.slice(1)), n.href).toBe(true);
      else expect(n.href).toMatch(/^\/[a-z]/);
    }
    for (const s of LANDING_SPOTLIGHTS.filter((x) => x.navLabel)) {
      expect(LANDING_NAV.some((n) => n.href === `#${s.id}`), s.id).toBe(true);
    }
    expect(LANDING_NAV.map((n) => n.href)).toEqual(expect.arrayContaining(["#partner-clubs", "#admin-group"]));
  });
});

describe("landing content: every claim is present", () => {
  it("partner clubs: how an ask works, step by step", () => {
    expect(keysOf(spotlight("partner-clubs").steps)).toEqual(["find", "ask", "approve", "answer"]);
  });

  it("partner clubs: the privacy promises", () => {
    expect(keysOf(spotlight("partner-clubs").note?.items)).toEqual([
      "numbers",
      "discovery",
      "consent",
      "overlap",
      "limits",
      "control",
    ]);
  });

  it("partner clubs: the benefit, filling missing places across groups", () => {
    const s = spotlight("partner-clubs");
    expect(`${s.title} ${s.lead}`).toMatch(/short/i);
    expect(s.lead).toMatch(/partner club/i);
    expect(keysOf(s.points)).toEqual(["fill", "guest", "both-ways"]);
  });

  it("partner clubs: an example ask that keeps the number private", () => {
    const chat = spotlight("partner-clubs").chat;
    expect(chat?.lines.some((l) => /Your number is not shared/.test(l.text))).toBe(true);
  });

  it("admin group: what organisers can do there", () => {
    expect(keysOf(spotlight("admin-group").points)).toEqual([
      "paste",
      "squad",
      "teams",
      "cancel",
      "posters",
      "pick",
      "partners",
      "fees",
      "notices",
    ]);
    expect(spotlight("admin-group").lead).toMatch(/own words/);
  });

  it("your way: the settings that fit how a group already plays", () => {
    expect(keysOf(spotlight("your-way").points)).toEqual(["rolling", "pick", "announce", "monthly", "language"]);
  });

  it("the features grid still covers the weekly cycle", () => {
    expect(keysOf(FEATURES)).toEqual(
      expect.arrayContaining(["in-out", "bench", "chase", "teams", "ratings", "stats-qa", "payments", "quiet", "replacements"]),
    );
  });
});

describe("landing content: numbers come from the rules that enforce them", () => {
  const limits = spotlight("partner-clubs").note!.items.find((i) => i.key === "limits")!.text;
  const find = spotlight("partner-clubs").steps!.find((i) => i.key === "find")!.body;

  it("the cut-off before kickoff", () => {
    expect(limits).toContain(`${PARTNER_ASK_CUTOFF_DEFAULT_HOURS} hours before kickoff`);
  });

  it("the asks a day into one partner club's group", () => {
    expect(PARTNER_ASKS_PER_DAY).toBe(2);
    expect(limits).toContain("at most two asks a day");
  });

  it("the search radius", () => {
    expect(find).toContain(`${MAX_RADIUS_MILES} miles`);
  });
});
