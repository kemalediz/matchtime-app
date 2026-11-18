/**
 * §10 STEP 7 — `question` and `balancer`, decided by the engine.
 *
 * Every test here is an OWNERSHIP test before it is a behaviour test,
 * because ownership is where this step can hurt somebody. Step 6's
 * header states the rule this file inherits: every failure mode must
 * land on "the analyzer decides this message", which is today's
 * behaviour and therefore cannot be a regression.
 *
 * The three properties that matter most, in order:
 *
 *   1. NOTHING IS OWNED BY DEFAULT. Flags off → not one model call.
 *   2. A SHAPE THIS PATH CANNOT ANSWER WELL IS HANDED BACK, not
 *      answered badly and not answered with silence. Two of the eight
 *      question topics are handed back for a MEASURED reason, pinned by
 *      the last two tests in this file.
 *   3. THIS PATH NEVER WRITES. `zero-writes.test.ts` proves the module
 *      contains no mutation; `refuses to own anything when the engine
 *      proposes a write` proves it would refuse even if one appeared.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  composeSquadStatusPost,
  displaysSquadState,
  formatTeamsPost,
} from "../../group-copy";
import { compose } from "../compose";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import {
  ANSWER_ROUTES,
  runAnswerBatch,
  type AnswerBatchMessage,
  type AnswerBatchDeps,
} from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { PaymentSnapshot, Route, SpeechIntent, SquadState } from "../types";
import { NOW, fullName, world, type WorldOpts } from "./helpers";
import { newSilenceFacts, type SilenceFacts } from "../../tagged-silence";

// ── Fixtures ───────────────────────────────────────────────────────────

const ELEVEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "amir"];

const FEATURES_ON: OrgFeatures = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: true,
  paymentCollection: false,
  squadFromList: false,
} as OrgFeatures;

/** What the stubbed unified answer says when a test gives it nothing. */
const UNIFIED_LINE = "There's no squad list to show right now.";

/** A model that answers from a table keyed on `extractor:<kind>` plus
 *  the message body, and COUNTS its calls — "the flags are off so
 *  nothing was spent" is only true if nobody called it. */
function stubModel(table: Record<string, unknown>, opts: { throwOn?: string } = {}) {
  const calls: string[] = [];
  const model: PipelineModel = {
    name: "test-stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const body = req.user.split("\n").slice(-1)[0];
      calls.push(`${req.label}|${body}`);
      if (opts.throwOn && body.includes(opts.throwOn)) throw new Error("529 Overloaded");
      // The unified answer's turn ends with the same message: its reply is
      // keyed "answer:<body>", or a fixed line.
      const payload = req.label === "unified-answer" ? (table[`answer:${body}`] ?? { answer: UNIFIED_LINE }) : table[body];
      if (payload === undefined) throw new Error(`no stub for "${body}"`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0021,
        ms: 700,
      };
    },
  };
  return { model, calls };
}

function msg(o: Partial<AnswerBatchMessage> & { body: string; route: Route }): AnswerBatchMessage {
  return {
    waMessageId: o.waMessageId ?? `wa-${o.body.slice(0, 12)}`,
    body: o.body,
    authorName: o.authorName ?? fullName("kemal"),
    senderUserId: o.senderUserId === undefined ? "u-kemal" : o.senderUserId,
    senderName: o.senderName ?? fullName("kemal"),
    tagged: o.tagged ?? true,
    route: o.route,
    gated: o.gated ?? false,
  };
}

function deps(
  model: PipelineModel,
  state: SquadState,
  features: Partial<OrgFeatures> = {},
  loadPayments?: AnswerBatchDeps["loadPayments"],
  loadRatingProgress?: AnswerBatchDeps["loadRatingProgress"],
): AnswerBatchDeps {
  return {
    model,
    loadState: async () => state,
    loadFeatures: async () => ({ ...FEATURES_ON, ...features }),
    loadPayments,
    loadRatingProgress,
    // An open question (topic `other`, 2026-11-10) reads the club's setup.
    loadClub: async () => ({ collectorName: null, feePerPlayer: null, feeSplitTotal: false, teamsReady: "off" }),
    // Every stats question reads the club's tables since 2026-09-23 (the
    // appearances answer moved onto them). A small, fixed record.
    loadStats: async () => ({
      fullTableUrl: "https://matchtime.ai/profile/stats",
      ratings: [],
      mom: [],
      elo: [],
      teamOfSeason: null,
      mrReliable: [],
      aliases: [],
      appearances: [{ userId: "u-kemal", name: fullName("kemal"), matches: 24 }],
      recordsStart: { matches: new Date("2026-04-14T20:00:00.000Z"), mom: null },
    }),
  };
}

async function run(args: {
  messages: AnswerBatchMessage[];
  model: PipelineModel;
  enabled?: Route[];
  worldOpts?: WorldOpts;
  features?: Partial<OrgFeatures>;
  state?: SquadState;
  expectedMatchId?: string | null;
  loadPayments?: AnswerBatchDeps["loadPayments"];
  loadRatingProgress?: AnswerBatchDeps["loadRatingProgress"];
  silence?: SilenceFacts;
}) {
  const state = args.state ?? world(args.worldOpts ?? { confirmed: ELEVEN });
  return runAnswerBatch({
    ...(args.silence ? { silence: args.silence } : {}),
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    expectedMatchId: args.expectedMatchId === undefined ? state.matchId : args.expectedMatchId,
    enabled: new Set<Route>(args.enabled ?? ["question", "balancer"]),
    deps: deps(args.model, state, args.features, args.loadPayments, args.loadRatingProgress),
  });
}

// The squad list post: a question code answers itself from the database,
// so a test of ownership needs no answer model (2026-11-18: the counted
// answer it used to be was deleted with the other question categories).
const COUNT_Q = "@Match Time what's the list?";
const COUNT_FACTS = { kind: "list", personRef: "", feature: "none", badge: "none" };
const SHOW_TEAMS = "@Match Time show the teams again";
const SHOW_FACTS = { action: "show", includeRefs: [], teamNames: [], swaps: [] };

// ── 1. Nothing by default ──────────────────────────────────────────────

describe("step 7 owns nothing unless a flag says so", () => {
  it("makes no model call at all with both flags off", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      enabled: [],
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.outcomes.size).toBe(0);
    expect(calls).toEqual([]);
    expect(res.cost).toEqual({ usd: 0, calls: 0, ms: 0 });
  });

  it("a flag on for one route does not own the other", async () => {
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ body: COUNT_Q, route: "question" }),
        msg({ body: SHOW_TEAMS, route: "balancer" }),
      ],
      model,
      enabled: ["question"],
      worldOpts: { confirmed: ELEVEN, teams: { kemal: "RED", elvin: "YELLOW" } },
    });
    expect([...res.ownedIds]).toEqual([`wa-${COUNT_Q.slice(0, 12)}`]);
    expect(calls.every((c) => c.startsWith("extractor:question"))).toBe(true);
  });

  it("lists only the routes it can own", () => {
    expect([...ANSWER_ROUTES]).toEqual(["question", "balancer"]);
  });
});

// ── 2. The carve-outs that keep the analyzer in charge ────────────────

describe("shapes that stay with the analyzer", () => {
  it("an untagged message — the interaction contract is not reimplemented here", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: "how many are we?", route: "question", tagged: false })],
      model,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a message step 5's gate already skipped", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question", gated: true })],
      model,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each<[string, Route | undefined]>([
    ["a route this step does not own", "self_att"],
    ["banter", "none"],
    ["doubt", "unsure"],
    ["an id the router never mentioned", undefined],
  ])("%s", async (_label, route) => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: route as Route })],
      model,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("owns nothing when the state load throws", async () => {
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [msg({ body: COUNT_Q, route: "question" })],
      history: [],
      expectedMatchId: "match-1",
      enabled: new Set<Route>(["question"]),
      deps: {
        model,
        loadState: async () => {
          throw new Error("db down");
        },
        loadFeatures: async () => FEATURES_ON,
      },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/state load/i);
  });

  it("no active registration match: the list asked for is the unified answer, never a squad post", async () => {
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      worldOpts: { noMatch: true },
      expectedMatchId: null,
    });
    // Since UNIFIED_ANSWERS (live 2026-11-11, the only path 2026-11-18):
    // the list asked for with no list to post is answered by the unified
    // answer, told there is no squad, never posted from a squad nobody
    // vouched for.
    expect(res.outcomes.get(`wa-${COUNT_Q.slice(0, 12)}`)?.reply).toBe(UNIFIED_LINE);
    expect(calls.map((c) => c.split("|")[0])).toEqual(["extractor:question", "unified-answer"]);
  });

  it("the route and the engine disagree about the match: the unified answer, never a squad post", async () => {
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      expectedMatchId: "some-other-match",
    });
    // Since UNIFIED_ANSWERS (live 2026-11-11, the only path 2026-11-18):
    // the list asked for with no list to post is answered by the unified
    // answer, told there is no squad, never posted from a squad nobody
    // vouched for.
    expect(res.outcomes.get(`wa-${COUNT_Q.slice(0, 12)}`)?.reply).toBe(UNIFIED_LINE);
    expect(calls.map((c) => c.split("|")[0])).toEqual(["extractor:question", "unified-answer"]);
    expect(res.degradations.join(" ")).toMatch(/disagree/i);
  });

  it("an org that does not track attendance (the MoM-only shape): the unified answer, never a squad post", async () => {
    // ATTENDANCE_OFF_OVERRIDE (`message-analyzer.ts:923`) makes the
    // mega-prompt stay SILENT on every squad question for these orgs.
    // A composer that answered "0/0" would be the 2026-06-08 Sutton Lads
    // incident ("MT told them 0/14 — need 14 players") reintroduced by a
    // path that never read the override.
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, features: { attendance: false } },
    });
    // Since UNIFIED_ANSWERS (live 2026-11-11, the only path 2026-11-18):
    // the list asked for with no list to post is answered by the unified
    // answer, told there is no squad, never posted from a squad nobody
    // vouched for.
    expect(res.outcomes.get(`wa-${COUNT_Q.slice(0, 12)}`)?.reply).toBe(UNIFIED_LINE);
    expect(calls.map((c) => c.split("|")[0])).toEqual(["extractor:question", "unified-answer"]);
  });

  it("a match with no capacity to divide by: the unified answer, never a squad post", async () => {
    // "We're 11/0, need 0 more" is the 2026-06-08 "0/14" shape reached
    // from the other direction. It should be impossible; the answer to
    // an impossible state is the path that already handles it.
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, maxPlayers: 0 },
    });
    // Since UNIFIED_ANSWERS (live 2026-11-11, the only path 2026-11-18):
    // the list asked for with no list to post is answered by the unified
    // answer, told there is no squad, never posted from a squad nobody
    // vouched for.
    expect(res.outcomes.get(`wa-${COUNT_Q.slice(0, 12)}`)?.reply).toBe(UNIFIED_LINE);
    expect(calls.map((c) => c.split("|")[0])).toEqual(["extractor:question", "unified-answer"]);
    expect(res.degradations.join(" ")).toMatch(/maxPlayers=0/);
  });

  it("a blocked window with no question makes no model call at all", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      worldOpts: { noMatch: true },
      expectedMatchId: null,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
    expect(res.degradations).toEqual([]);
  });

  it("does not own a team post when team balancing is off for the org", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      worldOpts: { confirmed: ELEVEN, teams: { kemal: "RED", elvin: "YELLOW" } },
      features: { teamBalancing: false },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ── 3. Per-shape refusals, decided AFTER extraction ───────────────────

describe("a shape the composer cannot answer well is answered by nobody", () => {
  it("answers `who's playing?` with the ROSTER, not with a count", async () => {
    // This was a hand-back until 2026-09-06, because `engine.ts` sent
    // topic `squad` to the same `answer_count` speech intent as topic
    // `count` — "We're 11/14, need 3 more" to somebody who asked for
    // names. It read correctly in production only because
    // `route.ts:2393` swapped the string for the roster post, and
    // relying on a regex in another module to turn a count into a roster
    // is the opposite of §6.4. `answer_squad` renders
    // `composeSquadStatusPost` directly instead.
    const body = "@Match Time who's playing?";
    const { model } = stubModel({
      [body]: { kind: "list", personRef: "", feature: "none", badge: "none" },
    });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toHaveLength(1);
    const reply = [...res.outcomes.values()][0].reply!;
    expect(reply).toBe(
      composeSquadStatusPost({ confirmed: ELEVEN.map(fullName), bench: [], maxPlayers: 14 }),
    );
    expect(reply).toContain(fullName("kemal"));
  });

  it.each([
    ["list", COUNT_Q, COUNT_FACTS],
    ["list", "@Match Time who's playing?", { kind: "list", personRef: "", feature: "none", badge: "none" }],
  ])(
    "STILL ANSWERS a %s question when the rest of the batch is attendance (2026-09-09)",
    async (_topic, body, facts) => {
      // WAS: "hands back a count question when the batch may also change
      // the squad", on two premises. One is dead and one is now
      // satisfied:
      //
      //   • "an answer here is composed from a PRE-WRITE snapshot" —
      //     FALSE for attendance traffic. `route.ts` awaits
      //     `runAttendanceEngineBatch` (:1360), writes and all, BEFORE it
      //     calls `runAnswerBatch` (:1512), and this module does its own
      //     `loadSquadState`. The snapshot is post-write.
      //   • "two batch runners each calling `decide()` cannot enforce
      //     S36 between them" — they no longer have to. The attendance
      //     engine stopped composing an unprompted batch-level roster
      //     post (`engine.ts`'s speech assembly, 2026-09-09), so there is
      //     nothing here to collide with.
      //
      // And it MUST answer, because the roster post used to answer this
      // question by accident. Take the post away and leave the hand-back
      // in place and a tagged "how many are we?" beside somebody's "in"
      // gets silence — §9's signature failure.
      const { model } = stubModel({ [body as string]: facts });
      const res = await run({
        messages: [
          msg({ body: body as string, route: "question" }),
          msg({ body: "I'm in", route: "self_att", waMessageId: "wa-in" }),
        ],
        model,
      });
      expect([...res.ownedIds]).toHaveLength(1);
      const reply = [...res.outcomes.values()][0].reply!;
      expect(displaysSquadState(reply)).toBe(true);
    },
  );

  it("hands a count question back when the batch carries a route that writes LATER", async () => {
    // The carve-out above is not "attendance is fine, so everything is".
    // It is sequencing: the attendance owner has already written by the
    // time this module loads its state. `score` and `admin_ops` run
    // AFTER it (`route.ts:1528`, `:1540`), so their traffic keeps the
    // original hand-back.
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ body: COUNT_Q, route: "question" }),
        msg({ body: "we won 5-3", route: "score", waMessageId: "wa-score" }),
      ],
      model,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/does not own|S36|snapshot/i);
    // The topic is only knowable after extraction, so this carve-out
    // costs one extractor call (~$0.002) on a batch that also carried
    // something else. §11.1's asymmetry, priced: a false positive costs
    // one small call; the alternative costs the group a contradiction.
    expect(calls).toHaveLength(1);
  });

  it("counts a banter or unrouted message as `anything else` too", async () => {
    // With the gate OFF a `none`-routed message still reaches the
    // analyzer and can still produce a write, and an id the router never
    // mentioned is a coverage hole rather than a decision. Both count.
    for (const route of ["none", undefined] as Array<Route | undefined>) {
      const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
      const res = await run({
        messages: [
          msg({ body: COUNT_Q, route: "question" }),
          msg({ body: "haha", route: route as Route, waMessageId: "wa-other" }),
        ],
        model,
      });
      expect([...res.ownedIds], String(route)).toEqual([]);
    }
  });

  it("owns a question when the rest of the batch is gated banter", async () => {
    // …which is what step 5's gate is for, and why step 7 is designed to
    // run behind it.
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ body: COUNT_Q, route: "question" }),
        msg({ body: "haha", route: "none", waMessageId: "wa-banter", gated: true }),
      ],
      model,
    });
    expect([...res.ownedIds]).toHaveLength(1);
  });

  it.each([
    // §10 step 8 gave `generate` an owner of its own on this same route
    // — `team-ops-engine-batch.ts`, selected by this same FACT. What
    // does NOT change is that this module owns none of the three: it is
    // a read path with no apply layer, and the degradation now names
    // where each one actually goes.
    ["generate", /team-ops-engine-batch\.ts owns it/],
    ["rename", /no module owns it/],
    ["swap", /no module owns it/],
  ] as const)(
    "hands a `%s` team request on — only showing is a read",
    async (action, expected) => {
      const body = "@Match Time do the teams";
      const { model } = stubModel({
        [body]: { action, includeRefs: [], teamNames: [], swaps: [], pairings: [] },
      });
      const res = await run({
        messages: [msg({ body, route: "balancer" })],
        model,
        worldOpts: { confirmed: ELEVEN, teams: { kemal: "RED", elvin: "YELLOW" } },
      });
      expect([...res.ownedIds]).toEqual([]);
      expect(res.degradations.join(" ")).toMatch(expected);
    },
  );

  it("answers `show the teams` with the shipped sentence when none exist yet", async () => {
    // Until 2026-09-06 this was a hand-back, because `formatTeamsPost`
    // over two empty lists renders a team sheet with nobody on it — the
    // live sweep produced exactly that: "⚽ *Teams for tonight* … *Red*:
    // \n\n\n*Yellow*:\n\n\n". The fix is in the ENGINE, which now emits
    // `teams_not_generated`, so the wrong post cannot be composed on any
    // path rather than being refused on this one.
    //
    // The words and the reaction are the shipped path's, verbatim
    // (`route.ts:3711-3714` / `3730-3734`): 🤔 for "there is nothing to
    // show", 👀 for a real post.
    const { model } = stubModel({ [SHOW_TEAMS]: SHOW_FACTS });
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      worldOpts: { confirmed: ELEVEN },
    });
    expect([...res.ownedIds]).toHaveLength(1);
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe(
      "No teams generated yet. Tag me and ask for them in your own words (for example @Match Time generate the teams) and I'll sort them.",
    );
    expect(out.react).toBe("\u{1F914}");
    expect(out.intent).toBe("show_teams_request");
    expect(res.writes).toEqual([]);
  });

  it("disowns a message when its extraction FAILED, and says where it went", async () => {
    // Step 6's measured lesson: 27 `529 Overloaded` in one live sweep
    // took two corpus cases from 3/3 to 0/3 — not because the engine
    // decided them wrongly but because it never got to decide them.
    //
    // This used to assert /analyzer/i, because a failed extraction was
    // handed back to the mega-prompt. §10 step 8 deleted it, so the
    // message now goes SILENT and the degradation is the only signal
    // left — it is what `lib/operator-note.ts` prints beside the lost
    // message on the admin DM. Asserting the sentence is asserting that
    // the operator is told the truth.
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS }, { throwOn: COUNT_Q });
    const res = await run({ messages: [msg({ body: COUNT_Q, route: "question" })], model });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.outcomes.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/529|failed/i);
    expect(res.degradations.join(" ")).toMatch(/nobody answers this message/i);
    expect(res.degradations.join(" ")).not.toMatch(/analyzer/i);
  });

  it("owns the messages it can when only ONE of several extractions failed", async () => {
    const bench = "@Match Time who's on the bench?";
    const { model } = stubModel(
      {
        [COUNT_Q]: COUNT_FACTS,
        [bench]: { topic: "bench", personRef: "", statedCount: -1 },
      },
      { throwOn: COUNT_Q },
    );
    const res = await run({
      messages: [
        msg({ body: COUNT_Q, route: "question" }),
        msg({ body: bench, route: "question", waMessageId: "wa-bench" }),
      ],
      model,
      worldOpts: { confirmed: ELEVEN, bench: ["zair"] },
    });
    expect([...res.ownedIds]).toEqual(["wa-bench"]);
  });
});

// ── 4. What it says, composed from the database ──────────────────────

describe("the answers are composed from state, never authored", () => {
  it("re-posts the EXISTING teams and proposes no write (§3.2 S19)", async () => {
    const { model } = stubModel({ [SHOW_TEAMS]: SHOW_FACTS });
    const state = world({
      confirmed: ELEVEN,
      teams: { kemal: "RED", elvin: "RED", sait: "YELLOW", mustafa: "YELLOW" },
    });
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      state,
    });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe(
      formatTeamsPost({
        redLabel: "Red",
        yellowLabel: "Yellow",
        red: [{ name: fullName("kemal") }, { name: fullName("elvin") }],
        yellow: [{ name: fullName("sait") }, { name: fullName("mustafa") }],
        kickoff: "Tue 21:30",
        venue: "Goals North Cheam",
      }),
    );
    // A team post reacts 👀, exactly as `route.ts:3746` does today.
    expect(out.react).toBe("\u{1F440}");
    expect(out.action).toBe("react");
    expect(res.writes).toEqual([]);
  });

  it("labels a team post `show_teams_request` so the squad composer skips it", async () => {
    // `route.ts:2357` skips exactly these two intents when composing the
    // squad post over a reply. Without the right label the numbered
    // Red/Yellow lists trip `displaysSquadState` and the teams post is
    // REPLACED by the squad roster. Asserted here because it is a
    // cross-module contract expressed as a string.
    //
    // Two players a side, not one, because that is what makes the point:
    // `displaysSquadState` looks for a numbered RUN of 2+ lines, so a
    // real 5-a-side or 7-a-side post trips it and a toy one-a-side post
    // does not. Every real team post is the tripping shape.
    const { model } = stubModel({ [SHOW_TEAMS]: SHOW_FACTS });
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      worldOpts: {
        confirmed: ELEVEN,
        teams: { kemal: "RED", elvin: "RED", sait: "YELLOW", mustafa: "YELLOW" },
      },
    });
    const out = [...res.outcomes.values()][0];
    expect(out.intent).toBe("show_teams_request");
    expect(displaysSquadState(out.reply!)).toBe(true);
  });

  it("says the same thing once when two people ask the same question", async () => {
    // §3.2 S36/S37. Two identical composed answers in one batch is two
    // messages in the group saying the same number.
    const a = "@Match Time how many are we?";
    const b = "@Match Time whats the count";
    const { model } = stubModel({ [a]: COUNT_FACTS, [b]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ body: a, route: "question", waMessageId: "wa-a" }),
        msg({ body: b, route: "question", waMessageId: "wa-b" }),
      ],
      model,
    });
    expect([...res.ownedIds].sort()).toEqual(["wa-a", "wa-b"]);
    const replies = [...res.outcomes.values()].map((o) => o.reply).filter(Boolean);
    expect(replies).toHaveLength(1);
    // The LAST asker gets the answer, so the reply sits next to the most
    // recent question rather than scrolled away above it.
    expect(res.outcomes.get("wa-b")!.reply).toBeTruthy();
    expect(res.outcomes.get("wa-a")!.reply).toBeNull();
  });

  it("gives every owned message exactly one outcome and no un-owned message any", async () => {
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ body: COUNT_Q, route: "question" }),
        msg({ body: "haha", route: "none", waMessageId: "wa-banter" }),
      ],
      model,
    });
    expect([...res.outcomes.keys()]).toEqual([...res.ownedIds]);
    expect(res.outcomes.has("wa-banter")).toBe(false);
  });
});

// ── 5. This path cannot write, and refuses to if it ever could ───────

describe("zero writes, structurally", () => {
  it("proposes no writes on any owned shape", async () => {
    const body = "@Match Time who's playing?";
    const { model } = stubModel({ [body]: { topic: "squad", personRef: "", statedCount: -1 } });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect(res.writes).toEqual([]);
  });

  it("refuses to own anything when the engine proposes a write", async () => {
    // Unreachable today — `handleQuestion` and `handleTeams` contain no
    // `emit()` — which is exactly why it is asserted rather than
    // assumed. A future engine rule that grew a write would otherwise
    // reach a path with no apply layer, no authorisation and no
    // `AttendanceEvent`, and the write would simply be lost.
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [msg({ body: COUNT_Q, route: "question" })],
      history: [],
      expectedMatchId: "match-1",
      enabled: new Set<Route>(["question"]),
      deps: {
        ...deps(model, world({ confirmed: ELEVEN })),
        decide: (input) => ({
          outcomes: input.messages.map((m) => ({
            messageId: m.id,
            route: m.route,
            disposition: "acted" as const,
            reasons: [],
            writes: [],
            react: null,
          })),
          writes: [
            {
              kind: "attendance" as const,
              userId: "u-kemal",
              name: "Kemal Ediz",
              status: "DROPPED" as const,
              explicitBench: false,
              promote: false,
              sourceMessageId: "wa-@Match Time",
              reason: "a rule that should not exist",
            },
          ],
          nextState: input.state,
          speech: [],
          degradations: [],
        }),
      },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/write/i);
  });

  it("hands back an owned message the composer had nothing to say about", async () => {
    // Ownership is decided before `decide()` runs, so an owned id that
    // produces no speech would return a completely silent outcome —
    // "message understood, action silently not taken", the failure §9
    // calls this product's signature. Unreachable today; the coincidence
    // is fragile (`engine.ts:923-931` drops the deferred question speech
    // whenever a squad change is in the same `decide()` call).
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [msg({ body: COUNT_Q, route: "question" })],
      history: [],
      expectedMatchId: "match-1",
      enabled: new Set<Route>(["question"]),
      deps: {
        ...deps(model, world({ confirmed: ELEVEN })),
        decide: (input) => ({
          outcomes: input.messages.map((m) => ({
            messageId: m.id,
            route: m.route,
            disposition: "acted" as const,
            reasons: ["a rule fired but composed nothing"],
            writes: [],
            react: null,
          })),
          writes: [],
          nextState: input.state,
          speech: [],
          degradations: [],
        }),
      },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.outcomes.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/composed nothing to say/);
  });

  it("owns nothing when the engine throws", async () => {
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [msg({ body: COUNT_Q, route: "question" })],
      history: [],
      expectedMatchId: "match-1",
      enabled: new Set<Route>(["question"]),
      deps: {
        ...deps(model, world({ confirmed: ELEVEN })),
        decide: () => {
          throw new Error("coverage violation");
        },
      },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/coverage violation/);
  });
});

// ── 7. The module must stay loadable where there is no Prisma ────────

describe("nothing that reaches Prisma is imported statically", () => {
  // Measured on 2026-09-05, and it cost a live sweep: a plain
  // `import { getOrgFeatures } from "../org-features"` pulls in
  // `src/lib/db.ts` → the generated client, and the corpus spec that
  // imports this module died at LOAD with "exports is not defined in ES
  // module scope". Playwright then reported "No tests found" — a broken
  // measurement that reads like an empty one. `compose.ts` carries the
  // same rule in its header; this asserts it instead of stating it.
  const PRISMA_BACKED = ["../db", "./load-state", "../org-features"];
  const SRC = fs.readFileSync(path.resolve(__dirname, "..", "answer-batch.ts"), "utf8");

  it.each(PRISMA_BACKED)("does not statically import %s", (mod) => {
    const offenders = SRC.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      // `import type` is erased at compile time and pulls in nothing.
      .filter((l) => /^\s*import\s+(?!type\b)/.test(l))
      .filter((l) => l.includes(`"${mod}"`));
    expect(
      offenders,
      `${mod} reaches the Prisma client. Import it with \`await import\` inside the ` +
        `function instead, so the module stays loadable in the Playwright worker.`,
    ).toEqual([]);
  });

  it("still reaches the real loaders when no dep is injected", () => {
    // The lazy imports must be REAL imports of the real modules, not a
    // silently-null fallback that would make the analyze route own
    // nothing forever while looking enabled.
    expect(SRC).toMatch(/await import\("\.\/load-state"\)/);
    expect(SRC).toMatch(/await import\("\.\.\/org-features"\)/);
    expect(SRC).toMatch(/m\.loadSquadState/);
    expect(SRC).toMatch(/m\.getOrgFeatures/);
  });
});

describe("the personal stats link (topic my_stats)", () => {
  const MY_Q = "@Match Time my stats";
  const MY_FACTS = { kind: "my_stats", personRef: "", feature: "none", badge: "none" };
  const TR_Q = "@Match Time istatistiklerim";
  const IN = "in";

  // 2026-09-23: no 📊 react. The route posts the "sending your stats by
  // DM" line once the DM is queued; this module has nothing to say.
  it("is owned, flagged for the route, with no react and no reply of its own", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS });
    const res = await run({ messages: [msg({ waMessageId: "wa-my", body: MY_Q, route: "question" })], model });
    const o = res.outcomes.get("wa-my");
    expect(res.ownedIds.has("wa-my")).toBe(true);
    expect(o?.statsLinkRequest).toBe(true);
    expect(o?.react).toBeNull();
    expect(o?.reply).toBeNull();
    // The labels the deleted fast path wrote, so the admin log reads the same.
    expect(o?.intent).toBe("stats_link");
    expect(o?.action).toBe("dm-stats-link");
    expect(res.writes).toEqual([]);
  });

  it("the Turkish ask is the same fact and the same outcome", async () => {
    const { model } = stubModel({ [TR_Q]: MY_FACTS });
    const res = await run({ messages: [msg({ waMessageId: "wa-tr", body: TR_Q, route: "question" })], model });
    expect(res.outcomes.get("wa-tr")?.statsLinkRequest).toBe(true);
  });

  it("an untagged ask is not owned and costs no model call", async () => {
    const { model, calls } = stubModel({ [MY_Q]: MY_FACTS });
    const res = await run({ messages: [msg({ body: "my stats", route: "question", tagged: false })], model });
    expect(res.outcomes.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("an unresolved sender is not flagged: there is nobody to DM", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS });
    const res = await run({
      messages: [msg({ waMessageId: "wa-anon", body: MY_Q, route: "question", senderUserId: null })],
      model,
    });
    expect(res.outcomes.get("wa-anon")?.statsLinkRequest ?? false).toBe(false);
  });

  it("someone ELSE's stats is the group topic, never a link", async () => {
    const q = "@Match Time what are Wasim's stats";
    const { model } = stubModel({ [q]: { topic: "stats", personRef: "Wasim", statedCount: -1 } });
    const res = await run({ messages: [msg({ waMessageId: "wa-w", body: q, route: "question" })], model });
    for (const o of res.outcomes.values()) expect(o.statsLinkRequest ?? false).toBe(false);
  });

  it("ONLY the asking message is flagged, never a neighbour", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS, [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ waMessageId: "wa-my", body: MY_Q, route: "question", senderUserId: "u-sait" }),
        msg({ waMessageId: "wa-count", body: COUNT_Q, route: "question" }),
      ],
      model,
    });
    expect(res.outcomes.get("wa-my")?.statsLinkRequest).toBe(true);
    expect(res.outcomes.get("wa-count")?.statsLinkRequest ?? false).toBe(false);
    expect(res.outcomes.get("wa-count")?.reply ?? "").toBeTruthy();
  });

  it("is still sent with NO upcoming match (end of season is when 'wrapped' is asked)", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS, [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ waMessageId: "wa-my", body: MY_Q, route: "question" }),
        msg({ waMessageId: "wa-count", body: COUNT_Q, route: "question" }),
      ],
      model,
      worldOpts: { confirmed: ELEVEN, noMatch: true },
      expectedMatchId: null,
    });
    expect(res.outcomes.get("wa-my")?.statsLinkRequest).toBe(true);
    // The list asked for with no match is the unified answer, never a post.
    expect(res.outcomes.get("wa-count")?.reply).toBe(UNIFIED_LINE);
  });

  it("is still sent when attendance tracking is off", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS });
    const res = await run({
      messages: [msg({ waMessageId: "wa-my", body: MY_Q, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, features: { attendance: false } },
    });
    expect(res.outcomes.get("wa-my")?.statsLinkRequest).toBe(true);
  });

  it("is still sent when the route's match and the state's disagree", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS });
    const res = await run({
      messages: [msg({ waMessageId: "wa-my", body: MY_Q, route: "question" })],
      model,
      expectedMatchId: "some-other-match",
    });
    expect(res.outcomes.get("wa-my")?.statsLinkRequest).toBe(true);
  });

  it("is still sent in a batch that also carries an attendance message", async () => {
    const { model } = stubModel({ [MY_Q]: MY_FACTS });
    const res = await run({
      messages: [
        msg({ waMessageId: "wa-my", body: MY_Q, route: "question" }),
        msg({ waMessageId: "wa-in", body: IN, route: "admin_ops", tagged: false }),
      ],
      model,
    });
    expect(res.outcomes.get("wa-my")?.statsLinkRequest).toBe(true);
  });

  it("with no match, a team question alone is decided exactly as before: nothing, no reason, no call", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      worldOpts: { confirmed: ELEVEN, noMatch: true },
      expectedMatchId: null,
    });
    expect(res.outcomes.size).toBe(0);
    expect(res.degradations).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ── The question prompt's cache is warmed before the fan-out (2026-09-29) ──

describe("two questions in one batch: the first warms the cache, the second reads it", () => {
  it("runs the first question extraction alone, then the rest", async () => {
    const Q2 = "@Match Time how many are we now?";
    const { model: inner } = stubModel({ [COUNT_Q]: COUNT_FACTS, [Q2]: COUNT_FACTS });
    const log: string[] = [];
    const model: PipelineModel = {
      name: "probe",
      async complete(req) {
        const body = req.user.split("\n").slice(-1)[0];
        log.push(`start:${body}`);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await inner.complete(req);
        } finally {
          log.push(`end:${body}`);
        }
      },
    };
    await run({
      messages: [
        msg({ waMessageId: "q1", body: COUNT_Q, route: "question" }),
        msg({ waMessageId: "q2", body: Q2, route: "question" }),
      ],
      model,
    });
    expect(log).toEqual([`start:${COUNT_Q}`, `end:${COUNT_Q}`, `start:${Q2}`, `end:${Q2}`]);
  });
});

describe("the silences the route must not call 'not understood'", () => {
  const OTHER_Q = "@Match Time who's on the bench?";
  const OTHER_FACTS = { kind: "other", personRef: "", feature: "none", badge: "none" };
  const SCORE = { waMessageId: "wa-score", body: "5-3 to us", route: "score" as Route, tagged: false };

  it("a question whose read failed is recorded as a failed read", async () => {
    const silence = newSilenceFacts();
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS }, { throwOn: COUNT_Q });
    await run({ messages: [msg({ waMessageId: "wa-count", body: COUNT_Q, route: "question" })], model, silence });
    expect([...silence.readFailed]).toEqual(["wa-count"]);
    expect(silence.refused.size).toBe(0);
  });

  it("the list asked for beside a writer that lands later is one the squad post answers", async () => {
    const silence = newSilenceFacts();
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [msg(SCORE), msg({ waMessageId: "wa-list", body: COUNT_Q, route: "question" })],
      model,
      enabled: ["question", "balancer", "score"],
      silence,
    });
    expect(res.outcomes.has("wa-list")).toBe(false);
    expect([...silence.squadPostAnswers]).toEqual(["wa-list"]);
  });

  it("any other question held back the same way is NOT one the squad post answers", async () => {
    const silence = newSilenceFacts();
    const { model } = stubModel({ [OTHER_Q]: OTHER_FACTS });
    const res = await run({
      messages: [msg(SCORE), msg({ waMessageId: "wa-other", body: OTHER_Q, route: "question" })],
      model,
      enabled: ["question", "balancer", "score"],
      silence,
    });
    expect(res.outcomes.has("wa-other")).toBe(false);
    expect(silence.squadPostAnswers.size).toBe(0);
  });
});
