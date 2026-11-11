/**
 * THE UNIFIED ANSWER's context and call (`unified-answer.ts`, UNIFIED_ANSWERS).
 * The privacy rules live in the context builder, by audience: what the model
 * is not told it cannot leak.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { HAIKU_CALL } from "../llm";
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
    expect(players).toMatch(/ratings each player got in one match are shown to the organisers only/i);
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

describe("round 2: 'the 4 highest rated on the list' in the players' group", () => {
  it("names the squad and bench players who are in the top of the table, and says the rest are not shared", () => {
    const ratings = [
      { userId: "u-erdal", name: fullName("erdal"), avg: 7.4, games: 9, rank: 1, delta: 0 },
      { userId: "u-elvin", name: fullName("elvin"), avg: 7.1, games: 5, rank: 2, delta: 0 },
      { userId: "u-sait", name: fullName("sait"), avg: 6.9, games: 4, rank: 3, delta: 0 },
    ];
    const { text } = buildUnifiedContext(input({ stats: { ...STATS, ratings } }));
    expect(text).toContain(`SQUAD AND BENCH PLAYERS IN THE TOP ${10} OF THE RATINGS TABLE, highest first: ${fullName("erdal")} 7.4 (bench), ${fullName("sait")} 6.9 (squad)`);
    expect(text).toMatch(/other squad and bench players' ratings are not shared in the group/);
  });

  it("not when the organisers post the list: no squad names at all", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    expect(buildUnifiedContext(input({ state: st })).text).not.toMatch(/SQUAD AND BENCH PLAYERS IN THE TOP/);
  });
});
