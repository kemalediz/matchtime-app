/**
 * FNF HQ, 2026-10-24 (UTC): "Glazers in" at 11:30 put a brand-new,
 * phoneless member on the bench; "Glazers out. I was just testing you"
 * (11:34) and "Glazers OUT" (11:43) changed nothing and said nothing.
 *
 * Traced on the dev key with production's own input: the router gave both
 * other_att, and the attendance extractor returned NO claims for either
 * (2 of 2 each), while "Tom OUT" and "Shehryar OUT" gave an "out" claim.
 * The extractor is never shown the squad, so it had no way to know
 * "Glazers" was a person in the club. With the club's members the message
 * names on a CLUB MEMBERS NAMED line, it read "Glazers out" 4 of 4.
 * Three more removals failed at 12:41-12:46 UTC: "Remove glazers" (no claim,
 * 2 of 2) and "Glazers out" (an "out" at 0.5 and 0.6, under HQ's 0.7 floor,
 * so held). With the line: 0.8 and 0.9. A six-line "X out" list sent at
 * 12:45 worked: a name list is read in code, with no extractor.
 *
 * This pins the engine's half: the roster the engine already loaded,
 * including a member created minutes earlier with no phone, reaches the
 * extractor, and his OUT is then applied. The model here behaves as the
 * real one was measured to: no claim unless it is told Glazers is a member.
 * No database, no model call.
 */
import { describe, expect, it } from "vitest";
import { runAttendanceEngineBatch, type EngineBatchDeps } from "../attendance-engine-batch";
import { membersNamedIn } from "../pipeline/identity";
import type { PipelineModel } from "../pipeline/llm";
import type { SquadState } from "../pipeline/types";

const GLAZERS = { userId: "u-glazers", name: "Glazers", isAdmin: false, hasPhone: false };

function state(): SquadState {
  return {
    matchId: "match-fri",
    maxPlayers: 18,
    kickoffLabel: "Fri 20:30",
    venue: "The Pitch",
    rows: [
      { userId: "u-ah", status: "CONFIRMED", position: 1 },
      { userId: "u-glazers", status: "BENCH", position: 19 },
    ],
    roster: [
      { userId: "u-ah", name: "Abdul-Hafeez", isAdmin: true, hasPhone: true },
      { userId: "u-nasir", name: "Nasir", isAdmin: false, hasPhone: true },
      GLAZERS,
    ],
    openOffers: [],
    teams: [],
    teamLabels: ["Red", "Yellow"],
    completedMatch: null,
    payments: null,
    ratingProgress: null,
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "en" },
    smallerFormats: [],
    guestAskedUserIds: [],
  } as SquadState;
}

/** As measured on the real extractor: "Glazers OUT" is a claim only when
 *  the turn says Glazers is one of the club's members. */
function extractorAsMeasured(seen: string[]): PipelineModel {
  return {
    name: "as-measured",
    async complete(req) {
      seen.push(req.user);
      const told = /CLUB MEMBERS NAMED: .*\bGlazers\b/.test(req.user);
      const claims = told
        ? [
            {
              subject: "other",
              personRef: "Glazers",
              personNamed: true,
              polarity: "out",
              contingent: false,
              conditionOn: "none",
              tense: "present",
              reported: false,
              replaces: "",
              confidence: 0.9,
            },
          ]
        : [];
      return {
        text: JSON.stringify({ claims, affirmation: "none", sideRequests: [] }),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

function deps(model: PipelineModel, cancelled: string[]): EngineBatchDeps {
  return {
    model,
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    registerAttendance: async () => ({ status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 18 }),
    cancelAttendance: async (userId: string) => {
      cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    resolveOrProvision: async (name: string) => ({ userId: `new:${name}` }),
  } as unknown as EngineBatchDeps;
}

describe("a member created minutes earlier is taken out by name (FNF HQ 2026-10-24)", () => {
  // 11:34, 11:43, then 12:41 "Remove glazers", 12:42 and 12:46 "Glazers out".
  for (const body of ["Glazers OUT", "Glazers out. I was just testing you", "Remove glazers", "Glazers out"]) {
    it(`"${body}" drops Glazers off the bench`, async () => {
      const seen: string[] = [];
      const cancelled: string[] = [];
      const r = await runAttendanceEngineBatch({
        orgId: "org-fnf",
        now: new Date("2026-10-24T11:43:55Z"),
        expectedMatchId: null,
        enabled: true,
        history: [],
        messages: [
          {
            waMessageId: "wa-glazers-out",
            body,
            authorName: "Abdul-Hafeez",
            senderUserId: "u-ah",
            senderName: "Abdul-Hafeez",
            senderIsAdmin: true,
            tagged: true,
            route: "other_att",
            gated: false,
          },
        ],
        deps: deps(extractorAsMeasured(seen), cancelled),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("CLUB MEMBERS NAMED: Glazers");
      expect(cancelled).toEqual(["u-glazers"]);
      expect([...r.ownedIds]).toEqual(["wa-glazers-out"]);
    });
  }
});

describe("membersNamedIn: the club's members a message names, from the roster", () => {
  const roster = [
    { name: "Abdul-Hafeez" },
    { name: "Rafi" },
    { name: "Glazers" },
    { name: "Ali Khan" },
    { name: "Mo" },
    { name: "Alistair Brown" },
  ];
  it("lists a phoneless member created minutes earlier", () => {
    expect(membersNamedIn("Glazers OUT", [GLAZERS])).toEqual(["Glazers"]);
  });
  it("matches whole words, any case, with punctuation", () => {
    expect(membersNamedIn("RAfi IN", roster)).toEqual(["Rafi"]);
    expect(membersNamedIn("Glazers out. I was just testing you", roster)).toEqual(["Glazers"]);
    expect(membersNamedIn("Abdul-Hafeez IN", roster)).toEqual(["Abdul-Hafeez"]);
  });
  it("matches a first name or a full name, never part of a word", () => {
    expect(membersNamedIn("Ali out", roster)).toEqual(["Ali Khan"]);
    expect(membersNamedIn("put ali khan in", roster)).toEqual(["Ali Khan"]);
    expect(membersNamedIn("Alistair is in", roster)).toEqual(["Alistair Brown"]);
    expect(membersNamedIn("Glazersfamily out", roster)).toEqual([]);
  });
  it("a short first name only as the whole full name", () => {
    expect(membersNamedIn("Mo in", roster)).toEqual(["Mo"]);
    expect(membersNamedIn("more players please", roster)).toEqual([]);
  });
  it("nothing for a message that names nobody, and at most `max`", () => {
    expect(membersNamedIn("in", roster)).toEqual([]);
    expect(membersNamedIn("", roster)).toEqual([]);
    expect(membersNamedIn("Rafi Glazers Ali Mo", roster, 2)).toEqual(["Rafi", "Glazers"]);
  });
});

describe("the attendance extractor's CLUB MEMBERS NAMED line", () => {
  async function userTurn(members?: string[]): Promise<string> {
    const { extractForRoute } = await import("../pipeline/extractors");
    const seen: string[] = [];
    await extractForRoute(extractorAsMeasured(seen), "other_att", {
      id: "m1",
      body: "Glazers OUT",
      authorName: "Abdul-Hafeez",
      tagged: true,
      history: [],
      lastBotPost: null,
      ...(members ? { members } : {}),
    });
    return seen[0];
  }
  it("is shown, above THE MESSAGE, when the message names members", async () => {
    const turn = await userTurn(["Glazers"]);
    expect(turn.indexOf("CLUB MEMBERS NAMED: Glazers")).toBeGreaterThan(-1);
    expect(turn.indexOf("CLUB MEMBERS NAMED")).toBeLessThan(turn.indexOf("THE MESSAGE"));
  });
  it("is absent when it names none", async () => {
    expect(await userTurn()).not.toContain("CLUB MEMBERS NAMED");
    expect(await userTurn([])).not.toContain("CLUB MEMBERS NAMED");
  });
  it("is explained once in the prompt", async () => {
    const { EXTRACTOR_PROMPTS } = await import("../pipeline/extractors");
    expect(EXTRACTOR_PROMPTS.attendance.match(/CLUB MEMBERS NAMED/g)?.length).toBe(2);
  });
});
