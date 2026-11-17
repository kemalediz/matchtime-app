/**
 * "WHO IS THAT?" ABOUT A PLACE IN THE SQUAD RIDES THE OPEN-QUESTION
 * MECHANISM (Sutton, 2026-11-17; reworked after the review of #618).
 *
 * The engine asks ("Do you mean Yoobie, or is Abu Ayoub a new player?");
 * these pin the plumbing around that question, which is the stats "who do
 * you mean?" mechanism reused, not a second one:
 *
 *   - the question is recorded as its OWN row (a `SentNotification`, kind
 *     `attendance-ask`) carrying the earlier message, the name asked about
 *     and the members offered, so the asking message keeps its real intent;
 *   - `openAttendanceAsks` reads those rows (asker only, one hour, newest
 *     per asker, closed once answered) in the shape every reader uses;
 *   - the router shows the asker the MATCHTIME ASKED line in its own words;
 *   - the attendance batch shows the extractor the earlier message, binds
 *     the answer to the asked name, closes the question, and a re-ask from
 *     an answer keeps the ORIGINAL message and name.
 *
 * No model is called: every model here is a stub. Made-up people only.
 */
import { describe, expect, it } from "vitest";
import {
  runAttendanceEngineBatch,
  type AttendanceAskRecord,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../attendance-engine-batch";
import {
  ATTENDANCE_ASK_KIND,
  attendanceAskKeyPrefix,
  openAttendanceAsks,
  openStatsClarifications,
  type AttendanceAskRow,
  type StatsClarification,
} from "../pipeline/awaiting-answer";
import { clarificationLine, routeBatch } from "../pipeline/router";
import { parseFacts } from "../pipeline/extractors";
import type { PersonPicker, PersonPick, WhoRequest } from "../pipeline/who-is-who";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { SquadState } from "../pipeline/types";

const NOW = new Date("2026-11-17T13:20:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60 * 1000);
const ORIGINAL = "@Match Time Abu Ayoub is IN as a guest";
const QUESTION = "Do you mean Yoobie, or is Abu Ayoub a new player?";

const askRow = (over: Partial<AttendanceAskRow> = {}, payload: Record<string, unknown> = {}): AttendanceAskRow => ({
  id: "sn-1",
  key: `${attendanceAskKeyPrefix("org-1")}wa-0`,
  targetUser: "u-olly",
  text: JSON.stringify({ v: 1, askerName: "Olly Organiser", body: ORIGINAL, ref: "Abu Ayoub", candidateIds: ["u-yoobie"], answeredAt: null, ...payload }),
  createdAt: ago(5),
  ...over,
});

describe("the open question (its own row)", () => {
  it("is open, about a place, with the earlier message, the name asked and the members offered", () => {
    expect(ATTENDANCE_ASK_KIND).toBe("attendance-ask");
    expect(openAttendanceAsks([askRow()], "org-1", NOW)).toEqual([
      expect.objectContaining({
        about: "attendance",
        askerUserId: "u-olly",
        askerName: "Olly Organiser",
        questionBody: ORIGINAL,
        ref: "Abu Ayoub",
        candidateIds: ["u-yoobie"],
      }),
    ]);
  });
  it("is closed once answered", () => {
    expect(openAttendanceAsks([askRow({}, { answeredAt: ago(1).toISOString() })], "org-1", NOW)).toEqual([]);
  });
  it("expires after the same hour as every open question", () => {
    expect(openAttendanceAsks([askRow({ createdAt: ago(61) })], "org-1", NOW)).toEqual([]);
  });
  it("the newest per asker wins; an answered older one does not reopen", () => {
    const rows = [askRow({ id: "sn-1", createdAt: ago(20) }), askRow({ id: "sn-2", createdAt: ago(2) }, { ref: "Dan" })];
    expect(openAttendanceAsks(rows, "org-1", NOW).map((c) => c.ref)).toEqual(["Dan"]);
  });
  it("another club's row and an unreadable row are nobody's question", () => {
    expect(openAttendanceAsks([askRow({ key: `${attendanceAskKeyPrefix("org-2")}wa-0` })], "org-1", NOW)).toEqual([]);
    expect(openAttendanceAsks([askRow({ text: "not json" })], "org-1", NOW)).toEqual([]);
  });
  it("stats clarifications keep their old shape", () => {
    const open = openStatsClarifications(
      [{ id: "am-1", orgId: "org-1", intent: "stats_clarification", authorUserId: "u-olly", authorName: "Olly Organiser", body: "@Match Time Zork's stats", createdAt: ago(3) }],
      "org-1",
      NOW,
    );
    expect(open[0]).not.toHaveProperty("about");
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
    await routeBatch(routerModel(users), [{ id: "m1", authorName: "Olly Organiser", body: "new" }], {
      clarifications: openAttendanceAsks([askRow()], "org-1", NOW),
    });
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
    { userId: "u-dansmith", name: "Dan Smith", isAdmin: false, hasPhone: true },
    { userId: "u-danjones", name: "Dan Jones", isAdmin: false, hasPhone: true },
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

function deps(model: PipelineModel, identify: PersonPicker) {
  const registered: string[] = [];
  const provisioned: string[] = [];
  const recorded: AttendanceAskRecord[] = [];
  const closed: string[] = [];
  const d: EngineBatchDeps = {
    model,
    identify,
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    recordAttendanceAsk: async (a) => void recorded.push(a),
    closeAttendanceAsk: async (id) => void closed.push(id),
    moveTeamSlot: async () => {},
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
  } as EngineBatchDeps;
  return { d, registered, provisioned, recorded, closed };
}

const claim = (personRef: string, over: Record<string, unknown> = {}) => ({
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
  newPlayer: false,
  ...over,
});
const selfIn = { ...claim(""), subject: "sender", personKind: "named" };
const facts = (claims: unknown[], answersClarification = false) => ({ claims, affirmation: "none", sideRequests: [], answersClarification });

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

const open = () => openAttendanceAsks([askRow()], "org-1", NOW);

describe("the attendance batch", () => {
  it("the ask: the question is the reply, and its own row records what was asked", async () => {
    const x = extractor(facts([claim("Abu Ayoub")]));
    const { d, registered, recorded } = deps(x.model, picker({ "Abu Ayoub": { kind: "ambiguous", userIds: ["u-yoobie"] } }));
    const r = await run(msg(ORIGINAL, { tagged: true }), d);
    expect(registered).toEqual([]);
    expect(r.outcomes.get("wa-1")?.reply).toBe(QUESTION);
    expect(recorded).toEqual([
      { waMessageId: "wa-1", matchId: "match-1", askerUserId: "u-olly", body: ORIGINAL, ref: "Abu Ayoub", candidateIds: ["u-yoobie"] },
    ]);
  });

  it("the sender's own IN landed beside the question: the message's intent stays \"in\", the question is still recorded", async () => {
    const x = extractor(facts([selfIn, claim("Abu Ayoub")]));
    const { d, registered, recorded } = deps(x.model, picker({ "Abu Ayoub": { kind: "ambiguous", userIds: ["u-yoobie"] } }));
    const r = await run(msg("@Match Time I'm in and Abu Ayoub too", { tagged: true }), d);
    expect(registered).toEqual(["u-olly"]);
    expect(r.outcomes.get("wa-1")?.intent).toBe("in");
    expect(recorded).toHaveLength(1);
  });

  it('"new" from the asker: shown the earlier message, Abu Ayoub provisioned and confirmed, the question closed', async () => {
    const x = extractor(facts([claim("Abu Ayoub", { newPlayer: true })], true));
    const { d, registered, provisioned, recorded, closed } = deps(
      x.model,
      picker({ "Abu Ayoub": { kind: "ambiguous", userIds: ["u-yoobie"] } }),
    );
    const r = await run(msg("new"), d, open());
    expect(x.users[0]).toContain(`MATCHTIME ASKED them who someone in their earlier message is: "${ORIGINAL}"`);
    expect(provisioned).toEqual(["Abu Ayoub"]);
    expect(registered).toEqual(["u-new-Abu Ayoub"]);
    expect(closed).toEqual(["sn-1"]);
    expect(recorded).toEqual([]);
    expect(r.outcomes.get("wa-1")?.intent).toBe("in");
  });

  it('"Yoobie" from the asker: Yoobie confirmed', async () => {
    const x = extractor(facts([claim("Yoobie")], true));
    const { d, registered, provisioned } = deps(x.model, picker({ Yoobie: { kind: "member", userId: "u-yoobie" } }));
    await run(msg("Yoobie"), d, open());
    expect(provisioned).toEqual([]);
    expect(registered).toEqual(["u-yoobie"]);
  });

  it("an answer that is itself unclear asks again, about the ORIGINAL message and name", async () => {
    const x = extractor(facts([claim("Dan")], true));
    const { d, registered, recorded, closed } = deps(
      x.model,
      picker({ Dan: { kind: "ambiguous", userIds: ["u-dansmith", "u-danjones"] } }),
    );
    const r = await run(msg("Dan"), d, open());
    expect(registered).toEqual([]);
    expect(r.outcomes.get("wa-1")?.reply).toBe("Do you mean Dan Smith or Dan Jones, or is Dan someone new?");
    expect(closed).toEqual(["sn-1"]);
    expect(recorded).toEqual([
      { waMessageId: "wa-1", matchId: "match-1", askerUserId: "u-olly", body: ORIGINAL, ref: "Abu Ayoub", candidateIds: ["u-dansmith", "u-danjones"] },
    ]);
  });

  it("a question that could not be composed opens nothing", async () => {
    const x = extractor(facts([claim("Abu 07700900123")]));
    const { d, recorded } = deps(x.model, picker({ "Abu 07700900123": { kind: "ambiguous", userIds: ["u-yoobie"] } }));
    const r = await run(msg("@Match Time Abu 07700900123 is in", { tagged: true }), d);
    expect(recorded).toEqual([]);
    expect(r.outcomes.get("wa-1")?.reply ?? null).toBeNull();
  });

  it('somebody else saying "new" is not an answer: not shown the line, newPlayer ignored', async () => {
    const x = extractor(facts([claim("Abu Ayoub", { newPlayer: true })], true));
    const { d, registered, provisioned, closed } = deps(x.model, picker({ "Abu Ayoub": { kind: "ambiguous", userIds: ["u-yoobie"] } }));
    await run(msg("new", { authorName: "Pete Player", senderUserId: "u-pete", senderName: "Pete Player", senderIsAdmin: false }), d, open());
    expect(x.users[0]).not.toContain("MATCHTIME ASKED");
    expect(provisioned).toEqual([]);
    expect(registered).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("a stats question open for the sender is not shown to the attendance extractor", async () => {
    const stats = openStatsClarifications(
      [{ id: "am-1", orgId: "org-1", intent: "stats_clarification", authorUserId: "u-olly", authorName: "Olly Organiser", body: "@Match Time Zork's stats", createdAt: ago(3) }],
      "org-1",
      NOW,
    );
    const x = extractor(facts([]));
    const { d } = deps(x.model, picker({}));
    await run(msg("Idris"), d, stats);
    expect(x.users[0]).not.toContain("MATCHTIME ASKED");
  });
});
