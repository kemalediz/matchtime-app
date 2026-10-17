/**
 * A SHORT LIST OF NAMES WITH A BARE IN OR OUT, READ WITHOUT A MODEL
 * (FNF HQ, 2026-10-17 09:01 London).
 *
 * An organiser sent "Imti\nRafi\nAH\n\nIn", then "Yaseen\nMo\nFeroz\nAli\n\nOut".
 * Nothing was written. Traced: the router (model) routed the first `none`
 * ("routed none by model (0 waiting)"); run again on the dev key with the
 * same context it gave other_att 9 times in 10 and `none` once, so a model
 * miss, not the context. And had it routed other_att, the HQ vetting would
 * still have held every claim, because a name alone on its line is not a
 * command clause (`admin-group-squad-rules.ts`).
 *
 * The fix is the floor: the same shape as "@Name IN" (names and a bare
 * token, nothing else), so it is structured data and read in code, in
 * every group. Names separated by new lines, commas, "and", "&" or "ve";
 * the token first or last. Two to eight names. Anything else is the
 * router's, as before.
 */
import { describe, expect, it } from "vitest";
import { floorAttendanceFacts, routeBatch, routeFloor } from "../router";
import type { PipelineModel } from "../llm";
import { runAttendanceEngineBatch, type EngineBatchDeps, type EngineBatchMessage } from "../../attendance-engine-batch";
import type { SquadState } from "../types";

const people = (body: string) => {
  const f = floorAttendanceFacts(body);
  return f && f.kind === "attendance" ? f.claims.map((c) => [c.subject, c.personRef, c.polarity]) : null;
};

describe("the list floor: names and a bare IN or OUT", () => {
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
    // mentions as names
    ["@Kojo, @Aaron in", ["Kojo", "Aaron"], "in"],
    // Turkish
    ["Ali ve Mehmet var", ["Ali", "Mehmet"], "in"],
    ["Ali, Mehmet yok", ["Ali", "Mehmet"], "out"],
  ])("%j: other_att, each name %s", (body, names, polarity) => {
    expect(routeFloor(body)).toBe("other_att");
    expect(people(body)).toEqual(names.map((n) => ["other", n, polarity]));
  });

  it("each claim is what the words say: present, a decision, named, not contingent", () => {
    const f = floorAttendanceFacts("Imti \nRafi \nAH\n\nIn");
    expect(f && f.kind === "attendance" && f.claims[0]).toEqual({
      subject: "other",
      personRef: "Imti",
      personNamed: true,
      polarity: "in",
      contingent: false,
      conditionOn: "none",
      tense: "present",
      basis: "decision",
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
    "Ali var, Mehmet yok",
    "in for tuesday and bringing my brother",
    // not written as names: the router's
    "imti\nrafi\nin",
    // both ways in one message
    "In\nTom\nSam\nOut",
    // a whole squad is a pasted list, not this
    "In\nA1\nB2",
    ["In", "Aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg", "Hh", "Ii"].join("\n"),
  ])("does not claim %j", (body) => {
    expect(routeFloor(body)).toBeNull();
    expect(floorAttendanceFacts(body)).toBeNull();
  });

  it("the router overrides a model `none` with it, the incident's miss", async () => {
    const model: PipelineModel = {
      name: "says none",
      async complete() {
        return {
          text: JSON.stringify({ routes: [{ id: "m1", route: "none" }, { id: "m2", route: "none" }] }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const r = await routeBatch(
      model,
      [
        { id: "m1", authorName: "Hamzah", body: "Imti \nRafi \nAH\n\nIn", organisers: { context: ["WAITING: nothing."] } },
        { id: "m2", authorName: "Hamzah", body: "lol", organisers: { context: ["WAITING: nothing."] } },
      ],
      { floor: true },
    );
    expect(r.routes.find((x) => x.messageId === "m1")).toMatchObject({ route: "other_att", source: "floor", overrodeRoute: "none" });
    expect(r.routes.find((x) => x.messageId === "m2")).toMatchObject({ route: "none" });
  });
});

// ── the engine: `floorFirst` (the organisers' group) ──────────────────

function forbiddenModel(): PipelineModel & { calls: number } {
  const m = {
    name: "forbidden",
    calls: 0,
    async complete(): Promise<never> {
      m.calls++;
      throw new Error("the extractor was called for a message the floor reads");
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

describe("the attendance engine with floorFirst: a message the floor reads is decided from its facts, no extractor", () => {
  it("names and IN: each one in, zero model calls", async () => {
    const model = forbiddenModel();
    const { d, registered } = deps(model, { floorFirst: true });
    const r = await run([msg()], d);
    expect(model.calls).toBe(0);
    expect(registered).toEqual(["u-imti", "u-rafi"]);
    expect(r.cost.calls).toBe(0);
  });

  it("names and OUT: each one out, zero model calls", async () => {
    const model = forbiddenModel();
    const { d, cancelled } = deps(model, { floorFirst: true });
    await run([msg({ body: "Yaseen\nMo\n\nOut" })], d);
    expect(model.calls).toBe(0);
    expect(cancelled).toEqual(["u-yaseen", "u-mo"]);
  });

  it("a message the floor cannot read still goes to the extractor", async () => {
    const model = forbiddenModel();
    const { d } = deps(model, { floorFirst: true });
    await run([msg({ body: "put Imti in please, Rafi too" })], d);
    expect(model.calls).toBeGreaterThan(0);
  });
});
