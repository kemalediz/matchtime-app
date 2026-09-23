/**
 * THE GROUNDING CHECK on the generic stats answer (2026-09-23).
 *
 * The generic prompt is the one place a model writes stats text for the
 * group. Kemal's rule: every name and every number in its reply must
 * appear in the tables it was given. A reply that fails is MatchTime's
 * own error, and the group gets the exact table or a safe line instead,
 * never a question about it.
 */
import { describe, expect, it } from "vitest";
import { groundingCheck } from "../stats-grounding";
import { buildGenericStatsContext } from "../stats-generic";
import type { Member, StatsSnapshot } from "../types";

const m = (userId: string, name: string): Member => ({ userId, name, isAdmin: false, hasPhone: true });
const ROSTER: Member[] = [
  m("u-idris", "Idris Bello"),
  m("u-kemal", "Kemal Ediz"),
  m("u-sait", "Sait Demir"),
  m("u-zeeshan", "Zeeshan Khan"),
  m("u-abid", "Abid Hussain"),
];

const SNAP: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { userId: "u-sait", name: "Sait Demir", avg: 7.83, games: 9, rank: 1, delta: 2 },
    { userId: "u-idris", name: "Idris Bello", avg: 7.41, games: 6, rank: 2, delta: 0 },
  ],
  mom: [{ userId: "u-sait", name: "Sait Demir", wins: 4 }],
  elo: [{ userId: "u-kemal", name: "Kemal Ediz", rating: 1042, matches: 12 }],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  chemistry: {
    "u-idris": {
      userId: "u-idris",
      name: "Idris Bello",
      bestByWinRate: { name: "Kemal Ediz", gamesTogether: 7, wins: 5, winRate: 5 / 7 },
      bestByRating: null,
      nemesis: { name: "Zeeshan Khan", gamesAgainst: 5, wins: 1 },
    },
  },
  generic: {},
  appearances: [],
  recordsStart: { matches: null, mom: null },
  periods: {},
};

const ctx = (personUserId: string | null = null, self = false) =>
  buildGenericStatsContext({ snapshot: SNAP, lang: "en", personUserId, self, roster: ROSTER });
const check = (reply: string, question = "@Match Time who is on fire?", personUserId: string | null = null) =>
  groundingCheck({ reply, question, grounding: ctx(personUserId).grounding, roster: ROSTER });

describe("the context the generic prompt is given", () => {
  it("carries the tables, rounded exactly as the answer may print them", () => {
    const { text } = ctx();
    expect(text).toContain("Sait Demir");
    expect(text).toContain("7.8");
    expect(text).not.toContain("7.83");
  });
  it("never carries another player's nemesis", () => {
    expect(ctx("u-idris").text).not.toContain("Zeeshan");
  });
  it("carries the asker's own nemesis when they asked about themselves", () => {
    expect(ctx("u-idris", true).text).toContain("Zeeshan");
  });
  it("carries the appearances table, top ten, and a named player's count when he is in it (2026-09-23)", () => {
    const snap: StatsSnapshot = {
      ...SNAP,
      appearances: [
        { userId: "u-idris", name: "Idris Bello", matches: 21 },
        { userId: "u-sait", name: "Sait Demir", matches: 19 },
      ],
      recordsStart: { matches: new Date("2026-04-14T20:00:00.000Z"), mom: null },
    };
    const c = buildGenericStatsContext({ snapshot: snap, lang: "en", personUserId: "u-idris", self: false, roster: ROSTER });
    expect(c.text).toMatch(/APPEARANCES[^\n]*since April 2026/);
    expect(c.text).toContain("1. Idris Bello: 21 matches");
    expect(c.text).toContain("- appearances: 21");
    expect(c.grounding.numbers).toContain("21");
  });
});

describe("a grounded reply passes", () => {
  it("names and numbers copied from the tables", () => {
    expect(check("Sait Demir is top on 7.8 from 9 matches, and has 4 Man of the Match wins.")).toEqual({ ok: true });
  });
  it("a first name alone, and a Turkish suffix on it", () => {
    expect(check("Sait 7,8 ile zirvede, Idris'in ortalaması 7,4.")).toEqual({ ok: true });
  });
  it("a number the question itself asked for", () => {
    expect(check("Here are the top 5: Sait Demir 7.8, Idris Bello 7.4.", "@Match Time top 5 please")).toEqual({ ok: true });
  });
});

describe("an ungrounded reply is rejected", () => {
  it("a number that is not in the tables", () => {
    expect(check("Sait Demir averages 8.1.").ok).toBe(false);
  });
  it("a squad member who is not in the tables", () => {
    const r = check("Abid Hussain is the one to watch.");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.why).toMatch(/Abid/);
  });
  it("a member mentioned only by a Turkish suffixed first name", () => {
    expect(check("Abid'in formu harika.").ok).toBe(false);
  });
  it("a number written as a word", () => {
    expect(check("Sait Demir has won it four times.").ok).toBe(false);
    expect(check("Sait dört kez maçın adamı oldu.").ok).toBe(false);
  });
  it("another player's nemesis cannot pass, because it was never supplied", () => {
    expect(check("Idris struggles against Zeeshan Khan.", "@Match Time Idris?", "u-idris").ok).toBe(false);
  });
  it("the model's own 'cannot answer' marker", () => {
    expect(check("NO_ANSWER").ok).toBe(false);
  });
  it("an empty reply", () => {
    expect(check("   ").ok).toBe(false);
  });
});
