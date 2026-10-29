/**
 * AN ORGANISER'S SHORT LIST OF NAMES WITH A BARE IN OR OUT, IN HQ
 * (FNF HQ, 2026-10-17 09:01 London).
 *
 * "Imti\nRafi\nAH\n\nIn", then "Yaseen\nMo\nFeroz\nAli\n\nOut". Nothing was
 * written. Traced: the router (model) routed the first `none` (19 of 20
 * dev-key reruns with the same context gave other_att: a model miss, not
 * the context), and the HQ vetting would have held every claim anyway (a
 * name alone on its line is no command clause).
 *
 * In HQ the list is structured data, like a pasted squad list
 * (`admin-group-name-list.ts`). The players' group and DMs never read it:
 * their router path is exactly main's.
 */
import { describe, expect, it } from "vitest";
import { hqNameListFacts, readHqNameList } from "../admin-group-name-list";
import { floorAttendanceFacts, routeBatch, routeFloor } from "../pipeline/router";
import type { PipelineModel } from "../pipeline/llm";
import { runAttendanceEngineBatch, type EngineBatchDeps, type EngineBatchMessage } from "../attendance-engine-batch";
import type { SquadState } from "../pipeline/types";

describe("readHqNameList: names and a bare IN or OUT", () => {
  it.each<[string, string[], "in" | "out"]>([
    // the incident, word for word (trailing spaces included)
    ["Imti \nRafi \nAH\n\nIn", ["Imti", "Rafi", "AH"], "in"],
    ["Yaseen \nMo\nFeroz\nAli\n\nOut", ["Yaseen", "Mo", "Feroz", "Ali"], "out"],
    // the same on one line
    ["Imti, Rafi and AH in", ["Imti", "Rafi", "AH"], "in"],
    ["Yaseen, Mo, Feroz and Ali out", ["Yaseen", "Mo", "Feroz", "Ali"], "out"],
    ["Imti & Rafi IN", ["Imti", "Rafi"], "in"],
    // the token first
    ["In\nImti\nRafi", ["Imti", "Rafi"], "in"],
    ["OUT: Yaseen, Mo", ["Yaseen", "Mo"], "out"],
    ["Out -\nYaseen\nMo", ["Yaseen", "Mo"], "out"],
    // numbered or bulleted, full names, emoji after the token
    ["1. Imti\n2. Rafi Khan\nIN 👍", ["Imti", "Rafi Khan"], "in"],
    ["- Abdul-Hafeez\n- Mo\nout", ["Abdul-Hafeez", "Mo"], "out"],
    // @tags named by the caller
    ["@Kojo, @Aaron in", ["Kojo", "Aaron"], "in"],
    // Turkish
    ["Ali ve Mehmet var", ["Ali", "Mehmet"], "in"],
    ["Ali, Mehmet yok", ["Ali", "Mehmet"], "out"],
  ])("%j: %s, %s", (body, names, polarity) => {
    expect(readHqNameList(body)).toEqual({ polarity, names });
  });

  it("each claim is what the words say: present, a decision, named, not contingent", () => {
    const f = hqNameListFacts("Imti \nRafi \nAH\n\nIn");
    expect(f && f.kind === "attendance" && f.claims.map((c) => c.personRef)).toEqual(["Imti", "Rafi", "AH"]);
    expect(f && f.kind === "attendance" && f.claims[0]).toEqual({
      subject: "other",
      personRef: "Imti",
      personNamed: true,
      polarity: "in",
      contingent: false,
      conditionOn: "none",
      tense: "present",
      reported: false,
      confidence: 1,
      replaces: "",
    });
  });

  it.each([
    // the organisers' own conversation around the incident (AdminGroupMessage rows)
    "Imti Rafi AH back",
    "Mojib and Habib are in dw",
    "Maybe shehryar hamzah too",
    "We have the below out - \n\nYaseen\nMo\nFeroz\nWasim 50/50\nMojib \nHabib \nAli",
    "Mo had bibs and Naim won motm",
    // a question, not an instruction
    "Imti and Rafi in?",
    // one name: the router's, as before ("Baki OUT")
    "Tom in",
    // the sender among the names, or the group, or the bot
    "Me and Tom in",
    "Tom and me out",
    "all in",
    "everyone out",
    "@Match Time Imti, Rafi in",
    "Match Time and Tom in",
    // a sentence around the names
    "Mo, Feroz and Ali in the hospital",
    "Tom and Sam are in",
    "in the end Tom and Sam lost",
    "in for tuesday and bringing my brother",
    "Ali var, Mehmet yok",
    // not written as names
    "imti\nrafi\nin",
    // both ways in one message
    "In\nTom\nSam\nOut",
    "In\nA1\nB2",
    // a whole squad is a pasted list, not this
    ["In", "Aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg", "Hh", "Ii"].join("\n"),
  ])("does not read %j", (body) => {
    expect(readHqNameList(body)).toBeNull();
    expect(hqNameListFacts(body)).toBeNull();
  });
});

describe("the players' group is unchanged: no deterministic reading of a name list there", () => {
  it.each(["Mo\nAli\nIn", "Imti \nRafi \nAH\n\nIn", "Yaseen, Mo, Feroz and Ali out"])("%j: the floor does not claim it", (body) => {
    expect(routeFloor(body)).toBeNull();
    expect(floorAttendanceFacts(body)).toBeNull();
  });

  it('"Mo\\nAli\\nIn" in the players\' group: the router\'s answer stands, even none', async () => {
    const model: PipelineModel = {
      name: "says none",
      async complete() {
        return {
          text: JSON.stringify({ routes: [{ id: "m1", route: "none" }] }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const r = await routeBatch(model, [{ id: "p1", authorName: "Sam", body: "Mo\nAli\nIn" }], { floor: true });
    expect(r.routes[0]).toMatchObject({ route: "none", source: "model" });
  });
});

// ── the engine: `presetFacts` (the admin group's structured data) ─────

function forbiddenModel(): PipelineModel & { calls: number } {
  const m = {
    name: "forbidden",
    calls: 0,
    async complete(): Promise<never> {
      m.calls++;
      throw new Error("the extractor was called for structured data");
    },
  };
  return m;
}

function state(): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 10,
    kickoffLabel: "Fri 20:30",
    venue: "The Pitch",
    rows: [
      { userId: "u-yaseen", status: "CONFIRMED" as const, position: 1 },
      { userId: "u-mo", status: "CONFIRMED" as const, position: 2 },
    ],
    roster: [
      { userId: "u-hamzah", name: "Hamzah", isAdmin: true, hasPhone: true },
      { userId: "u-imti", name: "Imti", isAdmin: false, hasPhone: true },
      { userId: "u-rafi", name: "Rafi", isAdmin: false, hasPhone: true },
      { userId: "u-yaseen", name: "Yaseen", isAdmin: false, hasPhone: true },
      { userId: "u-mo", name: "Mo", isAdmin: false, hasPhone: true },
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

function msg(over: Partial<EngineBatchMessage> = {}): EngineBatchMessage {
  return {
    waMessageId: "wa-1",
    body: "Imti\nRafi\n\nIn",
    authorName: "Hamzah",
    senderUserId: "u-hamzah",
    senderName: "Hamzah",
    senderIsAdmin: true,
    tagged: true,
    route: "other_att",
    gated: false,
    ...over,
  };
}

function deps(model: PipelineModel, over: Partial<EngineBatchDeps> = {}) {
  const registered: string[] = [];
  const cancelled: string[] = [];
  const d = {
    model,
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    async registerAttendance(userId: string) {
      registered.push(userId);
      return { status: "CONFIRMED" as const, position: 3, slot: 3, confirmedCount: 3, maxPlayers: 10 };
    },
    async cancelAttendance(userId: string) {
      cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name: string) {
      return { userId: `new:${name}` };
    },
    ...over,
  } as unknown as EngineBatchDeps;
  return { d, registered, cancelled };
}

const run = (messages: EngineBatchMessage[], d: EngineBatchDeps) =>
  runAttendanceEngineBatch({ orgId: "org-1", now: new Date("2026-10-17T08:01:31Z"), messages, history: [], expectedMatchId: null, enabled: true, deps: d });

const preset = (m: EngineBatchMessage) => hqNameListFacts(m.body);

describe("the attendance engine with presetFacts: structured data is decided from the caller's facts, no extractor", () => {
  it("names and IN: each one in, zero model calls", async () => {
    const model = forbiddenModel();
    const { d, registered } = deps(model, { presetFacts: preset });
    const r = await run([msg()], d);
    expect(model.calls).toBe(0);
    expect(registered).toEqual(["u-imti", "u-rafi"]);
    expect(r.cost.calls).toBe(0);
  });

  it("names and OUT: each one out, zero model calls, at the daily AI cap too", async () => {
    const model = forbiddenModel();
    const { d, cancelled } = deps(model, { presetFacts: preset, aiCapped: true });
    await run([msg({ body: "Yaseen\nMo\n\nOut" })], d);
    expect(model.calls).toBe(0);
    expect(cancelled).toEqual(["u-yaseen", "u-mo"]);
  });

  it("a message the caller has no facts for still goes to the extractor", async () => {
    const model = forbiddenModel();
    const { d } = deps(model, { presetFacts: preset });
    await run([msg({ body: "put Imti in please, Rafi too" })], d);
    expect(model.calls).toBeGreaterThan(0);
  });
});
