/**
 * The known stats tables, rendered by code (2026-09-23).
 *
 * The incident this pins: "@Match Time please share the leaderboard of
 * ratings, top 10" answered with the three most frequent attenders of
 * the last 30 days. The model now names the TABLE and the SIZE; every
 * name and number below comes from a `StatsSnapshot`, which is loaded
 * from the same functions `/profile/stats` reads.
 */
import { describe, expect, it } from "vitest";
import {
  GROUP_LIST_CAP,
  NEMESIS_IN_GROUP_FOR_OTHERS,
  clarificationSubject,
  groupListSize,
  planStatsQuestion,
  renderAskPerson,
  renderStatsBottom,
  renderStatsGenericSafeLine,
  renderStatsTable,
  resolveStatsPerson,
} from "../stats-answer";
import { displaysSquadState } from "../../group-copy";
import type { Member, QuestionFacts, StatsSnapshot } from "../types";

const m = (userId: string, name: string): Member => ({ userId, name, isAdmin: false, hasPhone: true });
const ROSTER: Member[] = [
  m("u-idris", "Idris Bello"),
  m("u-kemal", "Kemal Ediz"),
  m("u-sait", "Sait Demir"),
  m("u-mojib", "Mojib Jalali"),
  m("u-mohammed", "Mohammed Ali"),
  m("u-zeeshan", "Zeeshan Khan"),
  m("u-baki", "Baki Aydin"),
];

const URL = "https://matchtime.ai/profile/stats";

function snapshot(over: Partial<StatsSnapshot> = {}): StatsSnapshot {
  const ratings = Array.from({ length: 14 }, (_, i) => ({
    userId: `u-r${i + 1}`,
    name: `Player ${String.fromCharCode(65 + i)}`,
    avg: 8.4 - i * 0.2,
    games: 3 + i,
    rank: i + 1,
    delta: i === 3 ? 4 : i === 6 ? 2 : i === 1 ? -1 : i === 9 ? null : 0,
  }));
  return {
    fullTableUrl: URL,
    ratings,
    mom: [
      { userId: "u-sait", name: "Sait Demir", wins: 4 },
      { userId: "u-kemal", name: "Kemal Ediz", wins: 1 },
    ],
    elo: [
      { userId: "u-kemal", name: "Kemal Ediz", rating: 1042, matches: 12 },
      { userId: "u-idris", name: "Idris Bello", rating: 1016, matches: 5 },
    ],
    teamOfSeason: {
      sportName: "Football 7-a-side",
      slots: [
        { position: "GK", userId: "u-baki", name: "Baki Aydin", avg: 7.9, games: 6 },
        { position: "ANY", userId: "u-sait", name: "Sait Demir", avg: 7.75, games: 2 },
      ],
    },
    mrReliable: [{ userId: "u-sait", name: "Sait Demir", avg: 7.34, games: 9, spread: 0.4 }],
    aliases: [{ alias: "mo", userId: "u-mohammed" }],
    chemistry: {
      "u-idris": {
        userId: "u-idris",
        name: "Idris Bello",
        bestByWinRate: { name: "Kemal Ediz", gamesTogether: 7, wins: 5, winRate: 5 / 7 },
        bestByRating: { name: "Sait Demir", myAvgWith: 7.94, sameAsWinRate: false },
        nemesis: { name: "Zeeshan Khan", gamesAgainst: 5, wins: 1 },
      },
    },
    generic: {},
    ...over,
  };
}

const q = (over: Partial<QuestionFacts>): QuestionFacts => ({
  kind: "question",
  topic: "stats",
  personRef: null,
  statedCount: null,
  table: null,
  listSize: null,
  listEnd: "top",
  ...over,
});

describe("how many rows the group gets", () => {
  it("serves the number asked for, up to ten", () => {
    expect(groupListSize("ratings", 5)).toBe(5);
    expect(groupListSize("ratings", 10)).toBe(10);
  });
  it("serves a request above ten as ten", () => {
    expect(GROUP_LIST_CAP).toBe(10);
    expect(groupListSize("ratings", 20)).toBe(10);
  });
  it("uses the table's default when no number was asked for", () => {
    expect(groupListSize("ratings", null)).toBe(10);
    expect(groupListSize("movers", null)).toBe(5);
    // Unchanged from before the field existed: the appearances answer
    // has always been a top three.
    expect(groupListSize("appearances", null)).toBe(3);
    expect(groupListSize("ratings", 0)).toBe(10);
  });
});

describe("the ratings leaderboard (the 2026-09-23 incident)", () => {
  it("lists the top ten by club rating, raw mean to one decimal, with the minimum stated", () => {
    const text = renderStatsTable(
      { kind: "answer_stats_table", messageId: "m", table: "ratings", size: 10, requested: 10, personUserId: null, self: false },
      snapshot(),
      "en",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Top 10 club ratings (players with 3+ rated matches):");
    expect(lines[1]).toBe("1. Player A: 8.4 (3 matches)");
    expect(lines).toHaveLength(11);
    expect(text).not.toContain("Player K");
  });

  it("says it capped a request for twenty, and links the full table", () => {
    const text = renderStatsTable(
      { kind: "answer_stats_table", messageId: "m", table: "ratings", size: 10, requested: 20, personUserId: null, self: false },
      snapshot(),
      "en",
    );
    expect(text.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
    expect(text).toContain(`I list the top 10 in the group. The full table is on the website: ${URL}`);
  });

  it("renders in Turkish with a decimal comma and no dashes", () => {
    const text = renderStatsTable(
      { kind: "answer_stats_table", messageId: "m", table: "ratings", size: 3, requested: 3, personUserId: null, self: false },
      snapshot(),
      "tr",
    );
    expect(text).toBe(
      "Kulüp puanında ilk 3 (en az 3 puanlı maçı olanlar):\n1. Player A: 8,4 (3 maç)\n2. Player B: 8,2 (4 maç)\n3. Player C: 8,0 (5 maç)",
    );
    expect(text).not.toMatch(/[—–]/);
  });

  it("is honest when nobody has three rated matches", () => {
    const text = renderStatsTable(
      { kind: "answer_stats_table", messageId: "m", table: "ratings", size: 10, requested: null, personUserId: null, self: false },
      snapshot({ ratings: [] }),
      "en",
    );
    expect(text).toContain("Nobody has 3 rated matches yet");
    expect(text).toContain(URL);
  });
});

describe("a request for the bottom names nobody", () => {
  it("points at the website instead, in both languages", () => {
    const en = renderStatsBottom(snapshot(), "en");
    const tr = renderStatsBottom(snapshot(), "tr");
    for (const text of [en, tr]) {
      expect(text).toContain(URL);
      for (const r of snapshot().ratings) expect(text).not.toContain(r.name);
    }
  });
});

describe("the other known tables", () => {
  const sp = (table: "mom" | "elo" | "team_of_season" | "movers" | "mr_reliable", size = 10) =>
    ({ kind: "answer_stats_table", messageId: "m", table, size, requested: null, personUserId: null, self: false }) as const;

  it("Man of the Match wins", () => {
    expect(renderStatsTable(sp("mom"), snapshot(), "en")).toBe(
      "Most Man of the Match wins:\n1. Sait Demir: 4 wins\n2. Kemal Ediz: 1 win",
    );
  });

  it("Elo, with its three-match minimum stated", () => {
    expect(renderStatsTable(sp("elo"), snapshot(), "en")).toBe(
      "Top 2 by Elo (3+ matches played):\n1. Kemal Ediz: 1042 (12 matches)\n2. Idris Bello: 1016 (5 matches)",
    );
  });

  it("Team of the Season, with the website's own two-match minimum and no 'ANY' label", () => {
    expect(renderStatsTable(sp("team_of_season"), snapshot(), "en")).toBe(
      "Team of the Season (Football 7-a-side), the best average rating in each position (2+ rated matches):\n" +
        "1. Baki Aydin (GK): 7.9 (6 matches)\n2. Sait Demir: 7.8 (2 matches)",
    );
  });

  it("biggest climbers: movement since the last match, and it says so", () => {
    const text = renderStatsTable(sp("movers", 5), snapshot(), "en");
    expect(text.split("\n")[0]).toMatch(/match by match/);
    expect(text).toContain("1. Player D: up 4 places to no. 4 (6 matches)");
    expect(text).toContain("2. Player G: up 2 places to no. 7 (9 matches)");
    // A faller, a non-mover and a newcomer are not climbers.
    expect(text).not.toContain("Player B");
    expect(text).not.toContain("Player J");
  });

  it("Mr Reliable is the stats page badge, not appearances", () => {
    const text = renderStatsTable(sp("mr_reliable"), snapshot(), "en");
    expect(text).toMatch(/badge/);
    expect(text).toContain("1. Sait Demir: 7.3 average (9 matches)");
  });

  it("every known table in Turkish carries no dash", () => {
    for (const t of ["mom", "elo", "team_of_season", "movers", "mr_reliable"] as const) {
      expect(renderStatsTable(sp(t), snapshot(), "tr")).not.toMatch(/[—–]/);
    }
  });
});

describe("chemistry: what the stats page shows, and the nemesis only for yourself", () => {
  const chem = (self: boolean) =>
    ({ kind: "answer_stats_table", messageId: "m", table: "chemistry", size: 10, requested: null, personUserId: "u-idris", self }) as const;

  it("another player: best by win rate and best by rating, and never the nemesis", () => {
    expect(NEMESIS_IN_GROUP_FOR_OTHERS).toBe(false);
    const text = renderStatsTable(chem(false), snapshot(), "en");
    expect(text).toBe(
      "Idris Bello's best team-mates:\n" +
        "• By win rate: Kemal Ediz, 5 wins in 7 matches together (71%)\n" +
        "• By rating: Sait Demir, Idris averages 7.9 alongside them",
    );
    expect(text).not.toContain("Zeeshan");
  });

  it("the asker about themselves also hears the nemesis", () => {
    expect(renderStatsTable(chem(true), snapshot(), "en")).toContain(
      "• Nemesis: Zeeshan Khan, Idris has won 1 of 5 against them",
    );
  });

  it("one line when the same team-mate tops both, as the page does", () => {
    const s = snapshot();
    s.chemistry["u-idris"].bestByRating = { name: "Kemal Ediz", myAvgWith: 7.9, sameAsWinRate: true };
    expect(renderStatsTable(chem(false), s, "en").split("\n")).toHaveLength(2);
  });

  it("Turkish, no dash, nemesis still withheld", () => {
    const text = renderStatsTable(chem(false), snapshot(), "tr");
    expect(text).toContain("Idris Bello için en iyi takım arkadaşları:");
    expect(text).not.toContain("Zeeshan");
    expect(text).not.toMatch(/[—–]/);
  });
});

describe("no answer here is ever mistaken for the squad list", () => {
  // `route.ts` replaces any reply `displaysSquadState` recognises with the
  // roster (the 2026-05-14 incident). The route also skips these answers
  // by intent (`skipsSquadComposition`); the rows carry the leaderboard
  // markers as well, so neither guard alone is load-bearing.
  it.each(["en", "tr"] as const)("%s", (lang) => {
    const base = { kind: "answer_stats_table", messageId: "m", size: 10, requested: 20, personUserId: "u-idris", self: true } as const;
    for (const table of ["ratings", "mom", "elo", "team_of_season", "movers", "mr_reliable", "chemistry"] as const) {
      const text = renderStatsTable({ ...base, table }, snapshot(), lang);
      expect(displaysSquadState(text, lang), `${table}: ${text}`).toBe(false);
    }
  });
});

describe("who a stats question is about", () => {
  it("one clear member resolves", () => {
    expect(resolveStatsPerson("Idris", ROSTER, [], "u-kemal")).toMatchObject({ kind: "resolved", member: { userId: "u-idris" } });
  });
  it("a Turkish possessive suffix is not part of the name", () => {
    expect(resolveStatsPerson("Idris'in", ROSTER, [], "u-kemal")).toMatchObject({ kind: "resolved", member: { userId: "u-idris" } });
    expect(resolveStatsPerson("Idris’in", ROSTER, [], "u-kemal")).toMatchObject({ kind: "resolved", member: { userId: "u-idris" } });
  });
  it("an admin-curated alias wins", () => {
    expect(resolveStatsPerson("Mo", ROSTER, [{ alias: "mo", userId: "u-mohammed" }], "u-kemal")).toMatchObject({
      kind: "resolved",
      member: { userId: "u-mohammed" },
    });
  });
  it("a name nobody has is unknown, and is asked about", () => {
    expect(resolveStatsPerson("Zork", ROSTER, [], "u-kemal")).toEqual({ kind: "unknown", ref: "Zork" });
  });
  it("two plausible members is ambiguous", () => {
    const two = [...ROSTER, m("u-idris2", "Idris Musa")];
    const r = resolveStatsPerson("Idris", two, [], "u-kemal");
    expect(r.kind).toBe("ambiguous");
  });
  it("me / my / ben is the asker", () => {
    for (const ref of ["me", "my", "myself", "I", "ben", "benim"]) {
      expect(resolveStatsPerson(ref, ROSTER, [], "u-kemal"), ref).toMatchObject({ kind: "resolved", self: true, member: { userId: "u-kemal" } });
    }
  });
});

describe("planning a stats question", () => {
  const plan = (f: Partial<QuestionFacts>, sender = "u-kemal") => planStatsQuestion(q(f), ROSTER, [], sender);

  it("no table: the answer that existed before this change", () => {
    expect(plan({ table: null })).toEqual({ kind: "legacy" });
  });
  it("appearances keeps the original composer, now with a size", () => {
    expect(plan({ table: "appearances", listSize: 5 })).toEqual({ kind: "appearances", size: 5 });
  });
  it("bottom names nobody, whatever the table", () => {
    expect(plan({ table: "ratings", listEnd: "bottom" })).toEqual({ kind: "bottom" });
  });
  it("the incident, planned: ratings, ten", () => {
    expect(plan({ table: "ratings", listSize: 10 })).toMatchObject({ kind: "table", table: "ratings", size: 10, requested: 10 });
  });
  it("chemistry for a named player", () => {
    expect(plan({ table: "chemistry", personRef: "Idris" })).toMatchObject({ kind: "table", table: "chemistry", personUserId: "u-idris", self: false });
  });
  it("chemistry with nobody named is the asker's own", () => {
    expect(plan({ table: "chemistry" })).toMatchObject({ kind: "table", personUserId: "u-kemal", self: true });
  });
  it("chemistry for the asker named by their own name is self too", () => {
    expect(plan({ table: "chemistry", personRef: "Kemal" })).toMatchObject({ personUserId: "u-kemal", self: true });
  });
  it("an unknown name is a question back, never a guess", () => {
    expect(plan({ table: "chemistry", personRef: "Zork" })).toEqual({ kind: "ask", ref: "Zork", candidates: [] });
  });
  it("an ambiguous name asks with the candidates", () => {
    const two = [...ROSTER, m("u-idris2", "Idris Musa")];
    expect(planStatsQuestion(q({ table: "chemistry", personRef: "Idris" }), two, [], "u-kemal")).toEqual({
      kind: "ask",
      ref: "Idris",
      candidates: ["Idris Bello", "Idris Musa"],
    });
  });
  it("a named player on a club table goes to the grounded prompt, after resolution", () => {
    expect(plan({ table: "ratings", personRef: "Sait" })).toMatchObject({ kind: "generic", personUserId: "u-sait" });
    expect(plan({ table: "ratings", personRef: "Zork" })).toMatchObject({ kind: "ask" });
  });
  it("a question no known table answers goes to the grounded prompt", () => {
    expect(plan({ table: "other" })).toMatchObject({ kind: "generic", personUserId: null });
  });
  it("chemistry from an unresolved sender who named nobody cannot be answered", () => {
    expect(planStatsQuestion(q({ table: "chemistry" }), ROSTER, [], null)).toEqual({ kind: "none", why: expect.any(String) });
  });
});

describe("asking the poster, honestly, in both languages", () => {
  it("an unknown name", () => {
    expect(renderAskPerson({ askerName: "Kemal Ediz", ref: "Zork", candidates: [] }, "en")).toBe(
      "Kemal, I don't have a Zork in the squad. Who do you mean?",
    );
    expect(renderAskPerson({ askerName: "Kemal Ediz", ref: "Zork", candidates: [] }, "tr")).toBe(
      "Kemal, kadroda Zork diye biri yok. Kimi kastettiniz?",
    );
  });
  it("an ambiguous name names the candidates", () => {
    expect(renderAskPerson({ askerName: "Kemal Ediz", ref: "Mo", candidates: ["Mojib Jalali", "Mohammed Ali"] }, "en")).toBe(
      "Kemal, do you mean Mojib Jalali or Mohammed Ali?",
    );
    expect(renderAskPerson({ askerName: "Kemal Ediz", ref: "Mo", candidates: ["Mojib Jalali", "Mohammed Ali"] }, "tr")).toBe(
      "Kemal, hangisini kastettiniz: Mojib Jalali ya da Mohammed Ali?",
    );
  });
});

describe("the safe line the generic path falls back to", () => {
  it("links the website and names nobody", () => {
    expect(renderStatsGenericSafeLine(snapshot(), "en")).toContain(URL);
    expect(renderStatsGenericSafeLine(snapshot(), "tr")).toContain(URL);
  });
});

describe("reading the poster's answer to a clarification", () => {
  it.each([
    ["Mojib", "Mojib"],
    ["mojib jalali", "mojib jalali"],
    ["I mean Mojib", "Mojib"],
    ["sorry, I meant Mojib Jalali!", "Mojib Jalali"],
    ["@Match Time Mojib", "Mojib"],
    ["Mojib demek istedim", "Mojib"],
    ["Mojib'i kastettim", "Mojib"],
  ])("%s is an answer naming %s", (body, name) => {
    expect(clarificationSubject(body)).toBe(name);
  });
  it.each(["in", "I'm in", "yes", "Mojib is in for Tuesday", "haha", "var", "ok thanks", "3", ""])(
    "%s is not an answer",
    (body) => {
      expect(clarificationSubject(body)).toBeNull();
    },
  );
});
