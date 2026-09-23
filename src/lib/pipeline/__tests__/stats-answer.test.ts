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
  genericPeriodNote,
  groupListSize,
  planStatsQuestion,
  renderAskPerson,
  renderStatsBottom,
  renderStatsGenericSafeLine,
  renderStatsTable,
  resolveStatsPerson,
} from "../stats-answer";
import { displaysSquadState } from "../../group-copy";
import { periodKey } from "../stats-period";
import type { Member, QuestionFacts, StatsPeriod, StatsSnapshot } from "../types";

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
    appearances: APPEARANCES,
    recordsStart: { matches: RECORDS_START, mom: MOM_START },
    periods: {},
    ...over,
  };
}

/** MatchTime's records for this club begin mid-April 2026 (Sutton's
 *  real shape); the Man of the Match record reaches further back, through
 *  the backfilled historical awards. */
const RECORDS_START = new Date("2026-04-14T20:00:00.000Z");
const MOM_START = new Date("2025-11-04T20:00:00.000Z");
const APPEARANCES = [
  ["u-mojib", "Mojib Jalali", 21],
  ["u-sait", "Sait Demir", 19],
  ["u-idris", "Idris Bello", 18],
  ["u-kemal", "Kemal Ediz", 17],
  ["u-baki", "Baki Aydin", 15],
  ["u-zeeshan", "Zeeshan Khan", 12],
  ["u-mohammed", "Mohammed Ali", 11],
  ["u-a8", "Player H", 9],
  ["u-a9", "Player I", 8],
  ["u-a10", "Player J", 7],
  ["u-a11", "Player K", 5],
  ["u-a12", "Player L", 2],
].map(([userId, name, matches]) => ({ userId: userId as string, name: name as string, matches: matches as number }));

const LAST_YEAR: StatsPeriod = { kind: "last", count: 1, unit: "year" };
const LAST_MONTH: StatsPeriod = { kind: "last", count: 1, unit: "month" };
/** What `load-stats.ts` hands over for a period the batch asked about. */
function withPeriods(): StatsSnapshot {
  return snapshot({
    periods: {
      // Reaches back before the records began: the same rows as the whole record.
      [periodKey(LAST_YEAR)]: {
        since: new Date("2025-09-23T20:30:00.000Z"),
        appearances: APPEARANCES,
        ratings: snapshot().ratings,
        mom: snapshot().mom,
      },
      // Inside the records: a genuinely smaller table.
      [periodKey(LAST_MONTH)]: {
        since: new Date("2026-08-23T20:30:00.000Z"),
        appearances: [
          { userId: "u-sait", name: "Sait Demir", matches: 4 },
          { userId: "u-mojib", name: "Mojib Jalali", matches: 3 },
          { userId: "u-baki", name: "Baki Aydin", matches: 1 },
        ],
        ratings: [
          { userId: "u-sait", name: "Sait Demir", avg: 8.1, games: 4, rank: 1, delta: null },
          { userId: "u-idris", name: "Idris Bello", avg: 7.45, games: 3, rank: 2, delta: null },
        ],
        mom: [{ userId: "u-baki", name: "Baki Aydin", wins: 2 }],
      },
    },
  });
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
    // 2026-09-23: appearances is a table like the others now, so its
    // default is ten. The old top three was the 30-day answer's.
    expect(groupListSize("appearances", null)).toBe(10);
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
    // A climber outside the top ten is named, never given his position.
    const deep = snapshot();
    deep.ratings[11].delta = 6;
    expect(renderStatsTable(sp("movers", 5), deep, "en")).toContain("1. Player L: up 6 places (14 matches)");
    expect(renderStatsTable(sp("movers", 5), deep, "tr")).toContain("1. Player L: 6 sıra yükseldi (14 maç)");
    // A faller, a non-mover and a newcomer are not climbers.
    expect(text).not.toContain("Player B");
    expect(text).not.toContain("Player J");
  });

  it("Mr Reliable is the stats page badge, not appearances", () => {
    const text = renderStatsTable(sp("mr_reliable"), snapshot(), "en");
    expect(text).toMatch(/badge/);
    expect(text.split("\n")[0]).toMatch(/most consistent first:$/);
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

  it("no table named is the appearances table, over the whole record, and says so", () => {
    expect(plan({ table: null })).toMatchObject({ kind: "table", table: "appearances", size: 10, period: null });
  });
  it("appearances is a table like the others, with its size and its period", () => {
    expect(plan({ table: "appearances", listSize: 5, period: LAST_YEAR })).toMatchObject({
      kind: "table",
      table: "appearances",
      size: 5,
      requested: 5,
      period: LAST_YEAR,
    });
  });
  it("Kemal's question, planned: appearances, the last year, ten", () => {
    expect(plan({ table: "appearances", period: LAST_YEAR })).toMatchObject({ kind: "table", table: "appearances", size: 10, period: LAST_YEAR });
  });
  it("the period rides every plan that answers, the grounded one included", () => {
    expect(plan({ table: "elo", period: LAST_MONTH })).toMatchObject({ kind: "table", period: LAST_MONTH });
    expect(plan({ table: "other", period: LAST_MONTH })).toMatchObject({ kind: "generic", period: LAST_MONTH });
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

// ═══════════════════════════════════════════════════════════════════════
// THE PERIOD (2026-09-23). "@Match Time who has played most matches in
// the last 1 year?" was answered "Most appearances in the last 30 days",
// three names. The rule Kemal cares about most: NEVER silently answer a
// different period from the one asked. Honoured, the header says it. Not
// honoured, the answer says what it IS showing and why. Asked further
// back than the records go, it says where the records start.
// ═══════════════════════════════════════════════════════════════════════

type TableSp = Parameters<typeof renderStatsTable>[0];
const tbl = (table: TableSp["table"], o: { size?: number; requested?: number | null; period?: StatsPeriod | null; person?: string; self?: boolean } = {}): TableSp => ({
  kind: "answer_stats_table",
  messageId: "m",
  table,
  size: o.size ?? 10,
  requested: o.requested ?? null,
  personUserId: o.person ?? null,
  self: o.self ?? false,
  period: o.period ?? null,
});

describe("appearances: the full record, not the last 30 days", () => {
  it("Kemal's exact question, in English: the records do not reach a year back, and it says so", () => {
    const text = renderStatsTable(tbl("appearances", { period: LAST_YEAR }), withPeriods(), "en");
    const lines = text.split("\n");
    expect(lines[0]).toBe("My records for this club start in April 2026, so for the last year this is everything I have.");
    expect(lines[1]).toBe("Most appearances since my records began in April 2026:");
    expect(lines[2]).toBe("1. Mojib Jalali: 21 matches");
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
    expect(text).not.toMatch(/30 days/);
  });

  it("the same, in Turkish", () => {
    const text = renderStatsTable(tbl("appearances", { period: LAST_YEAR }), withPeriods(), "tr");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Bu kulüp için kayıtlarım Nisan 2026 itibarıyla başlıyor, yani son 1 yıl için elimdeki her şey bu.");
    expect(lines[1]).toBe("En çok maça çıkanlar (Nisan 2026 itibarıyla):");
    expect(lines[2]).toBe("1. Mojib Jalali: 21 maç");
  });

  it("a period the records DO reach is honoured and named in the header", () => {
    expect(renderStatsTable(tbl("appearances", { period: LAST_MONTH }), withPeriods(), "en")).toBe(
      "Most appearances in the last month:\n1. Sait Demir: 4 matches\n2. Mojib Jalali: 3 matches\n3. Baki Aydin: 1 match",
    );
    expect(renderStatsTable(tbl("appearances", { period: LAST_MONTH }), withPeriods(), "tr")).toBe(
      "En çok maça çıkanlar (son 1 ay):\n1. Sait Demir: 4 maç\n2. Mojib Jalali: 3 maç\n3. Baki Aydin: 1 maç",
    );
  });

  it("no period stated: the whole record, and the header SAYS the period", () => {
    const text = renderStatsTable(tbl("appearances"), snapshot(), "en");
    expect(text.split("\n")[0]).toBe("Most appearances since my records began in April 2026:");
    expect(renderStatsTable(tbl("appearances"), snapshot(), "tr").split("\n")[0]).toBe("En çok maça çıkanlar (Nisan 2026 itibarıyla):");
  });

  it("this season and all time are the whole record, each said as asked", () => {
    expect(renderStatsTable(tbl("appearances", { period: { kind: "season" } }), snapshot(), "en").split("\n")[0]).toBe(
      "Most appearances this season, since April 2026:",
    );
    expect(renderStatsTable(tbl("appearances", { period: { kind: "all_time" } }), snapshot(), "en").split("\n")[0]).toBe(
      "Most appearances of all time, since my records began in April 2026:",
    );
    expect(renderStatsTable(tbl("appearances", { period: { kind: "season" } }), snapshot(), "tr").split("\n")[0]).toBe(
      "En çok maça çıkanlar (bu sezon, Nisan 2026 itibarıyla):",
    );
  });

  it("honours the size, capped at ten, and says when it capped", () => {
    expect(renderStatsTable(tbl("appearances", { size: 5, requested: 5 }), snapshot(), "en").split("\n")).toHaveLength(6);
    const capped = renderStatsTable(tbl("appearances", { size: 10, requested: 20 }), snapshot(), "en");
    expect(capped.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
    expect(capped).toContain(`I list the top 10 in the group. The full table is on the website: ${URL}`);
  });

  it("the em-dash row is retired: the new tables' row format, no dash in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = renderStatsTable(tbl("appearances", { period: LAST_YEAR }), withPeriods(), lang);
      expect(text).not.toMatch(/[—–]/);
      expect(displaysSquadState(text, lang), text).toBe(false);
    }
  });

  it("a period that was not loaded renders nothing (the composer's operator note), never the wrong table", () => {
    expect(renderStatsTable(tbl("appearances", { period: { kind: "last", count: 2, unit: "week" } }), withPeriods(), "en")).toBe("");
  });

  it("nobody played in the period: said, with the period", () => {
    const s = withPeriods();
    s.periods[periodKey(LAST_MONTH)].appearances = [];
    expect(renderStatsTable(tbl("appearances", { period: LAST_MONTH }), s, "en")).toBe("I have no completed matches in the last month to count.");
    expect(renderStatsTable(tbl("appearances", { period: LAST_MONTH }), s, "tr")).toBe("Bu dönemde (son 1 ay) sayılacak tamamlanmış maç yok.");
  });
});

describe("the other tables the data can cut: ratings and Man of the Match", () => {
  it("top 5 ratings in the last month, from that month's matches only", () => {
    expect(renderStatsTable(tbl("ratings", { size: 5, requested: 5, period: LAST_MONTH }), withPeriods(), "en")).toBe(
      "Top 2 club ratings in the last month (players with 3+ rated matches):\n1. Sait Demir: 8.1 (4 matches)\n2. Idris Bello: 7.5 (3 matches)",
    );
    expect(renderStatsTable(tbl("ratings", { size: 5, requested: 5, period: LAST_MONTH }), withPeriods(), "tr")).toBe(
      "Kulüp puanında ilk 2 (son 1 ay; en az 3 puanlı maçı olanlar):\n1. Sait Demir: 8,1 (4 maç)\n2. Idris Bello: 7,5 (3 maç)",
    );
  });

  it("ratings with no period are exactly what they were before this change", () => {
    expect(renderStatsTable(tbl("ratings", { size: 3 }), snapshot(), "en").split("\n")[0]).toBe(
      "Top 3 club ratings (players with 3+ rated matches):",
    );
  });

  it("all-time Man of the Match reaches back to the backfilled awards, and says from when", () => {
    expect(renderStatsTable(tbl("mom", { period: { kind: "all_time" } }), snapshot(), "en").split("\n")[0]).toBe(
      "Most Man of the Match wins of all time, since my records began in November 2025:",
    );
  });

  it("Man of the Match in the last month", () => {
    expect(renderStatsTable(tbl("mom", { period: LAST_MONTH }), withPeriods(), "en")).toBe(
      "Most Man of the Match wins in the last month:\n1. Baki Aydin: 2 wins",
    );
    const s = withPeriods();
    s.periods[periodKey(LAST_MONTH)].mom = [];
    expect(renderStatsTable(tbl("mom", { period: LAST_MONTH }), s, "en")).toBe("Nobody has won Man of the Match in the last month.");
  });

  it("nobody with three rated matches in the period is said with the period", () => {
    const s = withPeriods();
    s.periods[periodKey(LAST_MONTH)].ratings = [];
    expect(renderStatsTable(tbl("ratings", { period: LAST_MONTH }), s, "en")).toContain("Nobody has 3 rated matches in the last month");
  });
});

describe("the tables the data CANNOT cut say so, and say what they show", () => {
  it("Elo is a running rating: the table as it stands, and it says so", () => {
    const text = renderStatsTable(tbl("elo", { period: LAST_MONTH }), snapshot(), "en");
    expect(text.split("\n")[0]).toBe("Elo is a running rating, so this is the table as it stands now, not one for the last month.");
    expect(text.split("\n")[1]).toBe("Top 2 by Elo (3+ matches played):");
  });

  it("Team of the Season is never faked for a shorter span", () => {
    expect(renderStatsTable(tbl("team_of_season", { period: LAST_MONTH }), snapshot(), "en").split("\n")[0]).toBe(
      "Team of the Season is picked from every match since April 2026, so I can't cut it to the last month.",
    );
  });

  it("Mr Reliable is the page badge, over the whole record", () => {
    expect(renderStatsTable(tbl("mr_reliable", { period: LAST_MONTH }), snapshot(), "en").split("\n")[0]).toBe(
      "Mr Reliable is the stats page badge, earned over every match since April 2026, so I can't cut it to the last month.",
    );
  });

  it("chemistry is worked out over every match", () => {
    expect(renderStatsTable(tbl("chemistry", { period: { kind: "this", unit: "month" }, person: "u-idris" }), snapshot(), "en").split("\n")[0]).toBe(
      "Chemistry is worked out over every match since April 2026, so I can't cut it to this month.",
    );
  });

  it("the climbers already say what they are, so a period adds nothing to them", () => {
    expect(renderStatsTable(tbl("movers", { size: 5, period: LAST_MONTH }), snapshot(), "en")).toBe(
      renderStatsTable(tbl("movers", { size: 5 }), snapshot(), "en"),
    );
  });

  it("the season or all time on a whole-record table needs no note", () => {
    for (const t of ["elo", "team_of_season", "mr_reliable"] as const) {
      expect(renderStatsTable(tbl(t, { period: { kind: "season" } }), snapshot(), "en"), t).toBe(renderStatsTable(tbl(t), snapshot(), "en"));
    }
  });

  it("every one of those notes, in Turkish, carries no dash and no English", () => {
    for (const t of ["elo", "team_of_season", "mr_reliable", "chemistry"] as const) {
      const text = renderStatsTable(tbl(t, { period: LAST_MONTH, person: "u-idris" }), snapshot(), "tr");
      const lead = text.split("\n")[0];
      expect(lead, t).toMatch(/son 1 ay/);
      expect(lead, t).not.toMatch(/[—–]|\bcut\b|\bmatch\b/);
    }
  });

  it("the grounded answer gets the same honesty, as a line after it", () => {
    expect(genericPeriodNote(LAST_MONTH, snapshot(), "en")).toBe("These figures cover every match since April 2026, not only the last month.");
    expect(genericPeriodNote(LAST_MONTH, snapshot(), "tr")).toBe("Bu rakamlar Nisan 2026 itibarıyla oynanan tüm maçları kapsıyor, sadece son 1 ay değil.");
    expect(genericPeriodNote({ kind: "season" }, snapshot(), "en")).toBeNull();
    expect(genericPeriodNote(null, snapshot(), "en")).toBeNull();
  });
});
