/**
 * THE UNIFIED ANSWER's context and call (`unified-answer.ts`, UNIFIED_ANSWERS).
 * The privacy rules live in the context builder, by audience: what the model
 * is not told it cannot leak.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { HAIKU_CALL, MIN_CACHEABLE_TOKENS } from "../llm";
import { answerUnified, buildUnifiedContext, matchRatingsFrom, UNIFIED_ANSWER_SYSTEM, type UnifiedAnswerInput } from "../unified-answer";
import type { ClubSnapshot, StatsSnapshot } from "../types";
import { NOW, fullName, world } from "./helpers";

const CLUB: ClubSnapshot = { collectorName: "Elvin Aliyev", feePerPlayer: 6.5, feeSplitTotal: false, teamsReady: "10:00" };
const STATS: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [{ userId: "u-erdal", name: fullName("erdal"), avg: 7.4, games: 9, rank: 1, delta: 1 }],
  mom: [{ userId: "u-sait", name: fullName("sait"), wins: 4 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  chemistry: {},
  appearances: [{ userId: "u-erdal", name: fullName("erdal"), matches: 12 }],
  recordsStart: { matches: new Date("2026-04-07T19:00:00.000Z"), mom: null },
  completedMatches: 14,
  generic: {},
  periods: {},
};

function input(over: Partial<UnifiedAnswerInput> = {}): UnifiedAnswerInput {
  const st = world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal", "zair"], noPhone: ["idris"] });
  return {
    audience: "players",
    state: { ...st, club: CLUB },
    squadKnown: true,
    stats: STATS,
    results: { since: null, more: false, rows: [{ dayLabel: "Tue 3 Nov", redLabel: "Red", yellowLabel: "Yellow", red: 5, yellow: 3 }] },
    payments: { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" },
    ratingProgress: { ok: true, matchName: "Tuesday", matchWhen: "3 Nov", confirmed: 14, ratedCount: 9, momCount: 8, notRated: [fullName("zair")], ratedNoMom: [] },
    history: [{ author: fullName("elvin"), body: "call me on 07943 789944 if late", at: new Date("2026-09-01T10:00:00.000Z") }],
    lastBotPost: null,
    reply: null,
    now: NOW,
    question: "@Match Time how many spaces left?",
    askerUserId: "u-sait",
    askerName: fullName("sait"),
    ...over,
  };
}

describe("the context: the club's data", () => {
  it("holds the squad and bench in order, places left, fee, results, the tables and the asker", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toContain(`WHO IS ASKING: ${fullName("sait")}, a member, in the players' group`);
    expect(text).toMatch(/In the squad: 3 of 14\. Places left: 11\. On the bench: 2\./);
    expect(text).toContain(`1. ${fullName("erdal")}`);
    expect(text).toContain("£6.50 a player");
    expect(text).toContain("Tue 3 Nov: Red 5, Yellow 3");
    expect(text).toContain(`${fullName("erdal")}: 12 matches`);
    expect(text).toMatch(/recorded for this club: 14/);
    expect(text.trimEnd().endsWith("@Match Time how many spaces left?")).toBe(true);
  });

  it("says who has no number on record, never the number, and scrubs numbers from the chat", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toContain(`NO PHONE NUMBER ON RECORD (squad and bench): ${fullName("idris")}`);
    expect(text).not.toMatch(/07943|789944/);
    expect(text).toContain("[number hidden]");
  });
});

describe("the context: by audience (privacy)", () => {
  it("the players' group NEVER sees payments, and sees who has rated only by count", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).not.toMatch(/4 of the 13/);
    expect(text).toMatch(/PAYMENTS: not shared in the players' group/);
    expect(text).toMatch(/9 of 14 who played have rated/);
    expect(text).not.toContain(`Not rated yet: ${fullName("zair")}`);
  });

  it("an admin asking in the players' group sees who has rated, still never payments", () => {
    const { text } = buildUnifiedContext(input({ askerUserId: "u-kemal", askerName: fullName("kemal") }));
    expect(text).toContain(`Not rated yet: ${fullName("zair")}`);
    expect(text).not.toMatch(/4 of the 13/);
  });

  it("the organisers see the payment count and who has rated", () => {
    const { text } = buildUnifiedContext(input({ audience: "organisers" }));
    expect(text).toMatch(/4 of the 13 who owe have not paid yet/);
    expect(text).toContain(`Not rated yet: ${fullName("zair")}`);
  });

  it("a club whose organisers post the list: the players' group gets counts, no names", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    const { text } = buildUnifiedContext(input({ state: st }));
    expect(text).not.toContain(`1. ${fullName("kemal")}`);
    expect(text).toMatch(/In the squad: 3 of 14/);
    expect(text).toMatch(/organisers post the list/);
    expect(buildUnifiedContext(input({ state: st, audience: "organisers" })).text).toContain(`1. ${fullName("kemal")}`);
  });

  it("a DM shows the asker's own blocks, no group chat, and who lacks a number only to an admin", () => {
    const dm = buildUnifiedContext(input({ audience: "dm", own: ["YOUR STATS:\n- Games played: 5/14"], dmChat: "NOW: Tue" }));
    expect(dm.text).toContain("YOUR STATS:");
    expect(dm.text).not.toContain("call me on");
    expect(dm.text).not.toMatch(/NO PHONE NUMBER ON RECORD/);
    expect(dm.text).not.toMatch(/4 of the 13/);
    expect(buildUnifiedContext(input({ audience: "dm", askerIsAdmin: true })).text).toMatch(/NO PHONE NUMBER ON RECORD/);
  });

  it("stats switched off: no tables at all", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, statsQa: false } };
    const { text } = buildUnifiedContext(input({ state: st }));
    expect(text).not.toContain("12 matches");
    expect(text).toMatch(/stats answers switched off/);
  });
});

describe("the prompt", () => {
  it("is one plain task with EN and TR examples, no long dashes", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/Examples, English and Turkish/);
    expect(UNIFIED_ANSWER_SYSTEM).not.toMatch(/[–—]/);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/changes nothing/);
  });
});

function stub(answer: string | Error) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      if (answer instanceof Error) throw answer;
      return {
        text: JSON.stringify({ answer }),
        stopReason: "end_turn",
        usage: { inputTokens: 5000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0006,
        ms: 5,
      };
    },
  };
  return { model, reqs };
}

describe("the call", () => {
  it("one Haiku call, labelled, and a grounded reply is used", async () => {
    const { model, reqs } = stub("11 places left for Tue 21:30.");
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toEqual({ text: "11 places left for Tue 21:30." });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].model).toBe(HAIKU_CALL.model);
    expect(reqs[0].label).toBe("unified-answer");
    expect(r.inputTokens).toBe(5000);
  });

  it("an invented number is refused", async () => {
    const { model } = stub("27 places left.");
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toMatchObject({ rejected: expect.stringMatching(/grounding/) });
  });

  it("a number word is checked as its value: grounded, it is used, with no second call (2026-11-11)", async () => {
    const { model, reqs } = stub("Eleven places left. Once a place opens, the first on the bench moves up.");
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toEqual({ text: "Eleven places left. Once a place opens, the first on the bench moves up." });
    expect(reqs).toHaveLength(1);
  });

  it("a number word whose value is not in the context is refused, like a digit", async () => {
    const { model } = stub("Twenty-seven places left.");
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toMatchObject({ rejected: expect.stringMatching(/grounding check failed/) });
  });

  it("a refusal is final: no second call", async () => {
    const { model, reqs } = stub("27 places left.");
    await answerUnified({ ...input(), model });
    expect(reqs).toHaveLength(1);
  });

  it("never throws", async () => {
    const { model } = stub(new Error("529 Overloaded"));
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toMatchObject({ rejected: expect.stringMatching(/529/) });
  });
});

// ── ROUND 2 (2026-11-11): what the round 1 A/B found ─────────────────────

const lastMomOf = (recent: NonNullable<StatsSnapshot["lastMom"]>["recent"]) => ({ last: recent?.[0] ?? null, openVoteDate: null, recent });
const mom = (iso: string, name: string, votes: number, total: number, picked = false) => ({
  date: new Date(iso),
  teamLabels: ["Red", "Yellow"] as [string, string],
  score: null,
  winners: [{ userId: `u-${name}`, name, votes }],
  tally: [{ userId: `u-${name}`, name, votes }],
  totalVotes: total,
  pickedByOrganisers: picked,
});

describe("round 2: records over chat, and who MatchTime is", () => {
  it("says who MatchTime is: the club's assistant, not a player, never at a match", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toMatch(/ABOUT YOU: You are MatchTime, the club's assistant/);
    expect(text).toMatch(/not a player/);
  });

  it("the records come first under their own heading, the chat after under its own, and the prompt says the records win", () => {
    const { text } = buildUnifiedContext(input());
    const records = text.indexOf("THE CLUB'S RECORDS");
    const chat = text.indexOf("THE CHAT");
    expect(records).toBeGreaterThan(-1);
    expect(chat).toBeGreaterThan(records);
    expect(text.indexOf("UPCOMING MATCH")).toBeGreaterThan(records);
    expect(text.indexOf("UPCOMING MATCH")).toBeLessThan(chat);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/the records are right/i);
  });

  it("the word CONTEXT appears nowhere: not in the prompt, not in what the model reads", () => {
    expect(UNIFIED_ANSWER_SYSTEM).not.toMatch(/CONTEXT/);
    expect(buildUnifiedContext(input()).text).not.toMatch(/CONTEXT/);
    expect(buildUnifiedContext(input({ audience: "organisers" })).text).not.toMatch(/CONTEXT/);
  });

  it("the squad and the bench are headed with their own counts", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toContain("SQUAD (3 of 14), in the order they joined");
    expect(text).toContain("BENCH (2), in order");
  });
});

describe("round 2: how the club is run, for a monthly club", () => {
  it("a monthly club gets the monthly squad's rules: nobody needs to confirm, OUT opens the place, pay as you go takes it", () => {
    const { text } = buildUnifiedContext(input({ squadMode: "monthly" }));
    const run = text.slice(text.indexOf("HOW THE CLUB IS RUN"), text.indexOf("UPCOMING MATCH"));
    expect(run).toMatch(/monthly squad/i);
    expect(run).toMatch(/nobody needs to confirm/i);
    expect(run).toMatch(/OUT/);
    expect(run).toMatch(/pay as you go/i);
  });

  it("a weekly club does not", () => {
    expect(buildUnifiedContext(input({ squadMode: "weekly" })).text).not.toMatch(/monthly squad/i);
    expect(buildUnifiedContext(input()).text).not.toMatch(/monthly squad/i);
  });
});

describe("round 2: the stats the answer is given", () => {
  it("no ratings table yet says why: nobody has 3 rated matches", () => {
    const { text } = buildUnifiedContext(input({ stats: { ...STATS, ratings: [] } }));
    expect(text).toMatch(/CLUB RATINGS: nobody has 3 rated matches yet/);
  });

  it("Man of the Match match by match, newest first, decided ones only", () => {
    const stats = {
      ...STATS,
      lastMom: lastMomOf([mom("2026-08-25T20:30:00Z", "Akram", 1, 1, true), mom("2026-08-18T20:30:00Z", "Mo", 5, 9), mom("2026-08-11T20:30:00Z", "Naim", 4, 8)]),
    };
    const { text } = buildUnifiedContext(input({ stats }));
    const block = text.slice(text.indexOf("MAN OF THE MATCH, MATCH BY MATCH"));
    expect(block).toMatch(/Tue 25 Aug: Akram, picked by the organisers/);
    expect(block).toMatch(/Tue 18 Aug: Mo, 5 of 9 votes/);
    expect(block).toMatch(/Tue 11 Aug: Naim, 4 of 8 votes/);
    expect(block.indexOf("Akram")).toBeLessThan(block.indexOf("Naim"));
  });

  it("the players' group: the top of the ratings table only, and one player's rating only when in it", () => {
    const ratings = Array.from({ length: 12 }, (_, i) => ({ userId: i === 11 ? "u-zair" : `u-p${i}`, name: i === 11 ? fullName("zair") : `Player ${i}`, avg: 8 - i * 0.1, games: 3, rank: i + 1, delta: 0 }));
    const { text } = buildUnifiedContext(input({ stats: { ...STATS, ratings }, person: { userId: "u-zair", self: false } }));
    expect(text).not.toContain(`${fullName("zair")}: 6.9`);
    expect(text).toMatch(/club rating: not in the top of the table/);
  });

  it("the organisers: the whole ratings table, each squad and bench player's rating, and any player's rating", () => {
    const ratings = Array.from({ length: 12 }, (_, i) => ({ userId: i === 11 ? "u-zair" : `u-p${i}`, name: i === 11 ? fullName("zair") : `Player ${i}`, avg: 8 - i * 0.1, games: 3, rank: i + 1, delta: 0 }));
    const { text } = buildUnifiedContext(input({ audience: "organisers", stats: { ...STATS, ratings }, person: { userId: "u-zair", self: false } }));
    expect(text).toContain(`12. ${fullName("zair")}: 6.9`);
    expect(text).toMatch(new RegExp(`CLUB RATINGS OF THE SQUAD AND BENCH[^\\n]*\\n[^]*${fullName("zair")} 6\\.9 \\(bench\\)`));
    expect(text).toMatch(/club rating: 6\.9 from 3 rated matches, no\. 12/);
  });

  it("the ratings each player got in the last match: the organisers only", () => {
    const lastMatchRatings = {
      date: new Date("2026-08-25T20:30:00Z"),
      rows: [
        { userId: "u-sait", name: fullName("sait"), avg: 7.4, count: 6 },
        { userId: "u-idris", name: fullName("idris"), avg: 6.2, count: 5 },
      ],
    };
    const org = buildUnifiedContext(input({ audience: "organisers", lastMatchRatings })).text;
    expect(org).toMatch(/RATINGS EACH PLAYER GOT IN THE LAST RATED MATCH \(Tue 25 Aug\)/);
    expect(org).toContain(`${fullName("sait")} 7.4 (6 ratings)`);
    const players = buildUnifiedContext(input({ lastMatchRatings })).text;
    expect(players).not.toContain("7.4 (6 ratings)");
    expect(players).toMatch(/ONE MATCH'S RATINGS[^\n]*the organisers see them/);
  });

  it("the asker's own stats, when the caller gives them (HQ 'my rating'), under a heading that is not 'you'", () => {
    const { text } = buildUnifiedContext(input({ audience: "organisers", own: ["THE ASKER'S OWN STATS:\n- Average rating: 6.8"] }));
    expect(text).toContain("THE ASKER'S OWN STATS:");
  });
});

describe("round 2: a club whose organisers post the list", () => {
  const organisersPost = () => {
    const base = input();
    return { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
  };

  it("a reply that names the squad, and only the squad, becomes the organisers' line", async () => {
    const st = organisersPost();
    const { model } = stub(`In: ${fullName("kemal")}, ${fullName("sait")} and ${fullName("idris")}.`);
    const r = await answerUnified({ ...input({ state: st }), model });
    expect(r.result).toEqual({ text: "The organisers will post the list." });
  });

  it("a ratings table or a count is NOT swallowed", async () => {
    const st = organisersPost();
    const table = await answerUnified({ ...input({ state: st }), model: stub(`Top rating: ${fullName("erdal")} 7.4 (9 rated).`).model });
    expect(table.result).toEqual({ text: `Top rating: ${fullName("erdal")} 7.4 (9 rated).` });
    const count = await answerUnified({ ...input({ state: st }), model: stub("3 of 14 in, 11 places left.").model });
    expect(count.result).toEqual({ text: "3 of 14 in, 11 places left." });
  });
});

describe("matchRatingsFrom: one match's ratings per player (2026-11-11)", () => {
  it("averages each player's ratings, highest first, ties by name, with how many rated them", () => {
    const r = matchRatingsFrom(new Date("2026-11-06T20:30:00Z"), [
      { userId: "u-b", name: "Bilal", avg: 6.5, count: 4 },
      { userId: "u-a", name: "Akram", avg: 7.25, count: 8 },
      { userId: "u-c", name: "Clarence", avg: 6.5, count: 2 },
    ]);
    expect(r.rows.map((x) => `${x.name} ${x.avg} ${x.count}`)).toEqual(["Akram 7.25 8", "Bilal 6.5 4", "Clarence 6.5 2"]);
    expect(r.date.toISOString()).toBe("2026-11-06T20:30:00.000Z");
  });
});

describe("round 2: 'the 4 highest rated on the list' (A/B pass 2a: the model ignored a separate line)", () => {
  const ratings = [
    { userId: "u-erdal", name: fullName("erdal"), avg: 7.4, games: 9, rank: 1, delta: 0 },
    { userId: "u-elvin", name: fullName("elvin"), avg: 7.1, games: 5, rank: 2, delta: 0 },
    { userId: "u-sait", name: fullName("sait"), avg: 6.9, games: 4, rank: 3, delta: 0 },
  ];

  it("the players' group: a squad or bench player in the top of the table carries their club rating on their own line", () => {
    const { text } = buildUnifiedContext(input({ stats: { ...STATS, ratings } }));
    expect(text).toContain(`  2. ${fullName("sait")} (club rating 6.9, no. 3)`);
    expect(text).toContain(`  1. ${fullName("erdal")} (club rating 7.4, no. 1)`);
    expect(text).toContain(`  1. ${fullName("kemal")}\n`);
  });

  it("the organisers: every rated squad and bench player carries it", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ userId: i === 11 ? "u-kemal" : `u-p${i}`, name: i === 11 ? fullName("kemal") : `Player ${i}`, avg: 8 - i * 0.1, games: 3, rank: i + 1, delta: 0 }));
    const { text } = buildUnifiedContext(input({ audience: "organisers", stats: { ...STATS, ratings: many } }));
    expect(text).toContain(`  1. ${fullName("kemal")} (club rating 6.9, no. 12)`);
    const players = buildUnifiedContext(input({ stats: { ...STATS, ratings: many } })).text;
    expect(players).toContain(`  1. ${fullName("kemal")}\n`);
  });

  it("not when the organisers post the list: no squad names at all", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    expect(buildUnifiedContext(input({ state: st, stats: { ...STATS, ratings } })).text).not.toMatch(/club rating 6\.9, no\. 3/);
  });
});

describe("round 2, pass 2a: what the A/B found next", () => {
  it("one match's ratings: said plainly as the organisers' only, and that the club ratings are everyone's", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toMatch(/ONE MATCH'S RATINGS[^\n]*not shared in the players' group or in private messages/);
    expect(text).toMatch(/The club ratings above are shared with everyone/);
    expect(text).not.toMatch(/shown to the organisers only/);
  });

  it("the whole record is labelled with where it starts, so 'the last year' is not read as 'since 1 January'", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toMatch(/STATS, THE WHOLE RECORD[^\n]*on Tue 7 Apr 2026/);
  });

  it("who has rated: the count of those who rated is said, not left to be worked out from two name lists", () => {
    const { text } = buildUnifiedContext(input({ askerUserId: "u-kemal", askerName: fullName("kemal"), ratingProgress: { ok: true, matchName: "Tuesday", matchWhen: "3 Nov", confirmed: 14, ratedCount: 4, momCount: 2, notRated: [fullName("zair")], ratedNoMom: [fullName("sait")] } }));
    expect(text).toMatch(/- Rated: 4 \(their names are not listed\)/);
    expect(text).toMatch(/- Of those who rated, no Man of the Match vote yet: /);
  });
});

describe("round 2, pass 2a: the prompt teaches naming who to ask", () => {
  it("a fact the records do not hold is answered with who to ask, by name (FNF HQ 'who coordinates booking?')", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"who books the pitch\?".*The admins are .*ask one of them/);
  });
});

describe("round 2, pass 2b: 'the list' is the squad", () => {
  it("the prompt says 'the list' means the squad list and teaches the top-rated-on-the-list answer from the squad lines", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"the list" means the squad list/i);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"who are the 2 highest rated on the list\?".*club rating/);
  });
});

/**
 * ROUND 3 (2026-11-12). Each test reproduces what the round 2 A/B found in
 * the context the model was given (ab-results-final.json, r2).
 */
const THIS_YEAR = {
  label: "this year",
  tables: {
    since: new Date("2026-01-01T00:00:00.000Z"),
    appearances: [{ userId: "u-erdal", name: fullName("erdal"), matches: 12 }],
    ratings: [],
    mom: [],
  },
};

describe("round 3: where the record starts (Sutton and FNF 'who has played most in the last 1 year?')", () => {
  it("a span that starts before the record is headed by the record's first game, never by its calendar start", () => {
    // Round 2: "STATS, THIS YEAR (since Thu 1 Jan 2026)" with the record
    // starting in April; the reply said "my records only go back to 1 Jan".
    const { text } = buildUnifiedContext(input({ periods: [THIS_YEAR] }));
    expect(text).not.toMatch(/1 Jan 2026/);
    expect(text).toMatch(/STATS, THIS YEAR \([^\n]*Tue 7 Apr 2026[^\n]*whole record/);
  });

  it("a span inside the record keeps its own start", () => {
    const last30 = { ...THIS_YEAR, label: "the last 30 days", tables: { ...THIS_YEAR.tables, since: new Date("2026-08-02T00:00:00.000Z") } };
    const { text } = buildUnifiedContext(input({ periods: [last30] }));
    expect(text).toMatch(/STATS, THE LAST 30 DAYS \(since Sun 2 Aug 2026\)/);
  });

  it("the whole record gives its first game's full date, how long ago that is, and that nothing older exists", () => {
    const { text } = buildUnifiedContext(input());
    const head = text.split("\n").find((l) => l.startsWith("STATS, THE WHOLE RECORD"))!;
    expect(head).toMatch(/first game MatchTime recorded for this club, on Tue 7 Apr 2026, 4 months before today/);
    expect(head).toMatch(/nothing older/);
  });

  it("the same in a DM: the record's start, not a calendar date", () => {
    const { text } = buildUnifiedContext(input({ audience: "dm", periods: [THIS_YEAR] }));
    expect(text).not.toMatch(/1 Jan 2026/);
  });
});

describe("round 3: as much as this audience is shown (Sutton 'tell us the top 50 rating holders')", () => {
  it("the players' group and a DM are told each table is its top 10, as many as are shared there, and where the rest are", () => {
    for (const audience of ["players", "dm"] as const) {
      const { text } = buildUnifiedContext(input({ audience }));
      expect(text).toMatch(/each table is its top 10[^\n]*as many as MatchTime shares here[^\n]*the stats page/);
    }
  });

  it("the organisers are not: they see the whole ratings table", () => {
    expect(buildUnifiedContext(input({ audience: "organisers" })).text).not.toMatch(/as many as MatchTime shares here/);
  });
});

describe("round 3: the registered players (FNF HQ 'I meant the registered players')", () => {
  it("the members are labelled as the players registered with the club, with their count", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toMatch(/MEMBERS, the players registered with the club \(\d+\): /);
  });
});

describe("round 3: what MatchTime does while places are open (FNF HQ 'what happens if 14 don't confirm?')", () => {
  const facts = { pool: { open: true, platformOpen: true, clubFlag: true }, partners: { active: 2 } };
  const run = (text: string) => text.slice(text.indexOf("HOW THE CLUB IS RUN"), text.indexOf("UPCOMING MATCH"));

  it("says the 17:00 squad post goes on while places are open, in the players' group", () => {
    const r = run(buildUnifiedContext(input({ clubFacts: facts })).text);
    expect(r).toMatch(/While places are open[^\n]*17:00[^\n]*in the players' group[^\n]*drop-out deadline/);
  });

  it("goes to the organisers in HQ when the organisers post the list", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    const r = run(buildUnifiedContext(input({ state: st, clubFacts: facts, audience: "organisers" })).text);
    expect(r).toMatch(/While places are open[^\n]*17:00[^\n]*to the organisers in HQ/);
  });

  it("partner clubs and the pool: how many, whether on, and that the organisers ask them by tagging MatchTime", () => {
    const r = run(buildUnifiedContext(input({ clubFacts: facts })).text);
    expect(r).toMatch(/Partner clubs[^\n]*2 active[^\n]*organisers can ask them[^\n]*tagging MatchTime/);
    expect(r).toMatch(/player pool[^\n]*on[^\n]*organisers can ask it[^\n]*tagging MatchTime/);
    const off = run(buildUnifiedContext(input({ clubFacts: { pool: { open: false, platformOpen: true, clubFlag: false }, partners: { active: 0 } } })).text);
    expect(off).toMatch(/Partner clubs[^\n]*none/);
    expect(off).toMatch(/player pool[^\n]*off/);
    expect(off).not.toMatch(/organisers can ask/);
  });
});

describe("round 3: the prompt, rewritten whole", () => {
  it("teaches a correction to be answered for what it now says, with an example in both languages", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/corrects or narrows/);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"no, I meant the bench, not the squad"/);
  });

  it("teaches a message with no subject of its own to follow on from MatchTime's own latest reply", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/no subject of its own/);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"why\?" \/ "neden\?"/);
  });

  it("teaches the spans: a longer span than the record is answered from the whole record, saying where it starts", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/nothing older exists/);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"who has played most in the last year\?"/);
  });

  it("teaches giving what this audience is shown when more is asked for, with where the rest is", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"top 20 ratings"/);
  });

  it("teaches 'what happens if' about the club to be answered from how the club is run", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/what happens if/i);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/how the club is run/i);
  });

  it("stays above Haiku 5.5's cache floor", () => {
    expect(UNIFIED_ANSWER_SYSTEM.length / 2.6).toBeGreaterThan(MIN_CACHEABLE_TOKENS["claude-haiku-5-5"] * 1.5);
  });
});

describe("round 3, after the full A/B: what it found", () => {
  it("Man of the Match reaching further back than the games says where it starts (Sutton 'most MoM so far': 'my records start on 21 Apr')", () => {
    const stats = { ...STATS, recordsStart: { matches: STATS.recordsStart.matches, mom: new Date("2024-11-12T20:30:00.000Z") } };
    const { text } = buildUnifiedContext(input({ stats }));
    expect(text).toMatch(/MAN OF THE MATCH WINS \([^\n]*Tue 12 Nov 2024/);
    expect(text.split("\n").find((l) => l.startsWith("STATS, THE WHOLE RECORD"))).toMatch(/except Man of the Match/);
  });

  it("Man of the Match starting with the games adds nothing", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).not.toMatch(/except Man of the Match/);
  });

  it("the prompt: a tag with nothing after it is not a follow-up (FNF HQ '@Match Time' was answered about the ratings table)", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/A tag with nothing after it/);
  });

  it("the prompt: 'what happens if' is answered by the club's own rules, a monthly club's included (Vets 'what happens if 14 don't confirm?': 'the squad stays short')", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/"what happens if not enough confirm\?".*monthly squad.*Nobody needs to confirm/);
  });
});

describe("round 3: a DM asker's own club rating (Sutton DM 'what is Erdal's rating?', asked by Erdal, was refused once)", () => {
  const ratings = Array.from({ length: 12 }, (_, i) => ({ userId: i === 11 ? "u-erdal" : `u-p${i}`, name: i === 11 ? fullName("erdal") : `Player ${i}`, avg: 8 - i * 0.1, games: 3, rank: i + 1, delta: 0 }));

  it("in a DM, the asker's own rating is given even outside the top of the table: it is their own", () => {
    const { text } = buildUnifiedContext(input({ audience: "dm", askerUserId: "u-erdal", stats: { ...STATS, ratings }, person: { userId: "u-erdal", self: true } }));
    expect(text).toMatch(/club rating: 6\.9 from 3 rated matches, no\. 12/);
    expect(text).not.toMatch(/club rating: not in the top of the table/);
  });

  it("someone else's rating outside the top is still not shared in a DM, nor one's own in the players' group", () => {
    const other = buildUnifiedContext(input({ audience: "dm", stats: { ...STATS, ratings }, person: { userId: "u-erdal", self: false } })).text;
    expect(other).toMatch(/club rating: not in the top of the table/);
    const group = buildUnifiedContext(input({ stats: { ...STATS, ratings }, person: { userId: "u-erdal", self: true } })).text;
    expect(group).toMatch(/club rating: not in the top of the table/);
  });
});
