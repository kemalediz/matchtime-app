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
  DROPOUT_STORY,
  FEATURES,
  HERO,
  HERO_LINKS,
  HERO_POOL_INVITE,
  LANDING_NAV_GROUPS,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYERS_FAQ,
  PLAYERS_PAGE,
  PLAYER_STAT_CARDS,
  POOL_SITE_SOURCES,
  SPORTS,
  allNavLinks,
  poolOpeningLine,
  spotlightFor,
  type Cta,
  type Spotlight,
} from "../landing-content";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "@/lib/club-partnership-rules";
import { PARTNER_ASKS_PER_DAY } from "@/lib/partner-ask-rules";
import { MAX_RADIUS_MILES } from "@/lib/club-discovery-rules";
import { POOL_PLAY_PATH, PLAYERS_PAGE_PATH } from "@/lib/pool/paths";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { POOL_CAPS, POOL_MIN_AGE, POOL_QUIET_HOURS } from "@/lib/pool/rules";
import { boldSegments, dropoutBotLines, withoutEmoji } from "../dropout-bot-lines";
import { en } from "@/lib/i18n/strings.en";
import { readFileSync } from "node:fs";
import path from "node:path";

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

const ALL = copyStrings({
  ASK_CHAT,
  DROPOUT_STORY,
  FEATURES,
  HERO,
  HERO_POOL_INVITE,
  LANDING_NAV_GROUPS,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYERS_FAQ,
  PLAYERS_PAGE,
  PLAYER_STAT_CARDS,
  SPORTS,
});

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

  it("never says messages a week: the cap is on game offers (Kemal, 2026-10-25)", () => {
    expect(ALL.filter((s) => /messages a week/i.test(s.text))).toEqual([]);
  });
});

describe("landing content: structure", () => {
  it("has the spotlight sections in order, each with a unique anchor", () => {
    expect(LANDING_SPOTLIGHTS.map((s) => s.id)).toEqual(["player-pool", "partner-clubs", "admin-group", "your-way"]);
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

});

/** The home page's own anchors, and the public pages the menu may open. */
const HOME_ANCHORS = new Set(["features", "player-stats", "ask", "how-it-works", "pricing", ...LANDING_SPOTLIGHTS.map((s) => s.id)]);
const MENU_PAGES = new Set(["/pricing", "/signup", "/help/player", "/help/admin", PLAYERS_PAGE_PATH, POOL_PLAY_PATH]);

describe("landing content: the menu, one for clubs and one for players (Kemal, 2026-10-25)", () => {
  it("has two groups, clubs first, each with its own button", () => {
    expect(LANDING_NAV_GROUPS.map((g) => [g.id, g.label])).toEqual([
      ["clubs", "For clubs"],
      ["players", "For players"],
    ]);
    const [clubs, players] = LANDING_NAV_GROUPS;
    expect(clubs.cta).toEqual({ label: "Start your group", href: "/signup" });
    expect(players.cta).toEqual({ label: "Find a game", href: `${POOL_PLAY_PATH}?src=${POOL_SITE_SOURCES.nav}` });
  });

  it("clubs get the organiser sections, players get the pool, their stats and their guide", () => {
    const hrefs = (id: string) => LANDING_NAV_GROUPS.find((g) => g.id === id)!.links.map((l) => l.href);
    expect(hrefs("clubs")).toEqual(["/#features", "/#partner-clubs", "/#admin-group", "/#how-it-works", "/pricing", "/help/admin"]);
    expect(hrefs("players")).toEqual([PLAYERS_PAGE_PATH, "/#player-pool", "/#player-stats", "/help/player"]);
  });

  it("every spotlight with a nav label is in its group's menu", () => {
    for (const s of LANDING_SPOTLIGHTS.filter((x) => x.navLabel)) {
      const g = LANDING_NAV_GROUPS.find((x) => x.id === s.navGroup);
      expect(g, s.id).toBeDefined();
      expect(g!.links.some((l) => l.href === `/#${s.id}` && l.label === s.navLabel), s.id).toBe(true);
    }
  });

  it("every menu link opens an anchor that exists on the home page or a public page", () => {
    for (const n of allNavLinks()) {
      const [pathname, hash] = n.href.split("#");
      if (hash !== undefined) {
        expect(pathname, n.href).toBe("/");
        expect(HOME_ANCHORS.has(hash), n.href).toBe(true);
      } else {
        expect(MENU_PAGES.has(n.href.split("?")[0]), n.href).toBe(true);
      }
    }
  });

  it("no link sits in both groups, and labels are unique in each", () => {
    const [clubs, players] = LANDING_NAV_GROUPS;
    const clubHrefs = new Set(clubs.links.map((l) => l.href));
    expect(players.links.filter((l) => clubHrefs.has(l.href))).toEqual([]);
    for (const g of LANDING_NAV_GROUPS) expect(new Set(g.links.map((l) => l.label)).size).toBe(g.links.length);
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

describe("landing content: the player pool (G0 part 2)", () => {
  const s = spotlight("player-pool");

  it("invites players to /play with the pulsing button", () => {
    expect(s.cta).toEqual({ label: "Join the MatchTime player pool", href: POOL_PLAY_PATH, pulse: true });
  });

  it("only the player invitations pulse: a deliberate, pinned list", () => {
    const buttons: Record<string, Cta | undefined> = {
      hero: HERO_POOL_INVITE.cta,
      "players-page": PLAYERS_PAGE.cta,
      "players-page-closing": PLAYERS_PAGE.closingCta,
      ...Object.fromEntries(LANDING_SPOTLIGHTS.map((x) => [`spotlight:${x.id}`, x.cta])),
    };
    const pulsing = Object.entries(buttons).filter(([, b]) => b?.pulse).map(([k]) => k);
    expect(pulsing).toEqual(["hero", "players-page", "spotlight:player-pool"]);
  });

  it("how joining works, the privacy promises, and the points", () => {
    expect(keysOf(s.steps)).toEqual(["signup", "confirm", "offers"]);
    expect(keysOf(s.note?.items)).toEqual(["number", "name", "area"]);
    expect(keysOf(s.points)).toEqual(["sports", "control", "age"]);
  });

  it("the quiet hours and the age come from pool/rules.ts; the weekly cap is not on the site", () => {
    const offers = s.steps!.find((x) => x.key === "offers")!.body;
    expect(offers).not.toMatch(/a week|at most/i);
    expect(offers).toContain(`between ${POOL_QUIET_HOURS.from} and ${POOL_QUIET_HOURS.to}`);
    expect(s.points.find((x) => x.key === "age")!.title).toBe(`${POOL_MIN_AGE} and over`);
  });

  it("claims nothing the pool does not do yet: offers only once it opens", () => {
    expect(s.steps!.map((x) => x.body).join(" ")).toMatch(/opens/);
  });

  it("its lead says nothing about the early list: that line follows the server's switch", () => {
    expect(s.lead).not.toMatch(/early|opening/i);
    expect(s.poolOpeningLine).toBe(true);
  });

  it("the opening line is /play's own note, early list only when sign-ups go on it", () => {
    const en = poolPageCopy("en").signup;
    expect(poolOpeningLine(true)).toBe(en.earlyNote);
    expect(poolOpeningLine(false)).toBe(en.openNote);
    expect(poolOpeningLine(true)).toContain("early sign-up list");
    expect(poolOpeningLine(false)).not.toMatch(/early/i);
  });

  it("spotlightFor adds the opening line to the pool section only", () => {
    expect(spotlightFor(s, false).lead).toBe(`${s.lead} ${poolOpeningLine(false)}`);
    expect(spotlightFor(s, true).lead).toBe(`${s.lead} ${poolOpeningLine(true)}`);
    const other = spotlight("partner-clubs");
    expect(spotlightFor(other, true)).toBe(other);
  });

  it("the pulse flashes under 3 times a second and stops for reduced motion (globals.css)", () => {
    const css = readFileSync(path.join(__dirname, "..", "..", "..", "app", "globals.css"), "utf8");
    const m = /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.pool-invite-pulse\s*\{\s*animation:\s*pool-invite-pulse\s+([\d.]+)(m?s)/.exec(css);
    expect(m).not.toBeNull();
    const seconds = Number(m![1]) / (m![2] === "ms" ? 1000 : 1);
    expect(1 / seconds).toBeLessThan(3);
    // The only animation rule for the class is the no-preference one.
    expect(css.match(/\.pool-invite-pulse\s*\{/g)).toHaveLength(1);
  });
});

describe("landing content: the hero's invitation to players (Kemal, 2026-10-25)", () => {
  const h = HERO_POOL_INVITE;

  it("says the benefit: asked when a nearby club is a player short, you decide, no app, stop any time", () => {
    expect(h.eyebrow).toBe("For players");
    expect(h.title).toMatch(/near you/);
    expect(h.title).toMatch(/player short/);
    const body = h.body;
    expect(body).toMatch(/WhatsApp/);
    expect(body).toMatch(/you decide/);
    expect(body).toMatch(/No app/);
    expect(body).toMatch(/stop any time/);
  });

  it("the button goes to /play with the hero's source code, and pulses", () => {
    expect(h.cta).toEqual({ label: "Join the MatchTime player pool", href: `${POOL_PLAY_PATH}?src=${POOL_SITE_SOURCES.hero}`, pulse: true });
  });

  it("a second link explains it on the players' page", () => {
    expect(h.more).toEqual({ label: "How it works for players", href: PLAYERS_PAGE_PATH });
  });

  it("the small print is the age from pool/rules.ts and says it is opening town by town, with no weekly cap", () => {
    expect(h.smallPrint).toBe(`${POOL_MIN_AGE} and over. Opening town by town.`);
  });

  it("every site source code is one /play reads as a campaign code", () => {
    const codes = Object.values(POOL_SITE_SOURCES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(readSignupSource({ src: c }).campaignCode).toBe(c);
  });
});

describe("landing content: the players' page (/players)", () => {
  const pool = spotlight("player-pool");

  it("reuses the pool section's steps, points, privacy note and footnote, never a copy", () => {
    expect(PLAYERS_PAGE.steps).toBe(pool.steps);
    expect(PLAYERS_PAGE.points).toBe(pool.points);
    expect(PLAYERS_PAGE.note).toBe(pool.note);
    expect(PLAYERS_PAGE.footnote).toBe(pool.footnote);
    expect(PLAYERS_PAGE.title).toBe(HERO_POOL_INVITE.title);
    expect(PLAYERS_PAGE.lead).toBe(pool.lead);
  });

  it("its big button pulses and goes to /play with the page's source code; the closing one does not pulse", () => {
    expect(PLAYERS_PAGE.cta).toEqual({ label: "Join the MatchTime player pool", href: `${POOL_PLAY_PATH}?src=${POOL_SITE_SOURCES.players}`, pulse: true });
    expect(PLAYERS_PAGE.closingCta).toEqual({ label: "Join the MatchTime player pool", href: `${POOL_PLAY_PATH}?src=${POOL_SITE_SOURCES.players}` });
  });

  it("its small print is the pool's age limit, without repeating the lead's town by town or a weekly cap", () => {
    expect(PLAYERS_PAGE.smallPrint).toBe(`${POOL_MIN_AGE} and over.`);
  });

  it("the questions players ask, each answered once", () => {
    expect(keysOf(PLAYERS_FAQ)).toEqual(["cost", "say-no", "stop", "join-club", "own-club"]);
    expect(new Set(keysOf(PLAYERS_FAQ)).size).toBe(PLAYERS_FAQ.length);
  });

  it("the ignored-offers pause comes from pool/rules.ts", () => {
    expect(PLAYERS_FAQ.find((q) => q.key === "say-no")!.answer).toContain(`${POOL_CAPS.ignoredInARowPause} offers in a row`);
  });

  it("the club answer is the pool section's own footnote", () => {
    expect(PLAYERS_FAQ.find((q) => q.key === "own-club")!.answer).toBe(pool.footnote);
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

// ─── Variant D: the hero and the dropout story (2026-10-26) ───────────

/** Anything that reads as pricing (Kemal: pricing belongs on the pricing page). */
const PRICING = /£|\bfree\b|months? free|pay only|weeks you play|per month|a month|price|pricing|\bcost/i;

describe("landing content: the hero (variant D)", () => {
  it("is D's words, in order", () => {
    expect(HERO).toEqual({
      pill: "For weekly football groups",
      titleLead: "Your players WhatsApp.",
      titleTail: "MatchTime runs the game.",
      lead: "Who's in, the bench and fair teams, sorted right in your group chat.",
      primaryCta: "Start your group",
      secondaryCta: "See how it works",
      tick: "No app for players",
      poolLead: "Want more games?",
      poolLabel: "Join the player pool near you",
    });
  });

  it("says nothing about pricing", () => {
    expect(Object.values(HERO).filter((t) => PRICING.test(t))).toEqual([]);
  });

  it("links: sign-up, the how-it-works section, and the pool invitation's own /play link", () => {
    expect(HERO_LINKS).toEqual({ primary: "/signup", secondary: "#how-it-works", pool: HERO_POOL_INVITE.cta.href });
    expect(HERO_LINKS.pool).toBe(`${POOL_PLAY_PATH}?src=${POOL_SITE_SOURCES.hero}`);
  });
});

describe("landing content: what happens when a player drops out (variant D)", () => {
  const d = DROPOUT_STORY;
  const bot = dropoutBotLines();

  it("has the heading, lead and the five timeline steps", () => {
    expect(d.title).toBe("What happens when a player drops out on match day");
    expect(d.lead).toBe("It all happens in the group chat. No phone calls, no chasing.");
    expect(keysOf(d.timeline)).toEqual(["out", "bench", "claim", "teams", "later"]);
  });

  it("never overclaims: the bench is tagged and the first to reply IN plays; the redrawn sheet goes to the admin group", () => {
    const steps = d.timeline.map((x) => `${x.title} ${x.body}`).join(" ");
    expect(steps).toMatch(/bench is tagged/);
    expect(steps).toMatch(/First to claim it plays/);
    expect(steps).toMatch(/replies IN/);
    expect(steps).toMatch(/admin group gets a fresh team sheet/);
    expect(steps).not.toMatch(/automatic/i);
  });

  it("says nothing about pricing, and nothing about a weekly cap", () => {
    expect(copyStrings(d).filter((x) => PRICING.test(x.text))).toEqual([]);
    expect(copyStrings(d).filter((x) => /a week|per week|at most/i.test(x.text))).toEqual([]);
  });

  it("the bench offer is the bot's real group post, without its emoji", () => {
    const real = en.bench_offer_group_post({
      context: en.bench_offer_context_fixture({ activityName: "Thursday 7-a-side", day: null }),
      tagList: "@Kai @Ben",
      reactions: false,
    });
    expect(bot["bench-offer"]).toBe(withoutEmoji(real));
    expect(bot["bench-offer"]).toBe(
      "A slot just opened for *Thursday 7-a-side* tonight. *First to claim it plays.*\n\n@Kai @Ben\n\n" +
        "Just reply *IN* here to take it. No rush and no timeout, whoever is free first gets it and everyone else stays on the bench.",
    );
  });

  it("the claim is the bot's real bench_claim_replacing line, without its emoji", () => {
    expect(bot["bench-claim"]).toBe(withoutEmoji(en.bench_claim_replacing({ claimer: "Kai", dropped: "Joe", confirmed: 14, maxPlayers: 14 })));
    expect(bot["bench-claim"]).toBe("*Kai* is in, replacing *Joe*. Squad *14/14*");
  });

  it("the drawn bot lines carry no emoji and no dashes", () => {
    for (const t of Object.values(bot)) {
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(t).not.toMatch(/[—–]/);
    }
  });

  it("the story is consistent: the one who claims is on the bench, the one who stayed on the bench is in no team", () => {
    expect(d.chat.bench).toContain(d.chat.claimer);
    const teams = d.chat.messages.flatMap((m) => ("teams" in m ? m.teams.map((t) => t.players) : [])).join(" ");
    expect(teams).toContain(d.chat.claimer);
    expect(teams).not.toContain(d.chat.dropped);
    for (const b of d.chat.bench.filter((n) => n !== d.chat.claimer)) expect(teams).not.toContain(b);
  });

  it("boldSegments turns WhatsApp bold into marked parts", () => {
    expect(boldSegments("Just reply *IN* here")).toEqual([
      { text: "Just reply ", bold: false },
      { text: "IN", bold: true },
      { text: " here", bold: false },
    ]);
  });
});
