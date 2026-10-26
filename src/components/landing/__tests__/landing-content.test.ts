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
  HERO,
  HERO_DECK,
  HERO_POOL_INVITE,
  LANDING_NAV_GROUPS,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYERS_FAQ,
  PLAYERS_PAGE,
  PLAYER_STAT_CARDS,
  POOL_OFFER_CHAT,
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
import { POOL_AFTER_PARTNERS_MINS } from "@/lib/pool/round-rules";
import { SPORT_LEVELS, levelLabel } from "@/lib/pool/sports";
import { poolOfferEn } from "@/lib/i18n/pool-offer.en";
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
  FEATURES,
  HERO,
  // The deck's chats quote MatchTime's real messages ("Squad 14/14"); its own
  // tests below check them. Everything else on the deck is held here.
  HERO_DECK: { ...HERO_DECK, dotLabel: HERO_DECK.dotLabel(1), cards: HERO_DECK.cards.map((c) => ({ ...c, chat: undefined })) },
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

  it("names no language anywhere: MatchTime is multi-lingual (round two, 2026-10-26)", () => {
    const named = /English|Turkish|T[uü]rk|Spanish|French|German|Polish|Arabic|Urdu|Portuguese|Italian|VARIM|YOKUM/i;
    expect(ALL.filter((s) => named.test(s.text))).toEqual([]);
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

  it("how a call-up works, the privacy promises, and the points", () => {
    expect(keysOf(s.steps)).toEqual(["signup", "short", "offer", "yes"]);
    expect(keysOf(s.note?.items)).toEqual(["number", "name", "area"]);
    expect(keysOf(s.points)).toEqual(["sports", "level", "control", "age"]);
  });

  it("the call-up headline, the benefit, and the four steps' facts (round two, 2026-10-26)", () => {
    expect(s.title).toBe("Get called up for local games.");
    expect(s.lead).toBe(
      "Tell MatchTime your level, when you can play and how far you'll travel. When a club nearby needs one more, the game comes to you on WhatsApp.",
    );
    expect(s.benefit).toBe("More games, new teammates, no hunting round group chats.");
    const [signup, short, offer, yes] = s.steps!.map((x) => x.body);
    expect(signup).toMatch(/level/);
    expect(signup).toMatch(/when you can play/);
    expect(signup).toMatch(/how far you'll travel/);
    expect(signup).toMatch(/confirm on WhatsApp/);
    expect(short).toMatch(/near/);
    expect(short).toMatch(/a time that suits you/);
    for (const fact of ["club", "day and time", "how far", "kind of game"]) expect(offer).toContain(fact);
    expect(s.steps!.find((x) => x.key === "offer")!.title).toMatch(/WhatsApp/);
    expect(yes).toMatch(/Reply yes or tap/);
    // Never overclaims: a yes takes the place only while it is open, and
    // where the organisers pick it goes on their bench (pool/accept.ts).
    expect(yes).toMatch(/If the place is still open/);
    expect(yes).toMatch(/on the bench where the organisers pick/);
    expect(yes).not.toMatch(/it's yours/);
  });

  it("the facts are kept: adults only, quiet hours, stop any time, number shared only when you join a group, postcode district", () => {
    const text = copyStrings(s).map((x) => x.text).join(" ");
    expect(text).toContain(`${POOL_MIN_AGE} and over`);
    expect(text).toContain(`between ${POOL_QUIET_HOURS.from} and ${POOL_QUIET_HOURS.to}`);
    expect(text).toMatch(/Stop any time/);
    expect(s.note!.items.find((i) => i.key === "number")!.text).toMatch(/only shared if you join a club's WhatsApp group yourself/);
    expect(s.note!.items.find((i) => i.key === "area")!.text).toMatch(/postcode district, never your full postcode/);
  });

  it("the level claim is what matching does: optional, self-chosen, and only filters when a club's ask names levels", () => {
    const level = s.points.find((p) => p.key === "level")!;
    for (const l of SPORT_LEVELS) expect(level.body).toContain(levelLabel(l, "en"));
    expect(level.body).toMatch(/or leave it blank/);
    expect(level.body).toContain("A club looking for a certain level only asks players who match it.");
    // Never: picked by ratings, or every game at your level.
    const poolCopy = copyStrings({ s, HERO_POOL_INVITE, short: HERO_DECK.cards.find((c) => c.key === "short") }).map((x) => x.text);
    expect(poolCopy.filter((t) => /rating|rated|every game|always (at|your) level|matched to your (skill|level)/i.test(t))).toEqual([]);
  });

  it("the drawn offer is the real offer copy, in poolOfferLines order, emoji stripped, with no fee line", () => {
    const strip = (t: string) => t.replace(/\p{Extended_Pictographic}\uFE0F?\s*/gu, "").trim();
    expect(s.offerChat).toBe(POOL_OFFER_CHAT);
    const [offer, reply, placed] = POOL_OFFER_CHAT.lines;
    const lines = offer.text.split("\n");
    expect(lines).toEqual([
      strip(poolOfferEn.offer_head({ club: "Riverside FC", places: 1, game: poolOfferEn.game_with_format({ format: "7-a-side", sport: "Football" }) })),
      strip(poolOfferEn.offer_when({ day: "Tue 20 Oct, 20:00", mins: 60 })),
      `*Riverside Sports Centre*. ${poolOfferEn.distance({ miles: "1.2", one: false })}`,
      `${poolOfferEn.style_casual}. ${poolOfferEn.club_weekly({ members: 18 })}`,
      "Would you like the place? Reply here, or tap to answer:",
    ]);
    expect(reply.from).toBe("self");
    expect(placed.text).toBe(strip(poolOfferEn.placed_in({ club: "Riverside FC", day: "Tue 20 Oct, 20:00", venue: "Riverside Sports Centre" })));
    const all = copyStrings(POOL_OFFER_CHAT).map((x) => x.text).join(" ");
    expect(all).not.toMatch(/£|match fee|\p{Extended_Pictographic}/u);
    expect(all).not.toMatch(/[—–]/);
  });

  it("the quiet hours and the age come from pool/rules.ts; the weekly cap is not on the site", () => {
    const offers = s.steps!.find((x) => x.key === "offer")!.body;
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

describe("landing content: the hero's players card (round two, 2026-10-26)", () => {
  const h = HERO_POOL_INVITE;

  it("a New badge, the call-up title and the one line", () => {
    expect(h.badge).toBe("New");
    expect(h.eyebrow).toBe("For players");
    expect(h.title).toBe("Get called up for local games");
    expect(h.body).toBe(
      "Join the MatchTime player pool. When a club near you is a player short at a time that suits you, you get the game on WhatsApp.",
    );
  });

  it("the strong button goes to /play with the hero's source code, and pulses", () => {
    expect(h.cta).toEqual({ label: "Join the player pool", href: `${POOL_PLAY_PATH}?src=${POOL_SITE_SOURCES.hero}`, pulse: true });
  });

  it("the small print is the age from pool/rules.ts and says it is opening town by town, with no weekly cap", () => {
    expect(h.smallPrint).toBe(`${POOL_MIN_AGE} and over. Opening town by town.`);
  });

  it("carries no pricing and never says free", () => {
    const text = copyStrings(h).map((x) => x.text).join(" ");
    expect(text).not.toMatch(/£|\bfree\b|price|pricing|a month|a week/i);
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

describe("landing content: the hero and its feature deck (variant E, 2026-10-26)", () => {
  const deckCopy = copyStrings({ HERO, HERO_POOL_INVITE, HERO_DECK: { ...HERO_DECK, dotLabel: HERO_DECK.dotLabel(1) } });
  const cardCopy = (k: string) => copyStrings(HERO_DECK.cards.find((c) => c.key === k));

  it("cards are scannable: a short title and one short line each", () => {
    for (const c of HERO_DECK.cards) {
      expect(c.title.length, c.key).toBeLessThanOrEqual(28);
      expect(c.body.length, c.key).toBeLessThanOrEqual(72);
      expect(c.body.split(/[.?!:]\s/).length, c.key).toBeLessThanOrEqual(2);
    }
  });

  it("has eight cards, in order, each with a title, a line and details", () => {
    expect(HERO_DECK.cards.map((c) => c.key)).toEqual(["att", "bench", "short", "teams", "ratings", "fees", "admin", "lang"]);
    for (const c of HERO_DECK.cards) {
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.body.length).toBeGreaterThan(10);
      expect(c.details.length).toBeGreaterThanOrEqual(3);
    }
    expect(HERO_DECK.cards.map((c) => c.title)).toEqual([
      "Who's in, counted",
      "The bench steps in",
      "Still short? It asks around",
      "Fair teams, on request",
      "Ratings and Man of the Match",
      "Match fees, collected",
      "Your organisers' own chat",
      "Speaks your group's language",
    ]);
  });

  it("the headline and the one line", () => {
    expect(HERO.titleLead).toBe("Your players WhatsApp.");
    expect(HERO.titleTail).toBe("MatchTime runs the game.");
    expect(HERO.pill).toBe("For weekly football groups");
    expect(HERO.ticks).toEqual(["No app for players"]);
    expect(HERO.secondary.href).toBe("#how-it-works");
  });

  it("carries no pricing: no free period, no price, no pay-per-week line", () => {
    const pricing = /\bfree (period|months?|trial)\b|first (two|2) months|months? free|pay only for the weeks|weeks you play|a month|per month|£\s?9|9\.99|pricing/i;
    expect(deckCopy.filter((s) => pricing.test(s.text))).toEqual([]);
    // The only money on the deck is the example match fee an organiser collects.
    const withPounds = HERO_DECK.cards.filter((c) => copyStrings(c).some((s) => /£/.test(s.text))).map((c) => c.key);
    expect(withPounds).toEqual(["fees"]);
  });

  it("has no em or en dash, says bench not waiting list, and no weekly cap wording", () => {
    expect(deckCopy.filter((s) => /[—–]|&mdash;|&ndash;/.test(s.text))).toEqual([]);
    expect(deckCopy.filter((s) => /waiting list/i.test(s.text))).toEqual([]);
    expect(deckCopy.filter((s) => /\b(2|two) a week\b|a week\b/i.test(s.text))).toEqual([]);
    expect(deckCopy.filter((s) => /@MatchTime/.test(s.text))).toEqual([]);
  });

  it("titles, lines and details use no slash as a separator", () => {
    const prose = HERO_DECK.cards.flatMap((c) => [c.title, c.body, ...c.details, ...c.visual]);
    expect(prose.filter((t) => /\//.test(t))).toEqual([]);
  });

  it("the language card says multi-lingual and names no language", () => {
    const lang = cardCopy("lang").map((s) => s.text).join(" ");
    expect(lang).toMatch(/multi-lingual/i);
    const named = /English|Turkish|T[uü]rk|Spanish|French|German|Polish|Arabic|Urdu|Portuguese|Italian|VARIM|YOKUM/i;
    expect(deckCopy.filter((s) => named.test(s.text))).toEqual([]);
  });

  it("never overclaims the bench: tagged, and the first to reply IN takes the place", () => {
    const bench = cardCopy("bench").map((s) => s.text).join(" ");
    expect(bench).toMatch(/tagged/i);
    expect(bench).toMatch(/first to/i);
    expect(bench).not.toMatch(/automatic/i);
  });

  it("the pool is asked after partner clubs, on the rule's delay, and is opening town by town", () => {
    const short = HERO_DECK.cards.find((c) => c.key === "short")!;
    expect(POOL_AFTER_PARTNERS_MINS).toBe(60);
    expect(short.details.join(" ")).toMatch(/an hour later, or straight away if you have no partner clubs/);
    expect(short.details.join(" ")).toMatch(/opening town by town/);
    expect(short.steps!.map((s) => s.title)).toEqual(["1. Bench", "2. Partner clubs", "3. Player pool"]);
    expect(short.steps!.filter((s) => s.highlight).map((s) => s.title)).toEqual(["3. Player pool"]);
  });

  it("quotes MatchTime's real wording", () => {
    const en = readFileSync(path.join(process.cwd(), "src/lib/i18n/strings.en.ts"), "utf8");
    const pool = readFileSync(path.join(process.cwd(), "src/lib/i18n/pool-offer.en.ts"), "utf8");
    for (const phrase of [
      "Bench is open.",
      "First to claim it plays.",
      "Just reply *IN* here to take it.",
      "No rush and no timeout,",
      "is in, replacing",
      "Objections? Tag me and say what to change, in your own words (for example @Match Time swap Sam with Alex), and an admin will confirm.",
      "a personal rating link. The more ratings we get, the better-balanced the",
      "Your trophy awaits next match.",
      "You can also pay for anyone you brought along.",
      "MatchTime in your admin group",
      "No need to tag me, except to cancel a match or put it back on.",
      "is cancelled. I've told the players' group.",
    ]) {
      expect(en, phrase).toContain(phrase);
    }
    for (const phrase of ["Would you like the place? Reply here, or tap to answer:", "You're in: "]) {
      expect(pool, phrase).toContain(phrase);
    }
    // No emoji in the deck's quotes.
    expect(deckCopy.filter((s) => /\p{Extended_Pictographic}/u.test(s.text))).toEqual([]);
  });

  it("the Still short card draws the chain and the pool's real offer", () => {
    const short = HERO_DECK.cards.find((c) => c.key === "short")!;
    expect(short.chat).toBe(POOL_OFFER_CHAT);
    expect(short.body).toMatch(/^Bench first, then partner clubs, then local players from the pool\.$/);
  });
});
