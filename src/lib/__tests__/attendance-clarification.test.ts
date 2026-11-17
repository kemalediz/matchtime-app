/**
 * "WHO IS THAT?" ABOUT A PLACE IN THE SQUAD RIDES THE OPEN-QUESTION
 * MECHANISM (Sutton, 2026-11-17).
 *
 * The engine asks ("Do you mean Yoobie, or is Abu Ayoub a new player?");
 * these pin the plumbing around that question, which is the stats "who do
 * you mean?" mechanism reused, not a second one:
 *
 *   - the asking message is recorded with the `attendance_clarification`
 *     intent (the row that opens it) and the answer with
 *     `attendance_clarified` (the row that closes it);
 *   - `openStatsClarifications` reads both kinds, apart, and marks the new
 *     one `about: "attendance"` (stats rows keep their old shape);
 *   - the router shows the asker the MATCHTIME ASKED line in its own words;
 *   - the attendance batch shows the extractor the earlier message, and an
 *     answer counts only when the question was open for that sender.
 *
 * No model is called: every model here is a stub. Made-up people only.
 */
import { describe, expect, it } from "vitest";
import {
  runAttendanceEngineBatch,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../attendance-engine-batch";
import {
  ATTENDANCE_CLARIFICATION_INTENT,
  ATTENDANCE_CLARIFIED_INTENT,
  openStatsClarifications,
  type StatsClarification,
  type StatsClarificationRow,
} from "../pipeline/awaiting-answer";
import { clarificationLine, routeBatch } from "../pipeline/router";
import { parseFacts } from "../pipeline/extractors";
import type { PersonPicker, PersonPick, WhoRequest } from "../pipeline/who-is-who";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { SquadState } from "../pipeline/types";

const NOW = new Date("2026-11-17T13:20:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60 * 1000);
const ORIGINAL = "@Match Time Abu Ayoub is IN as a guest";

const row = (over: Partial<StatsClarificationRow>): StatsClarificationRow => ({
  id: "am-1",
  orgId: "org-1",
  intent: ATTENDANCE_CLARIFICATION_INTENT,
  authorUserId: "u-olly",
  authorName: "Olly Organiser",
  body: ORIGINAL,
  createdAt: ago(5),
  ...over,
});

describe("the open question", () => {
  it("an attendance question is open, about a place, with the earlier message as its body", () => {
    const open = openStatsClarifications([row({})], "org-1", NOW);
    expect(open).toEqual([
      expect.objectContaining({ about: "attendance", askerUserId: "u-olly", questionBody: ORIGINAL }),
    ]);
  });
  it("its answer closes it", () => {
    const rows = [row({}), row({ id: "am-2", intent: ATTENDANCE_CLARIFIED_INTENT, body: "new", createdAt: ago(1) })];
    expect(openStatsClarifications(rows, "org-1", NOW)).toEqual([]);
  });
  it("a stats answer does not close an attendance question, nor the other way round", () => {
    const rows = [
      row({}),
      row({ id: "am-2", intent: "stats_clarification", body: "@Match Time Zork's stats", createdAt: ago(4) }),
      row({ id: "am-3", intent: "stats_clarified", body: "Idris", createdAt: ago(3) }),
    ];
    expect(openStatsClarifications(rows, "org-1", NOW).map((c) => c.about ?? "stats")).toEqual(["attendance"]);
  });
  it("a stats question keeps its old shape (no `about`)", () => {
    const open = openStatsClarifications([row({ intent: "stats_clarification" })], "org-1", NOW);
    expect(open[0]).not.toHaveProperty("about");
  });
  it("expires after the same hour", () => {
    expect(openStatsClarifications([row({ createdAt: ago(61) })], "org-1", NOW)).toEqual([]);
  });
});

function routerModel(users: string[]): PipelineModel {
  return {
    name: "fake",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      users.push(req.user);
      const ids = [...req.user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({ routes: ids.map((id) => ({ id, route: "other_att" })) }),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

describe("the router", () => {
  it("shows the asker the line about the earlier MESSAGE, not a stats question", async () => {
    const users: string[] = [];
    const open = openStatsClarifications([row({})], "org-1", NOW);
    await routeBatch(routerModel(users), [{ id: "m1", authorName: "Olly Organiser", body: "new" }], { clarifications: open });
    expect(users[0]).toContain(
      `MATCHTIME ASKED this sender who someone in their earlier message is: "${ORIGINAL}"\n[m1] Olly Organiser: new`,
    );
  });
  it("the stats line is unchanged", () => {
    expect(clarificationLine("q")).toBe(`MATCHTIME ASKED this sender whom they meant in their earlier question: "q"`);
  });
});

describe("the extractor's answer, parsed", () => {
  const rawClaim = {
    subject: "other",
    personRef: "Abu Ayoub",
    personKind: "named",
    benchAsked: false,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    reported: false,
    replaces: "",
    confidence: 0.9,
    newPlayer: true,
  };
  it("an answer keeps answersClarification and newPlayer", () => {
    const { facts } = parseFacts("attendance", JSON.stringify({ claims: [rawClaim], affirmation: "none", sideRequests: [], answersClarification: true }), "m1");
    expect(facts).toMatchObject({ kind: "attendance", answersClarification: true, claims: [{ personRef: "Abu Ayoub", newPlayer: true }] });
  });
  it("newPlayer without answersClarification is drift, dropped", () => {
    const { facts } = parseFacts("attendance", JSON.stringify({ claims: [rawClaim], affirmation: "none", sideRequests: [], answersClarification: false }), "m1");
    expect(facts).not.toHaveProperty("answersClarification");
    expect(facts.kind === "attendance" && facts.claims[0]).not.toHaveProperty("newPlayer");
  });
});

// ── the batch ────────────────────────────────────────────────────────

const state = (): SquadState => ({
  matchId: "match-1",
  maxPlayers: 14,
  kickoffLabel: "Tue 21:30",
  venue: "The Pitch",
  rows: [],
  roster: [
    { userId: "u-olly", name: "Olly Organiser", isAdmin: true, hasPhone: true },
    { userId: "u-yoobie", name: "Yoobie", isAdmin: false, hasPhone: true },
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
});

const msg = (body: string, over: Partial<EngineBatchMessage> = {}): EngineBatchMessage => ({
  waMessageId: "wa-1",
  body,
  authorName: "Olly Organiser",
  senderUserId: "u-olly",
  senderName: "Olly Organiser",
  senderIsAdmin: true,
  tagged: false,
  route: "other_att",
  gated: false,
  ...over,
});

/** The extractor stub: what it was shown, and the facts it returns. */
function extractor(facts: Record<string, unknown>) {
  const users: string[] = [];
  const model: PipelineModel = {
    name: "fake",
    async complete(req) {
      users.push(req.user);
      return {
        text: JSON.stringify(facts),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
  return { users, model };
}

const picker = (picks: Record<string, PersonPick>): PersonPicker & { asked: string[] } => {
  const asked: string[] = [];
  const p = (async (req: WhoRequest) => {
    const out = new Map<string, Map<string, PersonPick>>();
    for (const m of req.messages) {
      for (const ref of m.refs) {
        asked.push(ref);
        if (!out.has(m.id)) out.set(m.id, new Map());
        out.get(m.id)!.set(ref, picks[ref] ?? { kind: "none" });
      }
    }
    return { picks: out, usage: null, degradations: [] };
  }) as unknown as PersonPicker & { asked: string[] };
  p.asked = asked;
  return p;
};

function deps(model: PipelineModel, identify: PersonPicker, over: Partial<EngineBatchDeps> = {}) {
  const registered: string[] = [];
  const provisioned: string[] = [];
  const d: EngineBatchDeps = {
    model,
    identify,
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    async registerAttendance(userId) {
      registered.push(userId);
      return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 14 };
    },
    async cancelAttendance() {
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name) {
      provisioned.push(name);
      return { userId: `u-new-${name}` };
    },
    ...over,
  } as EngineBatchDeps;
  return { d, registered, provisioned };
}

const claim = (personRef: string, newPlayer = false) => ({
  subject: "other",
  personRef,
  personKind: "named",
  benchAsked: false,
  polarity: "in",
  contingent: false,
  conditionOn: "none",
  tense: "present",
  reported: false,
  replaces: "",
  confidence: 0.9,
  newPlayer,
});

const run = (m: EngineBatchMessage, d: EngineBatchDeps, clarifications?: StatsClarification[]) =>
  runAttendanceEngineBatch({
    orgId: "org-1",
    now: NOW,
    messages: [m],
    history: [],
    expectedMatchId: "match-1",
    enabled: true,
    deps: d,
    ...(clarifications ? { clarifications } : {}),
  });

describe("the attendance batch", () => {
  it("the ask: a reply with the question, recorded as the row that opens it", async () => {
    const x = extractor({ claims: [claim("Abu Ayoub")], affirmation: "none", sideRequests: [], answersClarification: false });
    const { d, registered } = deps(x.model, picker({ "Abu Ayoub": { kind: "ambiguous", userIds: ["u-yoobie"] } }));
    const r = await run(msg(ORIGINAL, { tagged: true }), d);
    expect(registered).toEqual([]);
    expect(r.outcomes.get("wa-1")).toMatchObject({
      intent: ATTENDANCE_CLARIFICATION_INTENT,
      reply: "Do you mean Yoobie, or is Abu Ayoub a new player?",
    });
  });

  it('"new" from the asker: shown the earlier message, Abu Ayoub provisioned and confirmed, the question closed', async () => {
    const open = openStatsClarifications([row({})], "org-1", NOW);
    const x = extractor({ claims: [claim("Abu Ayoub", true)], affirmation: "none", sideRequests: [], answersClarification: true });
    const who = picker({});
    const { d, registered, provisioned } = deps(x.model, who);
    const r = await run(msg("new"), d, open);
    expect(x.users[0]).toContain(`MATCHTIME ASKED them who someone in their earlier message is: "${ORIGINAL}"`);
    // A person said to be new is not looked up again.
    expect(who.asked).toEqual([]);
    expect(provisioned).toEqual(["Abu Ayoub"]);
    expect(registered).toEqual(["u-new-Abu Ayoub"]);
    expect(r.outcomes.get("wa-1")?.intent).toBe(ATTENDANCE_CLARIFIED_INTENT);
  });

  it('"Yoobie" from the asker: Yoobie confirmed', async () => {
    const open = openStatsClarifications([row({})], "org-1", NOW);
    const x = extractor({ claims: [claim("Yoobie")], affirmation: "none", sideRequests: [], answersClarification: true });
    const { d, registered, provisioned } = deps(x.model, picker({ Yoobie: { kind: "member", userId: "u-yoobie" } }));
    const r = await run(msg("Yoobie"), d, open);
    expect(provisioned).toEqual([]);
    expect(registered).toEqual(["u-yoobie"]);
    expect(r.outcomes.get("wa-1")?.intent).toBe(ATTENDANCE_CLARIFIED_INTENT);
  });

  it("somebody else saying \"new\" is not an answer: not shown the line, newPlayer ignored", async () => {
    const open = openStatsClarifications([row({})], "org-1", NOW);
    const x = extractor({ claims: [claim("Abu Ayoub", true)], affirmation: "none", sideRequests: [], answersClarification: true });
    const { d, registered, provisioned } = deps(
      x.model,
      picker({ "Abu Ayoub": { kind: "ambiguous", userIds: ["u-yoobie"] } }),
    );
    const r = await run(
      msg("new", { authorName: "Pete Player", senderUserId: "u-pete", senderName: "Pete Player", senderIsAdmin: false }),
      d,
      open,
    );
    expect(x.users[0]).not.toContain("MATCHTIME ASKED");
    expect(provisioned).toEqual([]);
    expect(registered).toEqual([]);
    expect(r.outcomes.get("wa-1")?.intent).not.toBe(ATTENDANCE_CLARIFIED_INTENT);
  });

  it("a stats question open for the sender is not shown to the attendance extractor", async () => {
    const open = openStatsClarifications([row({ intent: "stats_clarification", body: "@Match Time Zork's stats" })], "org-1", NOW);
    const x = extractor({ claims: [], affirmation: "none", sideRequests: [], answersClarification: false });
    const { d } = deps(x.model, picker({}));
    await run(msg("Idris"), d, open);
    expect(x.users[0]).not.toContain("MATCHTIME ASKED");
  });
});
