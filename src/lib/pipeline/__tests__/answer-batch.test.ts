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
import type { Route, SpeechIntent, SquadState } from "../types";
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
): AnswerBatchDeps {
  return {
    model,
    loadState: async () => state,
    loadFeatures: async () => ({ ...FEATURES_ON, ...features }),
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
}) {
  const state = args.state ?? world(args.worldOpts ?? { confirmed: ELEVEN });
  return runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    expectedMatchId: args.expectedMatchId === undefined ? state.matchId : args.expectedMatchId,
    enabled: new Set<Route>(args.enabled ?? ["question", "balancer"]),
    deps: deps(args.model, state, args.features),
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

// ── 3. Per-shape hand-backs, decided AFTER extraction ─────────────────

describe("a shape the composer cannot answer well goes to the analyzer", () => {
  it.each([
    ["other", { topic: "other", personRef: "", statedCount: -1 }],
    ["stats", { topic: "stats", personRef: "", statedCount: -1 }],
    ["options", { topic: "options", personRef: "", statedCount: -1 }],
  ])("question topic %s", async (_topic, facts) => {
    const body = "@Match Time what do you reckon?";
    const { model } = stubModel({ [body]: facts });
    const res = await run({ messages: [msg({ body, route: "question" })], model });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.outcomes.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/analyzer/i);
  });

  it("owns the five topics §6 calls deterministic", async () => {
    for (const topic of ["squad", "count", "bench", "phones"]) {
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

  it("hands back a squad-count question when the batch may also change the squad", async () => {
    // §3.2 S36 — one authoritative squad post per batch. Two batch
    // runners each calling `decide()` cannot enforce that between them,
    // so the count question goes to the analyzer, where the shipped
    // squad-status collapse already owns the problem.
    const { model, calls } = stubModel({ [COUNT_Q]: COUNT_FACTS });
    const res = await run({
      messages: [
        msg({ body: COUNT_Q, route: "question" }),
        msg({ body: "I'm in", route: "self_att", waMessageId: "wa-in" }),
      ],
      model,
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/squad post|S36|one post/i);
    // The topic is only knowable after extraction, so this carve-out
    // costs one extractor call (~$0.002) on a batch that also carried
    // attendance. §11.1's asymmetry, priced: a false positive costs one
    // small call; the alternative costs the group two contradictory
    // squad posts.
    expect(calls).toHaveLength(1);
  });

  it("still owns a BENCH question in a batch that also changes the squad", async () => {
    // The carve-out is about the single squad post, not about questions.
    const body = "@Match Time who's on the bench?";
    const { model } = stubModel({ [body]: { topic: "bench", personRef: "", statedCount: -1 } });
    const res = await run({
      messages: [
        msg({ body, route: "question" }),
        msg({ body: "I'm in", route: "self_att", waMessageId: "wa-in" }),
      ],
      model,
      worldOpts: { confirmed: ELEVEN, bench: ["zair"] },
    });
    expect([...res.ownedIds]).toHaveLength(1);
  });

  it.each(["generate", "rename", "swap"])(
    "hands back a `%s` team request — only showing is a read",
    async (action) => {
      const body = "@Match Time do the teams";
      const { model } = stubModel({
        [body]: { action, includeRefs: [], teamNames: [], swaps: [] },
      });
      const res = await run({
        messages: [msg({ body, route: "balancer" })],
        model,
        worldOpts: { confirmed: ELEVEN, teams: { kemal: "RED", elvin: "YELLOW" } },
      });
      expect([...res.ownedIds]).toEqual([]);
      expect(res.degradations.join(" ")).toMatch(/balancer|generate|analyzer/i);
    },
  );

  it("hands back `show the teams` when no teams have been generated yet", async () => {
    // The shipped path answers "No teams generated yet — say 'generate
    // the teams' and I'll sort them." (`route.ts:3729-3731`, and its
    // comment "do NOT auto-generate"). `formatTeamsPost` over two empty
    // lists renders a teams post with no players in it, so the shape is
    // not owned rather than answered wrongly.
    const { model } = stubModel({ [SHOW_TEAMS]: SHOW_FACTS });
    const res = await run({
      messages: [msg({ body: SHOW_TEAMS, route: "balancer" })],
      model,
      worldOpts: { confirmed: ELEVEN },
    });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/no teams/i);
  });

  it("hands a message back when its extraction FAILED, rather than going silent", async () => {
    // Step 6's measured lesson: 27 `529 Overloaded` in one live sweep
    // took two corpus cases from 3/3 to 0/3 — not because the engine
    // decided them wrongly but because it never got to decide them.
    const { model } = stubModel({ [COUNT_Q]: COUNT_FACTS }, { throwOn: COUNT_Q });
    const res = await run({ messages: [msg({ body: COUNT_Q, route: "question" })], model });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.outcomes.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/529|failed/i);
    expect(res.degradations.join(" ")).toMatch(/analyzer/i);
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
    expect(out.action).toBe("none");
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
    expect(out.action).toBe("none");
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

// ── 6. Why `stats` and `options` are NOT owned — measured, not asserted ──

describe("the measured reason two topics stay with the analyzer", () => {
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

  it("the composed STATS answer would be replaced by the squad post — the 2026-05-14 incident", () => {
    // `compose.ts`'s `answer_stats` renders "1. Kemal Ediz (24)" lines.
    // `isLeaderboardLine` (`group-copy.ts:129`) recognises a leaderboard
    // by an em dash, a percentage, "wins/votes/matches" or an "N/M ("
    // pattern — and that shape has none of them. So `displaysSquadState`
    // sees a numbered run of 2+ lines and says yes, and once this path
    // is wired into the analyze route the step-4 composer would swap a
    // "most consistent" answer for the upcoming-squad roster. That is
    // the exact incident §3.2 S16 cites for 2026-05-14.
    const text = say({ kind: "answer_stats", messageId: "wa-1" }, APPEARANCES);
    expect(text).toContain("Kemal Ediz");
    expect(displaysSquadState(text)).toBe(true);
  });

  it("the composed OPTIONS answer would be replaced by the squad post, losing the format-switch line", () => {
    // The lead carries "8/14" and "need", which is rule (c) of
    // `displaysSquadState`. `composeSquadStateReply` keeps a lead only
    // when the model asked for a squad post AND the lead makes no claim
    // of its own, so this whole answer — including the arithmetic
    // `format-switch.ts` computed — is dropped, not appended to.
    const state = world({
      confirmed: ELEVEN.slice(0, 8),
      smallerFormats: [{ sportName: "5-a-side", totalPlayers: 10 }],
    });
    const text = say({ kind: "answer_options", messageId: "wa-1" }, state);
    expect(text).toContain("8/14");
    expect(displaysSquadState(text)).toBe(true);
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
