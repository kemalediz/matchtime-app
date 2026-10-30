/**
 * FNF HQ, 2026-10-24 (UTC). Abdul-Hafeez has the alias "AH", set by an
 * organiser in the admin portal on 2026-10-17 (UserAlias, source manual).
 *
 *   12:48:27 "AH\nRafi\nShehryar \nRaihan \nHamzah \n\nIN": Rafi, Shehryar,
 *            Raihan and Hamzah came off the bench; AH stayed there.
 *   12:52:43 "AH out": nothing written and nothing said.
 *
 * Traced: the engine resolves a name with `resolvePerson` over the roster
 * `load-state.ts` builds, and neither knew any alias. "AH" was an unknown
 * guest, so the engine wrote a brand-new CONFIRMED registration with no
 * promotion; the writer then found Abdul-Hafeez through the alias table
 * (`resolveOrProvisionByName`), and `registerAttendance` left him on the
 * bench as an idempotent repeat. "AH out" about an unknown name is
 * "not a member; nothing to drop". And the CLUB MEMBERS NAMED line, which
 * lists members by roster name only, never told the extractor AH is one.
 *
 * Now a member carries their aliases, and the one resolver (and the line)
 * reads them. No database, no model call.
 */
import { describe, expect, it } from "vitest";
import { runAttendanceEngineBatch, type EngineBatchDeps } from "../attendance-engine-batch";
import { hqChangeFacts } from "../admin-group-squad-rules";
import { membersNamedIn, resolvePerson } from "../pipeline/identity";
import type { PipelineModel } from "../pipeline/llm";
import type { Member, SquadState } from "../pipeline/types";

const AH: Member = { userId: "u-ah", name: "Abdul-Hafeez", aliases: ["ah"], isAdmin: false, hasPhone: true };
const ROSTER: Member[] = [
  AH,
  { userId: "u-raihan", name: "Raihan", isAdmin: true, hasPhone: true },
  { userId: "u-rafi", name: "Rafi", isAdmin: false, hasPhone: true },
  { userId: "u-shehryar", name: "Shehryar", isAdmin: false, hasPhone: true },
  { userId: "u-hamzah", name: "Hamzah", isAdmin: false, hasPhone: true },
  { userId: "u-imti", name: "Imti", aliases: ["imtiaz"], isAdmin: false, hasPhone: true },
  { userId: "u-ahmed", name: "Ahmed Khan", isAdmin: false, hasPhone: true },
];

describe("resolvePerson reads the club's aliases", () => {
  it("an alias resolves to its member, any case", () => {
    expect(resolvePerson("AH", ROSTER)).toMatchObject({ kind: "resolved", member: { userId: "u-ah" } });
    expect(resolvePerson("ah", ROSTER)).toMatchObject({ kind: "resolved", member: { userId: "u-ah" } });
    expect(resolvePerson("@AH", ROSTER)).toMatchObject({ kind: "resolved", member: { userId: "u-ah" } });
    expect(resolvePerson("Imtiaz", ROSTER)).toMatchObject({ kind: "resolved", member: { userId: "u-imti" } });
  });
  it("an alias beats a first-name match on someone else", () => {
    const roster = [...ROSTER, { userId: "u-imtiaz-k", name: "Imtiaz Khan", isAdmin: false, hasPhone: true }];
    expect(resolvePerson("Imtiaz", roster)).toMatchObject({ kind: "resolved", member: { userId: "u-imti" } });
  });
  it("a member whose full name is the reference still wins over an alias", () => {
    const roster = [...ROSTER, { userId: "u-imtiaz", name: "Imtiaz", isAdmin: false, hasPhone: true }];
    expect(resolvePerson("Imtiaz", roster)).toMatchObject({ kind: "resolved", member: { userId: "u-imtiaz" } });
  });
  it("a short alias matches the whole reference or a whole word of it, never part of a word", () => {
    expect(resolvePerson("my mate AH", ROSTER)).toMatchObject({ kind: "resolved", member: { userId: "u-ah" } });
    expect(resolvePerson("Ahmed", ROSTER)).toMatchObject({ kind: "resolved", member: { userId: "u-ahmed" } });
    expect(resolvePerson("Aha", ROSTER)).toMatchObject({ kind: "unknown" });
  });
  it("with no aliases, as before", () => {
    expect(resolvePerson("AH", ROSTER.map(({ aliases: _a, ...m }) => m))).toMatchObject({ kind: "unknown" });
  });
});

describe("membersNamedIn shows an alias with the member's name", () => {
  it("AH (Abdul-Hafeez)", () => {
    expect(membersNamedIn("AH out", ROSTER)).toEqual(["AH (Abdul-Hafeez)"]);
    expect(membersNamedIn("Imtiaz and Rafi in", ROSTER)).toEqual(["Rafi", "Imtiaz (Imti)"]);
  });
  it("whole words only", () => {
    expect(membersNamedIn("Ahh mate, in", ROSTER)).toEqual([]);
    expect(membersNamedIn("Ahmed out", ROSTER)).toEqual(["Ahmed Khan"]);
  });
  it("the roster name when the message uses it, once", () => {
    expect(membersNamedIn("Abdul-Hafeez IN", ROSTER)).toEqual(["Abdul-Hafeez"]);
    expect(membersNamedIn("Abdul-Hafeez aka AH IN", ROSTER)).toEqual(["Abdul-Hafeez"]);
  });
});

function state(rows: SquadState["rows"]): SquadState {
  return {
    matchId: "match-fri",
    maxPlayers: 18,
    kickoffLabel: "Fri 20:30",
    venue: "The Pitch",
    rows,
    roster: ROSTER,
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

/** The extractor, as the engine would call it: "AH out" read as AH out. */
function extractor(seen: string[]): PipelineModel {
  return {
    name: "ah-out",
    async complete(req) {
      seen.push(req.user);
      const claims = [
        {
          subject: "other",
          personRef: "AH",
          personNamed: true,
          polarity: "out",
          contingent: false,
          conditionOn: "none",
          tense: "present",
          reported: false,
          replaces: "",
          confidence: 0.9,
        },
      ];
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

interface Calls {
  registered: Array<{ userId: string; promote: boolean }>;
  cancelled: string[];
  provisioned: string[];
}

function deps(rows: SquadState["rows"], calls: Calls, model: PipelineModel): EngineBatchDeps {
  return {
    model,
    loadState: async () => state(rows),
    // The HQ squad reader's reading of the name list (2026-10-30: a model
    // reads it, no code): each member by ref, given here by roster name.
    presetFacts: (m: { body: string }) =>
      m.body === NAME_LIST
        ? hqChangeFacts(
            [AH, ...ROSTER.filter((r) => ["u-rafi", "u-shehryar", "u-raihan", "u-hamzah"].includes(r.userId))].map((r) => ({ name: r.name, userId: r.userId, to: "in" as const, replaces: "" })),
            "u-raihan",
          )
        : null,
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    registerAttendance: async (userId: string, _matchId: string, options?: { promoteFromBench?: boolean }) => {
      calls.registered.push({ userId, promote: options?.promoteFromBench === true });
      return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 18 };
    },
    cancelAttendance: async (userId: string) => {
      calls.cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    resolveOrProvision: async (name: string) => {
      calls.provisioned.push(name);
      return { userId: `new:${name}` };
    },
  } as unknown as EngineBatchDeps;
}

async function run(body: string, rows: SquadState["rows"], calls: Calls, seen: string[] = []) {
  return runAttendanceEngineBatch({
    orgId: "org-fnf",
    now: new Date("2026-10-24T12:48:30Z"),
    expectedMatchId: null,
    enabled: true,
    history: [],
    messages: [
      {
        waMessageId: "wa-hq",
        body,
        authorName: "Raihan",
        senderUserId: "u-raihan",
        senderName: "Raihan",
        senderIsAdmin: true,
        tagged: true,
        route: "other_att",
        gated: false,
      },
    ],
    deps: deps(rows, calls, extractor(seen)),
  });
}

const NAME_LIST = "AH\nRafi\nShehryar \nRaihan \nHamzah \n\nIN";
const BENCH: SquadState["rows"] = [
  { userId: "u-raihan", status: "CONFIRMED", position: 1 },
  { userId: "u-ah", status: "BENCH", position: 20 },
  { userId: "u-rafi", status: "BENCH", position: 21 },
];

describe("FNF HQ 2026-10-24: the alias AH, in a name list and in 'AH out'", () => {
  it("'AH\\nRafi\\n...\\nIN' brings Abdul-Hafeez off the bench, as the member, never as a new guest", async () => {
    const calls: Calls = { registered: [], cancelled: [], provisioned: [] };
    await run(NAME_LIST, BENCH, calls);
    expect(calls.provisioned).not.toContain("AH");
    expect(calls.registered).toContainEqual({ userId: "u-ah", promote: true });
    expect(calls.registered).toContainEqual({ userId: "u-rafi", promote: true });
  });

  it("'AH out' drops Abdul-Hafeez, and the extractor is told who AH is", async () => {
    const calls: Calls = { registered: [], cancelled: [], provisioned: [] };
    const seen: string[] = [];
    await run("AH out", [{ userId: "u-ah", status: "CONFIRMED", position: 2 }], calls, seen);
    expect(seen[0]).toContain("CLUB MEMBERS NAMED: AH (Abdul-Hafeez)");
    expect(calls.cancelled).toEqual(["u-ah"]);
  });
});
