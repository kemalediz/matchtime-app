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
      const payload = table[body];
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
}) {
  const state = args.state ?? world(args.worldOpts ?? { confirmed: ELEVEN });
  return runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    expectedMatchId: args.expectedMatchId === undefined ? state.matchId : args.expectedMatchId,
    enabled: new Set<Route>(args.enabled ?? ["question", "balancer"]),
    deps: deps(args.model, state, args.features, args.loadPayments, args.loadRatingProgress),
  });
}

const COUNT_Q = "@Match Time how many are we?";
const COUNT_FACTS = { topic: "count", personRef: "", statedCount: -1 };
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

  it("owns nothing when there is no active registration match", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      worldOpts: { noMatch: true },
      expectedMatchId: null,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("owns nothing when the route and the engine disagree about the match", async () => {
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      expectedMatchId: "some-other-match",
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/disagree/i);
  });

  it("owns nothing for an org that does not track attendance (the MoM-only shape)", async () => {
    // ATTENDANCE_OFF_OVERRIDE (`message-analyzer.ts:923`) makes the
    // mega-prompt stay SILENT on every squad question for these orgs.
    // A composer that answered "0/0" would be the 2026-06-08 Sutton Lads
    // incident ("MT told them 0/14 — need 14 players") reintroduced by a
    // path that never read the override.
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, features: { attendance: false } },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("owns nothing when the match has no capacity to divide by", async () => {
    // "We're 11/0, need 0 more" is the 2026-06-08 "0/14" shape reached
    // from the other direction. It should be impossible; the answer to
    // an impossible state is the path that already handles it.
    const { model, calls } = stubModel({});
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, maxPlayers: 0 },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(calls).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/maxPlayers=0/);
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
  it.each([
    ["other", { topic: "other", personRef: "", statedCount: -1 }],
  ])("question topic %s", async (_topic, facts) => {
    // This describe block was titled "…goes to the analyzer" and
    // asserted /analyzer/i, which was true until §10 step 8 deleted
    // `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT`. `other` is
    // now answered by NOBODY: silence in the group plus one line on the
    // operator DM.
    //
    // `stats` and `options` USED TO BE IN THIS LIST. They were removed
    // when their composed FORMAT was fixed — the refusal was never about
    // the answers, which have been correct since the day they were
    // written, but about `composeSquadStateReply` replacing them with
    // the squad roster on the way out. See section 6 below.
    const body = "@Match Time what do you reckon?";
    const { model } = stubModel({ [body]: facts });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.outcomes.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/nobody answers this message/i);
    expect(res.degradations.join(" ")).not.toMatch(/analyzer/i);
  });

  it("owns the topics answered from the database", async () => {
    for (const topic of ["count", "bench", "phones", "squad", "fixture", "stats", "options"]) {
      const body = `@Match Time ${topic}?`;
      const { model } = stubModel({ [body]: { topic, personRef: "", statedCount: -1 } });
      const res = await run({ messages: [msg({ body, route: "question" })], model });
      expect([...res.ownedIds], topic).toHaveLength(1);
    }
    const body = "@Match Time is Faris in?";
    const { model } = stubModel({
      [body]: { topic: "person_status", personRef: "Faris", statedCount: -1 },
    });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toHaveLength(1);
  });

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
      [body]: { topic: "squad", personRef: "", statedCount: -1 },
    });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toHaveLength(1);
    const reply = [...res.outcomes.values()][0].reply!;
    expect(reply).toBe(
      composeSquadStatusPost({ confirmed: ELEVEN.map(fullName), bench: [], maxPlayers: 14 }),
    );
    expect(reply).toContain(fullName("kemal"));
  });

  it("answers a fixture question from the match, with no count in it", async () => {
    // Four of the twelve tagged questions in the 2026-09-06 live sweep
    // were fixture questions — "what time is kickoff", "where are we
    // playing", "are we playing tuesday", "is the game still on". Every
    // one of them landed on topic `other` and produced SILENCE, which is
    // §9's signature failure. They are answered from `kickoffLabel` and
    // `venue`, and from nothing else.
    const body = "@Match Time what time is kickoff";
    const { model } = stubModel({ [body]: { topic: "fixture", personRef: "", statedCount: -1 } });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toHaveLength(1);
    const reply = [...res.outcomes.values()][0].reply!;
    expect(reply).toContain("Tue 21:30");
    expect(reply).toContain("Goals North Cheam");
    // A count would make `composeSquadStateReply` swap the whole answer
    // for the roster, and the asker would get no time at all.
    expect(displaysSquadState(reply)).toBe(false);
  });

  it("hands back a person question whose name does not resolve", async () => {
    // "X isn't down yet" about somebody the roster cannot identify is
    // the S16 failure class in miniature: a confident claim about squad
    // state that nothing checked.
    const body = "@Match Time is Nobody McNobody in?";
    const { model } = stubModel({
      [body]: { topic: "person_status", personRef: "Nobody McNobody", statedCount: -1 },
    });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/did not resolve|does not resolve/i);
  });

  it("hands back an ambiguous person question", async () => {
    const body = "@Match Time is Ahmadi in?";
    const { model } = stubModel({
      [body]: { topic: "person_status", personRef: "Ahmadi", statedCount: -1 },
    });
    // Two Ahmadis on the roster — `resolvePerson` bails ambiguous.
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toEqual([]);
  });

  it.each([
    ["count", COUNT_Q, COUNT_FACTS],
    ["squad", "@Match Time who's playing?", { topic: "squad", personRef: "", statedCount: -1 }],
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

  it.each([
    ["bench", { topic: "bench", personRef: "", statedCount: -1 }],
    ["person_status", { topic: "person_status", personRef: "Zair", statedCount: -1 }],
    ["phones", { topic: "phones", personRef: "", statedCount: -1 }],
  ])(
    "hands back a %s question too when the batch may also change the squad",
    async (_topic, facts) => {
      // THESE THREE ARE UNCHANGED BY THE 2026-09-09 CARVE-OUT, AND THAT
      // IS A CHOICE RATHER THAN AN OVERSIGHT.
      //
      // The roster post that vanished had been answering exactly two
      // topics by accident — `squad` and `count`, the two `engine.ts`
      // defers into it. Restoring an answer for those is a repair.
      // `bench`, `person_status` and `phones` never got one from it: a
      // batch with an "in" and "who's on the bench?" has always ended in
      // a roster post that does not answer the question asked. Widening
      // the carve-out to them would ADD replies MatchTime does not make
      // today, on a change whose whole point is to make it quieter, so
      // it is left for a separate decision with its own evidence.
      //
      // What is NOT the reason any more: "composed from a PRE-WRITE
      // snapshot". `route.ts` awaits the attendance owner and its writes
      // before this module loads its state.
      const body = "@Match Time question?";
      const { model } = stubModel({ [body]: facts });
      const res = await run({
        messages: [
          msg({ body, route: "question" }),
          msg({ body: "sorry lads can't make it", route: "self_att", waMessageId: "wa-out" }),
        ],
        model,
        worldOpts: { confirmed: ELEVEN, bench: ["zair"] },
      });
      expect([...res.ownedIds]).toEqual([]);
    },
  );

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
      "No teams generated yet — say 'generate the teams' and I'll sort them.",
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
  it("answers a count question with the database's number", async () => {
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({ messages: [msg({ body: COUNT_Q, route: "question" })], model });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toContain("11/14");
    expect(out.reply).toContain("need 3 more");
    expect(out.intent).toBe("question");
    // The shipped vocabulary for a message MatchTime answered without
    // writing (`route.ts:2197-2200`), so the admin log and the nightly
    // `none`-bucket sweep read a step-7 answer as an answer.
    expect(out.action).toBe("reply");
    expect(out.react).toBeNull();
    expect(res.cost.calls).toBe(1);
    expect(res.cost.usd).toBeCloseTo(0.0021, 6);
  });

  it("corrects a wrong stated count (§3.2 S24) rather than agreeing with it", async () => {
    const body = "@Match Time we're 9/14 right?";
    const { model } = stubModel({ [body]: { topic: "count", personRef: "", statedCount: 9 } });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toMatch(/not quite/i);
    expect(out.reply).toContain("11/14");
    expect(out.reasoning).toContain("stated 9");
  });

  it("answers a bench question with names only and no speculation (§3.2 S16c)", async () => {
    const body = "@Match Time who's on the bench?";
    const { model } = stubModel({ [body]: { topic: "bench", personRef: "", statedCount: -1 } });
    const res = await run({
      messages: [msg({ body, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, bench: ["zair", "wasim"] },
    });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toContain("Zair Malik");
    expect(out.reply).toContain("Wasim Akhtar");
    expect(out.reply).not.toMatch(/5-a-side|downgrade|if we/i);
  });

  it("never prints a raw phone number in a phones answer (§3.2 S32)", async () => {
    const body = "@Match Time who has no number?";
    const { model } = stubModel({ [body]: { topic: "phones", personRef: "", statedCount: -1 } });
    const res = await run({
      messages: [msg({ body, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, noPhone: ["idris"] },
    });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toContain("Idris Bello");
    expect(out.reply).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);
  });

  it("the phones answer is about the SQUAD, not every member the org has ever had", async () => {
    // `state.roster` is every active membership. A club that has been
    // provisioning named guests for months would get a wall of names
    // about people who are not playing — and nothing downstream would
    // catch it, because a list of names is not squad state and
    // `composeSquadStateReply` never looks at it. The shipped rule
    // answers from "the Confirmed and Bench lists in the Match Context".
    const body = "@Match Time who has no number?";
    const { model } = stubModel({ [body]: { topic: "phones", personRef: "", statedCount: -1 } });
    const res = await run({
      messages: [msg({ body, route: "question" })],
      model,
      worldOpts: {
        confirmed: ELEVEN,
        bench: ["zair"],
        // Idris is playing, Zair is benched, the other three are on the
        // roster and nowhere near this match.
        noPhone: ["idris", "zair", "mojib", "erdal", "zeeshan"],
      },
    });
    const out = [...res.outcomes.values()][0]!;
    expect(out.reply).toContain("Idris Bello");
    expect(out.reply).toContain("Zair Malik");
    for (const absent of ["Mojib", "Erdal", "Zeeshan"]) {
      expect(out.reply, `${absent} is not in the squad`).not.toContain(absent);
    }
  });

  it("says so plainly when the whole squad has a number", async () => {
    const body = "@Match Time who has no number?";
    const { model } = stubModel({ [body]: { topic: "phones", personRef: "", statedCount: -1 } });
    const res = await run({
      messages: [msg({ body, route: "question" })],
      model,
      // Somebody on the ROSTER has no number, but nobody playing does.
      worldOpts: { confirmed: ELEVEN, noPhone: ["zeeshan"] },
    });
    expect([...res.outcomes.values()][0]!.reply).toMatch(/everyone in the squad/i);
  });

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

// ── 6. Why `stats` and `options` ARE owned now — measured, not asserted ──

describe("the format fix that let the last two built answers speak", () => {
  /**
   * The strings under test are produced by the REAL composer, not typed
   * out here. A hand-written approximation would keep passing after
   * `compose.ts` changed format, which is the "test that would still
   * pass if the implementation were deleted" trap — and the whole point
   * of these two is that they must FAIL the day the format is fixed, so
   * the carve-out is revisited rather than forgotten.
   */
  function say(
    speech: SpeechIntent,
    state: SquadState,
  ): string {
    const out = compose({
      outcomes: [],
      writes: [],
      nextState: state,
      speech: [speech],
      degradations: [],
    });
    expect(out.utterances).toHaveLength(1);
    return out.utterances[0].text;
  }

  const APPEARANCES = world({
    confirmed: ELEVEN,
    appearances: [
      { userId: "u-kemal", matches: 24 },
      { userId: "u-elvin", matches: 22 },
      { userId: "u-sait", matches: 21 },
    ],
  });

  it("the composed STATS answer reads as a LEADERBOARD, not as squad state (2026-05-14)", () => {
    // THE FIX, AND WHAT IT REPLACED. `compose.ts`'s `answer_stats` used
    // to render "1. Kemal Ediz (24)" lines. `isLeaderboardLine`
    // (`group-copy.ts:129`) recognises a leaderboard by an em dash, a
    // percentage, "wins/votes/matches" or an "N/M (" pattern, and that
    // shape carried NONE of them — so `displaysSquadState` saw a
    // numbered run of 2+ lines and said yes, and `route.ts:2480` would
    // have swapped a "most consistent" answer for the upcoming-squad
    // roster. That is the exact incident §3.2 S16 cites for 2026-05-14,
    // and it is why the topic was refused rather than answered.
    //
    // The answer now uses the house leaderboard format
    // (`match-history.ts:336`), which carries both an em dash and the
    // word "matches". The refusal could then be dropped. This test is
    // the reason it can be: it fails the day the format regresses.
    const text = say({ kind: "answer_stats", messageId: "wa-1" }, APPEARANCES);
    expect(text).toContain("Kemal Ediz");
    expect(text).toMatch(/1\. Kemal Ediz — 24 matches/);
    expect(text).toContain("last 30 days");
    expect(displaysSquadState(text)).toBe(false);
  });

  it("the composed OPTIONS answer carries no N/M, so nothing replaces it", () => {
    // The lead used to read "We're 8/14, need 6 more 🙏" — an "N/M"
    // beside squad vocabulary, which is rule (c) of
    // `displaysSquadState`. `composeSquadStateReply` keeps a lead only
    // when it makes no claim of its own, so the WHOLE answer — including
    // the arithmetic `format-switch.ts` computed — was dropped rather
    // than appended to.
    //
    // The count is now spelled out ("8 of 14") instead of fractioned.
    // Same fact, same words to a human, invisible to rule (c).
    const state = world({
      confirmed: ELEVEN.slice(0, 8),
      smallerFormats: [{ sportName: "5-a-side", totalPlayers: 10 }],
    });
    const text = say({ kind: "answer_options", messageId: "wa-1" }, state);
    expect(text).toContain("8 of 14");
    expect(text).not.toMatch(/\d+\/\d+/);
    expect(displaysSquadState(text)).toBe(false);
  });

  it("the OPTIONS answer still names exactly who a switch would bench, from the format TOTAL", () => {
    // The 2026-08-30 incident, from the other side: the model computed
    // 8 − 5 (players per TEAM) instead of 8 − 10 (the format TOTAL) and
    // named three real people as losing their place when a switch would
    // have benched nobody. `benchedOnFormatSwitch` takes the total, so
    // twelve confirmed dropping to a ten-player format benches the LAST
    // TWO by position and nobody else.
    const state = world({
      confirmed: ELEVEN.concat(["wasim"]),
      smallerFormats: [{ sportName: "5-a-side", totalPlayers: 10 }],
    });
    const text = say({ kind: "answer_options", messageId: "wa-1" }, state);
    expect(text).toContain(fullName("amir"));
    expect(text).toContain(fullName("wasim"));
    // …and NOT the eight who keep their place.
    expect(text).not.toContain(fullName("kemal"));
    expect(displaysSquadState(text)).toBe(false);
  });

  it("the composed BENCH, PHONES and PERSON answers survive untouched", () => {
    const benched = world({ confirmed: ELEVEN, bench: ["zair", "wasim"], noPhone: ["idris"] });
    expect(displaysSquadState(say({ kind: "answer_bench", messageId: "m" }, benched))).toBe(false);
    expect(displaysSquadState(say({ kind: "answer_phones", messageId: "m" }, benched))).toBe(false);
    expect(
      displaysSquadState(
        say(
          { kind: "answer_person_status", messageId: "m", personRef: "Faris", userId: "u-faris" },
          benched,
        ),
      ),
    ).toBe(false);
    // …and the same answer about somebody with no row at all.
    expect(
      displaysSquadState(
        say(
          { kind: "answer_person_status", messageId: "m", personRef: "Zeeshan", userId: "u-zeeshan" },
          benched,
        ),
      ),
    ).toBe(false);
  });

  it("the composed FIXTURE answer survives untouched", () => {
    // The whole reason the fixture answer carries no count. A "21:30 at
    // Goals North Cheam" that tripped `displaysSquadState` would be
    // replaced by the squad roster, and the person who asked what time
    // kickoff is would get a list of names and no time.
    const text = say({ kind: "answer_fixture", messageId: "m" }, world({ confirmed: ELEVEN }));
    expect(text).toContain("Tue 21:30");
    expect(displaysSquadState(text)).toBe(false);
  });

  it("the composed TEAMS-NOT-GENERATED answer survives untouched", () => {
    const text = say({ kind: "teams_not_generated", messageId: "m" }, world({ confirmed: ELEVEN }));
    expect(displaysSquadState(text)).toBe(false);
  });

  it("the composed SQUAD answer IS replaced — by a byte-identical post", () => {
    // `answer_squad` renders `composeSquadStatusPost` and so trips
    // `displaysSquadState` by construction. That is harmless in a way
    // the STATS and OPTIONS answers are not: `composeSquadStateReply`
    // replaces it with `composeSquadStatusPost` over the same truth, so
    // the group reads the same characters either way. Asserted rather
    // than reasoned about, because "it gets replaced by an identical
    // string" is exactly the kind of claim that silently stops being
    // true when one of the two composers is edited.
    const state = world({ confirmed: ELEVEN, bench: ["zair"] });
    const text = say({ kind: "answer_squad", messageId: "m" }, state);
    expect(displaysSquadState(text)).toBe(true);
    expect(text).toBe(
      composeSquadStatusPost({
        confirmed: ELEVEN.map(fullName),
        bench: [fullName("zair")],
        maxPlayers: 14,
      }),
    );
  });

  it("the composed COUNT answer IS replaced — which is today's behaviour, not a regression", () => {
    // Owned deliberately. "How many are we?" already gets the composed
    // squad post today, because the model's answer displays squad state
    // and `composeSquadStateReply` replaces it. The engine's version
    // lands in exactly the same place, and S24's `\b11\b` is satisfied
    // by the post's own `*11/14*`.
    const text = say({ kind: "answer_count", messageId: "m", statedCount: 9 }, world({ confirmed: ELEVEN }));
    expect(text).toMatch(/not quite/i);
    expect(displaysSquadState(text)).toBe(true);
    expect(
      composeSquadStatusPost({ confirmed: ELEVEN.map(fullName), bench: [], maxPlayers: 14 }),
    ).toMatch(/\b11\b/);
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

// ── 7. THE ONE TARGETED EXTRA READ ───────────────────────────────────
//
// `loadSquadState` runs on EVERY batch, including the 69% that are
// banter, so the payment rows are not in it. They are loaded here, AFTER
// extraction, and only when a `payments` topic survived ownership. These
// four tests are the whole contract: it fires when it must, it does not
// fire otherwise, a failure costs one answer rather than the batch, and
// nothing on this path can print a name.

describe("payments are read only when a payment question is in the window", () => {
  const PAY_Q = "@Match Time who hasn't paid";
  const PAY_FACTS = { topic: "payments", personRef: "", statedCount: -1 };

  function spyLoader(snapshot: PaymentSnapshot) {
    const calls: string[] = [];
    const loadPayments: AnswerBatchDeps["loadPayments"] = async (orgId) => {
      calls.push(orgId);
      return snapshot;
    };
    return { calls, loadPayments };
  }

  it("does NOT read payments for an ordinary count question — the common path stays cheap", async () => {
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const { calls, loadPayments } = spyLoader({ kind: "not_tracked" });
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      loadPayments,
    });
    expect([...res.ownedIds]).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("reads payments exactly once for a payment question", async () => {
    const { model } = stubModel({ [PAY_Q]: PAY_FACTS });
    const { calls, loadPayments } = spyLoader({
      kind: "counted",
      chargeable: 9,
      unpaid: 5,
      kickoffLabel: "Tue 21:15",
    });
    const res = await run({
      messages: [msg({ body: PAY_Q, route: "question" })],
      model,
      worldOpts: { confirmed: ELEVEN, completedMatch: { id: "m-old" } },
      loadPayments,
    });
    expect(calls).toEqual(["org-1"]);
    const reply = [...res.outcomes.values()][0]?.reply ?? "";
    expect(reply).toContain("5 of 9");
    // NOT ONE NAME. `PaymentSnapshot` has no field a name could come out
    // of; this asserts the consequence rather than the shape.
    expect(reply).not.toMatch(/Kemal|Elvin|Sait|Mustafa|Abid|Idris|Faris|Shaz|Adam|Efat|Amir/);
  });

  it("a payment read that throws costs that answer, not the batch", async () => {
    const { model } = stubModel({ [PAY_Q]: PAY_FACTS, [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ waMessageId: "wa-pay", body: PAY_Q, route: "question" }),
        msg({ waMessageId: "wa-count", body: COUNT_Q, route: "question" }),
      ],
      model,
      worldOpts: { confirmed: ELEVEN, completedMatch: { id: "m-old" } },
      loadPayments: async () => {
        throw new Error("db is on fire");
      },
    });
    // The count question is still answered…
    expect([...res.ownedIds]).toEqual(["wa-count"]);
    // …and the payment question hands back with a reason, never a silent
    // empty answer.
    expect(res.outcomes.has("wa-pay")).toBe(false);
    expect(res.degradations.join(" ")).toMatch(/payment read failed/i);
    expect(res.degradations.join(" ")).toMatch(/db is on fire/);
  });

  it("owns the payments topic, and says MatchTime does not know when it does not", async () => {
    const { model } = stubModel({ [PAY_Q]: PAY_FACTS });
    const { loadPayments } = spyLoader({ kind: "not_tracked" });
    const res = await run({
      messages: [msg({ body: PAY_Q, route: "question" })],
      model,
      loadPayments,
    });
    expect([...res.ownedIds]).toHaveLength(1);
    expect([...res.outcomes.values()][0].reply).toMatch(/don't track/i);
  });
});

// ── THE SECOND TARGETED READ — RATING PROGRESS (2026-09-11) ──────────
//
// Same contract as `payments` above, and it is on this path for the same
// kind of reason `stats_blast` moved to the engine: the regex that used
// to claim this ask — `looksLikeRatingProgressRequest`, (a rating word)
// AND (a progress word) anywhere in a body — is the conjunction shape
// behind the 2026-09-01 and 2026-09-10 incidents, and it is deleted.
//
// Three cases, the same three that matter for any read behind a topic:
// it fires when it must, it does not fire otherwise, and a failure costs
// one answer rather than the batch.

describe("rating progress is read only when a rating question is in the window", () => {
  const RATE_Q = "@Match Time who hasn't rated yet?";
  const RATE_FACTS = { topic: "rating_progress", personRef: "", statedCount: -1 };

  const PROGRESS = {
    ok: true,
    matchName: "Tuesday 7-a-side",
    matchWhen: "Tue 2 Sep",
    confirmed: 10,
    ratedCount: 6,
    momCount: 5,
    notRated: ["Zair Malik"],
    ratedNoMom: [],
  };

  function spyLoader() {
    const calls: string[] = [];
    const loadRatingProgress: AnswerBatchDeps["loadRatingProgress"] = async (orgId) => {
      calls.push(orgId);
      return PROGRESS;
    };
    return { calls, loadRatingProgress };
  }

  it("does NOT read it for an ordinary count question — the common path stays cheap", async () => {
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const { calls, loadRatingProgress } = spyLoader();
    const res = await run({
      messages: [msg({ body: COUNT_Q, route: "question" })],
      model,
      loadRatingProgress,
    });
    expect([...res.ownedIds]).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("reads it exactly once for a rating question, and answers from what came back", async () => {
    const { model } = stubModel({ [RATE_Q]: RATE_FACTS });
    const { calls, loadRatingProgress } = spyLoader();
    const res = await run({
      messages: [msg({ body: RATE_Q, route: "question", senderUserId: "u-kemal", tagged: true })],
      model,
      loadRatingProgress,
    });
    expect(calls).toEqual(["org-1"]);
    const reply = [...res.outcomes.values()][0]?.reply ?? "";
    expect(reply).toContain("Rated: 6/10");
    // UNLIKE `payments`, THIS ANSWER NAMES NAMES — which is exactly why
    // the engine keeps the deleted fast path's admin gate on it.
    expect(reply).toContain("Zair Malik");
  });

  it("keeps the intent label the deleted fast path wrote", async () => {
    // So the admin log's vocabulary, and every sweep over it, is
    // unchanged by the move from regex to model.
    const { model } = stubModel({ [RATE_Q]: RATE_FACTS });
    const { loadRatingProgress } = spyLoader();
    const res = await run({
      messages: [msg({ body: RATE_Q, route: "question", senderUserId: "u-kemal", tagged: true })],
      model,
      loadRatingProgress,
    });
    expect([...res.outcomes.values()][0]?.intent).toBe("rating_progress");
  });

  it("a rating read that throws costs that answer, not the batch", async () => {
    const { model } = stubModel({ [RATE_Q]: RATE_FACTS, [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ waMessageId: "wa-rate", body: RATE_Q, route: "question", senderUserId: "u-kemal", tagged: true }),
        msg({ waMessageId: "wa-count", body: COUNT_Q, route: "question" }),
      ],
      model,
      loadRatingProgress: async () => {
        throw new Error("db down");
      },
    });
    // The count question still gets its answer.
    expect(res.outcomes.get("wa-count")?.reply ?? "").toBeTruthy();
    // The rating question is disowned rather than answered emptily — a
    // hand-back with a receipt.
    expect(res.outcomes.has("wa-rate")).toBe(false);
    expect(res.degradations.join(" ")).toMatch(/rating-progress read failed/i);
  });
});
