/**
 * The players' help menu lists only what is switched on for their club
 * (Kemal, 2026-11-15). Players, in the group or by DM, used to be shown
 * every topic that could be switched on, with no marker, so a MoM-only
 * club's players read about saying IN, payments and partner clubs that
 * their club does not use. Organisers keep every topic they can switch on,
 * marked "(off here)". The menu's example ("e.g. help teams") names a topic
 * that is on, for everyone.
 */
import { describe, expect, it } from "vitest";
import { buildHelpReply, type HelpFeatures, type HelpContext } from "@/lib/onboarding-conversation";

const MOM_AND_RATINGS_ONLY: HelpFeatures = {
  attendance: false,
  teamBalancing: false,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: false,
  bench: false,
  paymentTracking: false,
  paymentCollection: false,
  pool: { open: false, platformOpen: true, clubFlag: false },
  partners: { active: 0 },
};

const EVERYTHING_ON: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
  paymentCollection: true,
  pool: { open: true, platformOpen: true, clubFlag: true },
  partners: { active: 1 },
};

const PLAYERS: [string, HelpContext][] = [
  ["the players' group", { audience: "group" }],
  ["a player's DM", { audience: "player", dm: true }],
];
const ORGANISERS: [string, HelpContext][] = [
  ["an organiser in the players' group", { audience: "admin" }],
  ["an organiser's DM", { audience: "admin", dm: true }],
];

/** The topic words on the menu's topic lines, in order. */
const topicsOf = (menu: string) => [...menu.matchAll(/^\S+ \*([^*]+)\*: /gm)].map((m) => m[1]);
const exampleOf = (menu: string) => menu.match(/(?:e\.g\.|örneğin) \*(?:@Match Time )?(?:help|yardım) ([^*]+)\*/)?.[1];

describe("a MoM-and-ratings-only club", () => {
  for (const [where, ctx] of PLAYERS) {
    it(`${where}: only what is on, nothing marked off`, () => {
      const menu = buildHelpReply(null, MOM_AND_RATINGS_ONLY, "en", ctx);
      const topics = topicsOf(menu);
      for (const off of ["availability", "friend", "teams", "reminders", "payments", "partners", "pool", "settings"]) {
        expect(topics).not.toContain(off);
      }
      expect(topics).toEqual(["mom", "ratings", "badges", "schedule"]);
      expect(menu).not.toContain("(off here)");
      expect(topics).toContain(exampleOf(menu));
    });

    it(`${where}, in Turkish: the same, with an example that is on`, () => {
      const menu = buildHelpReply(null, MOM_AND_RATINGS_ONLY, "tr", ctx);
      expect(topicsOf(menu)).toEqual(["maçın adamı", "puanlama", "rozetler", "program"]);
      expect(menu).not.toContain("(burada kapalı)");
      expect(topicsOf(menu)).toContain(exampleOf(menu));
    });
  }

  for (const [where, ctx] of ORGANISERS) {
    it(`${where}: every switchable topic still, the off ones marked, the example on`, () => {
      const menu = buildHelpReply(null, MOM_AND_RATINGS_ONLY, "en", ctx);
      for (const off of ["availability", "friend", "teams", "reminders", "payments", "partners", "pool"]) {
        expect(menu).toMatch(new RegExp(`\\*${off}\\*: [^\\n]*\\(off here\\)`));
      }
      expect(menu).toMatch(/\*mom\*: Man of the Match\n/);
      expect(topicsOf(menu)).toContain("settings");
      const example = exampleOf(menu)!;
      expect(menu).toMatch(new RegExp(`\\*${example}\\*: [^\\n(]*\\n`));
    });
  }
});

describe("a club with everything on", () => {
  for (const [where, ctx] of [...PLAYERS, ...ORGANISERS]) {
    it(`${where}: every topic, none marked off, the usual example`, () => {
      const menu = buildHelpReply(null, EVERYTHING_ON, "en", ctx);
      const topics = topicsOf(menu);
      for (const tp of ["availability", "friend", "teams", "mom", "ratings", "badges", "reminders", "payments", "partners", "pool", "schedule"]) {
        expect(topics).toContain(tp);
      }
      expect(menu).not.toContain("(off here)");
      expect(exampleOf(menu)).toBe(ctx.dm ? "payments" : "teams");
    });
  }
});
