/**
 * §10 STEP 8 — the `balancer` route's `generate` action, owned end to
 * end.
 *
 * Every test here is an OWNERSHIP test before it is a behaviour test,
 * because ownership is where this step can hurt somebody. What is
 * different about step 8, and what every test below is really about:
 * "handed back" no longer means the mega-prompt answers it. It means
 * SILENCE plus one operator note. So the bar for owning a message is
 * higher AND the bar for refusing one is higher, in opposite directions.
 *
 * The properties that matter most, in order:
 *
 *   1. NOTHING IS OWNED BY DEFAULT. Flag off → not one model call.
 *   2. THE TAG IS REQUIRED. Both team intents are in `ACTIONY_INTENTS`.
 *   3. ONE GENERATE PER BATCH, AND IT IS THE LAST ONE
 *      (`route.ts:2084-2100`). Two balancer runs one line apart is the
 *      worst possible answer to the same request typed twice.
 *   4. `show` IS NOT OWNED HERE and `generate` IS NOT OWNED THERE. Two
 *      owners for one route, disjoint on a fact.
 *   5. THE POST NEVER OUTRUNS THE WRITE. A generation that threw says
 *      nothing at all (§3.2 S7, the 2026-05-15 Erdal incident).
 *   6. THE COPY IS THE SHIPPED COPY, byte for byte.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { EngineResult, Route, SquadState } from "../pipeline/types";
import type { OrgFeatures } from "../org-features";
import { NOW, fullName, world, type WorldOpts } from "../pipeline/__tests__/helpers";
import {
  runTeamOpsBatch,
  describeTeamOpsBatch,
  TEAM_OPS_ROUTES,
  TEAM_OPS_ACTIONS,
  type TeamOpsBatchMessage,
  type TeamOpsBatchDeps,
} from "../team-ops-engine-batch";
import {
  TEAM_OPS_NO_MATCH_REPLY,
  composeBalancerRefusal,
  composeGenerateTeamsReply,
  type TeamGenerationOutcome,
} from "../team-ops-engine";

// ── Fixtures ───────────────────────────────────────────────────────────

const SQUAD = [
  "kemal",
  "elvin",
  "sait",
  "mustafa",
  "abid",
  "idris",
  "faris",
  "shaz",
  "adam",
  "efat",
  "usama",
  "karahan",
  "zair",
  "wasim",
];

function squadWorld(over: WorldOpts = {}): SquadState {
  return world({ confirmed: SQUAD, ...over });
}

const FEATURES_ON: OrgFeatures = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
};

/** A model that answers from a table keyed on the message body, and
 *  COUNTS its calls — "the flag is off so nothing was spent" is only
 *  true if nobody called it. */
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
        usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0011,
        ms: 500,
      };
    },
  };
  return { model, calls };
}

/** A whole `teams` extraction, with the fields a caller does not care
 *  about defaulted. Mirrors what the extractor's schema guarantees. */
function teamsFacts(over: Record<string, unknown> = {}) {
  return {
    action: "generate",
    includeRefs: [],
    teamNames: [],
    swaps: [],
    pairings: [],
    ...over,
  };
}

interface Recorder {
  /** Every `forceConfirm` call, in order. */
  confirmed: Array<{ matchId: string; userId: string; ref: string; actorUserId: string | null }>;
  /** Every `generateTeams` call, in order. */
  generated: Array<{
    matchId: string;
    pinnedToTeam?: Record<string, "RED" | "YELLOW">;
    teamNames?: [string, string];
  }>;
  deps: TeamOpsBatchDeps;
}

const POST = "⚽ *Teams for Tue 21:30*\n\n*Red*:\n1. Kemal Ediz\n\n*Yellow*:\n1. Elvin Aliyev";

function recorder(
  model: PipelineModel,
  state: SquadState,
  over: Partial<TeamOpsBatchDeps> = {},
  outcome: TeamGenerationOutcome = { ok: true, groupPost: POST },
): Recorder {
  const confirmed: Recorder["confirmed"] = [];
  const generated: Recorder["generated"] = [];
  return {
    confirmed,
    generated,
    deps: {
      model,
      loadState: async () => state,
      loadFeatures: async () => FEATURES_ON,
      selectTeamsMatch: async () => ({ id: "match-1" }),
      forceConfirm: async (a) => {
        confirmed.push({
          matchId: a.matchId,
          userId: a.userId,
          ref: a.ref,
          actorUserId: a.actorUserId,
        });
      },
      generateTeams: async (matchId, opts) => {
        generated.push({ matchId, ...opts });
        return outcome;
      },
      ...over,
    },
  };
}

function msg(o: Partial<TeamOpsBatchMessage> & { body: string }): TeamOpsBatchMessage {
  return {
    waMessageId: o.waMessageId ?? `wa-${o.body.slice(0, 14)}`,
    body: o.body,
    authorName: o.authorName ?? fullName("kemal"),
    senderUserId: o.senderUserId === undefined ? "u-kemal" : o.senderUserId,
    senderName: o.senderName ?? fullName("kemal"),
    // TAGGED by default: every real generate request is.
    tagged: o.tagged ?? true,
    // `"route" in o` and not `?? "balancer"`: an EXPLICIT `undefined` is
    // the shape of a message the router never mentioned, and it has to
    // survive the builder or the "never owned" test tests nothing.
    route: "route" in o ? o.route : "balancer",
    gated: o.gated ?? false,
  };
}

const GEN = "@Match Time generate the teams";
const SHOW_BODY = "@Match Time show the teams";

async function run(args: {
  messages: TeamOpsBatchMessage[];
  deps: TeamOpsBatchDeps;
  enabled?: Route[];
}) {
  return runTeamOpsBatch({
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    enabled: new Set<Route>(args.enabled ?? ["balancer"]),
    deps: args.deps,
  });
}

// ── 1. Nothing by default ──────────────────────────────────────────────

describe("the generate action owns nothing unless its flag says so", () => {
  it("makes no model call at all with the flag off", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps, enabled: [] });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
    expect(r.generated).toEqual([]);
    expect(res.cost.calls).toBe(0);
  });

  it("owns nothing for a route that is not `balancer`, even with the flag on", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, squadWorld());
    const res = await run({
      messages: [msg({ body: GEN, route: "question" }), msg({ body: "x", route: undefined })],
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("owns nothing for a message step 5's gate already skipped", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: GEN, gated: true })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("REQUIRES the @Match Time tag, before spending a call", async () => {
    // `generate_teams_request` is in `ACTIONY_INTENTS`
    // (`interaction-contract.ts:148-156`), so the shipped gate already
    // refuses an untagged one. Requiring it here can only own less.
    const { model, calls } = stubModel({});
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: "make the teams", tagged: false })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
    expect(r.generated).toEqual([]);
  });

  it("names exactly the route and the actions it owns", () => {
    expect([...TEAM_OPS_ROUTES]).toEqual(["balancer"]);
    expect([...TEAM_OPS_ACTIONS]).toEqual(["generate"]);
  });
});

// ── 2. The happy path ──────────────────────────────────────────────────

describe("a tagged generate request builds and posts the teams", () => {
  it("runs the balancer and replies with its post, reacting ⚽", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });

    expect(res.ownedIds.size).toBe(1);
    expect(r.generated).toEqual([{ matchId: "match-1" }]);
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe(POST);
    expect(out.react).toBe("⚽");
    expect(out.teamsGenerated).toBe(true);
    expect(out.writeFailed).toBe(false);
    expect(out.matchId).toBe("match-1");
    expect(res.generatedMatchId).toBe("match-1");
  });

  it("labels the outcome `generate_teams_request`, which route.ts:2357 depends on", async () => {
    // A team post labelled anything else has its two numbered lists read
    // as a roster by `displaysSquadState` and REPLACED by the squad
    // roster. This is a cross-module contract, not a log field.
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect([...res.outcomes.values()][0].intent).toBe("generate_teams_request");
    expect([...res.outcomes.values()][0].action).toBe("generate_teams");
  });

  it("does not require the sender to be an admin — any tagged member may ask", async () => {
    // The shipped path has no admin check (`route.ts:3552`). Adding one
    // here would be a regression dressed as caution.
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({
      messages: [msg({ body: GEN, senderUserId: "u-zair", senderName: fullName("zair") })],
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(1);
    expect(r.generated).toHaveLength(1);
  });

  it("selects the match through the SHIPPED selector, not SquadState.matchId", async () => {
    // `selectRegistrationMatch` answers a different question and can
    // decline to pick a match at all while a previous one is in flight —
    // precisely the evening somebody asks for the teams.
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld({ noMatch: true }), {
      selectTeamsMatch: async () => ({ id: "match-99" }),
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(r.generated).toEqual([{ matchId: "match-99" }]);
    expect([...res.outcomes.values()][0].teamsGenerated).toBe(true);
  });
});

// ── 3. The shipped copy, carried across ────────────────────────────────

describe("the shipped sentences are reproduced, not re-invented", () => {
  it("says the shipped line and reacts 🤔 when no match qualifies", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), { selectTeamsMatch: async () => null });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe("No match lined up to build teams for.");
    expect(TEAM_OPS_NO_MATCH_REPLY).toBe("No match lined up to build teams for.");
    expect(out.react).toBe("🤔");
    expect(out.teamsGenerated).toBe(false);
    expect(out.writeFailed).toBe(false);
    expect(r.generated).toEqual([]);
  });

  it("passes the balancer's own refusal through, with 🤔", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), {}, {
      ok: false,
      reason: "not enough confirmed players — 9/14",
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe("Can't build teams right now — not enough confirmed players — 9/14.");
    expect(out.react).toBe("🤔");
    expect(out.teamsGenerated).toBe(false);
    // NOT a failure: the group got a reason, which is the whole
    // difference between this product and a bot that shrugs.
    expect(out.writeFailed).toBe(false);
  });

  it("composes the include / pin prefixes and the unmatched suffixes in the shipped order", () => {
    expect(
      composeGenerateTeamsReply({
        groupPost: "POST",
        includedNames: ["Ibrahim Khan", "Ehtisham Ul Haq"],
        pinnedLog: ["Kemal Ediz → RED"],
        unmatchedIncludes: ["Dave"],
        unmatchedPins: ["Bazza"],
      }),
    ).toBe(
      "_Pinned per the request: Kemal Ediz → RED._\n\n" +
        "_Including Ibrahim Khan, Ehtisham Ul Haq as CONFIRMED per the request._\n\n" +
        "POST" +
        "\n\n_(couldn't find Dave in the roster — ignored)_" +
        "\n\n_(couldn't find Bazza for team pinning — ignored)_",
    );
  });

  it("composes nothing extra when the request named nobody", () => {
    expect(
      composeGenerateTeamsReply({
        groupPost: "POST",
        includedNames: [],
        pinnedLog: [],
        unmatchedIncludes: [],
        unmatchedPins: [],
      }),
    ).toBe("POST");
    expect(composeBalancerRefusal("match is completed")).toBe(
      "Can't build teams right now — match is completed.",
    );
  });
});

// ── 4. Include, pin and pair ───────────────────────────────────────────

describe("named players are force-confirmed, pinned and paired", () => {
  const INC = "@Match Time generate the teams, Zair is playing";

  it("force-confirms a bench player and says so above the post", async () => {
    const { model } = stubModel({ [INC]: teamsFacts({ includeRefs: ["Zair"] }) });
    const r = recorder(model, world({ confirmed: SQUAD, bench: ["zair"] }));
    const res = await run({ messages: [msg({ body: INC })], deps: r.deps });

    expect(r.confirmed).toEqual([
      { matchId: "match-1", userId: "u-zair", ref: "Zair", actorUserId: "u-kemal" },
    ]);
    expect([...res.outcomes.values()][0].reply).toBe(
      `_Including ${fullName("zair")} as CONFIRMED per the request._\n\n${POST}`,
    );
  });

  it("reports a name it cannot place rather than guessing, in the shipped wording", async () => {
    const { model } = stubModel({ [INC]: teamsFacts({ includeRefs: ["Bazza"] }) });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: INC })], deps: r.deps });
    expect(r.confirmed).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBe(
      `${POST}\n\n_(couldn't find Bazza in the roster — ignored)_`,
    );
    // …and the operator hears about it too. A line only the group sees
    // is a line nobody triages.
    expect(res.degradations.join(" ")).toMatch(/could not place Bazza/);
  });

  it("turns a named side into an absolute pin", async () => {
    const body = "@Match Time regenerate the teams, put David and Kemal together in Red team";
    const { model } = stubModel({
      [body]: teamsFacts({
        swaps: [
          { personRef: "Kemal", team: "RED" },
          { personRef: "Sait", team: "RED" },
        ],
      }),
    });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(r.generated[0].pinnedToTeam).toEqual({ "u-kemal": "RED", "u-sait": "RED" });
    expect([...res.outcomes.values()][0].reply).toBe(
      `_Pinned per the request: ${fullName("kemal")} → RED, ${fullName("sait")} → RED._\n\n${POST}`,
    );
  });

  it("honours a PAIRING by pinning the group to one side, and says which", async () => {
    // The honest bit: `generateTeamsForMatch` takes an absolute colour
    // per player and has no notion of "together", so a pairing becomes
    // "both on RED" — the colour is arbitrary and the constraint the
    // message actually expressed is preserved exactly.
    const body = "@Match Time generate the teams, put me and Sait to the same team";
    const { model } = stubModel({ [body]: teamsFacts({ pairings: [["me", "Sait"]] }) });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(r.generated[0].pinnedToTeam).toEqual({ "u-kemal": "RED", "u-sait": "RED" });
    expect([...res.outcomes.values()][0].reasoning).toMatch(/the colour is arbitrary/);
  });

  it("a pairing inherits the colour of a member the message already pinned by name", async () => {
    const body = "@Match Time generate teams, Sait in yellow and put me with him";
    const { model } = stubModel({
      [body]: teamsFacts({
        swaps: [{ personRef: "Sait", team: "YELLOW" }],
        pairings: [["me", "Sait"]],
      }),
    });
    const r = recorder(model, squadWorld());
    await run({ messages: [msg({ body })], deps: r.deps });
    expect(r.generated[0].pinnedToTeam).toEqual({ "u-sait": "YELLOW", "u-kemal": "YELLOW" });
  });

  it("does not pin a pairing that resolved to only one person", async () => {
    // A group of one constrains nothing; pinning them alone would impose
    // a colour the message never asked for.
    const body = "@Match Time generate teams, me and Bazza together";
    const { model } = stubModel({ [body]: teamsFacts({ pairings: [["me", "Bazza"]] }) });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(r.generated[0].pinnedToTeam).toBeUndefined();
    expect([...res.outcomes.values()][0].reasoning).toMatch(/constrains nothing/);
  });

  it("passes team names through only when the message supplied both", async () => {
    const named = "@Match Time generate the teams as Sharks and Wolves";
    const { model } = stubModel({ [named]: teamsFacts({ teamNames: ["Sharks", "Wolves"] }) });
    const r = recorder(model, squadWorld());
    await run({ messages: [msg({ body: named })], deps: r.deps });
    expect(r.generated[0].teamNames).toEqual(["Sharks", "Wolves"]);
  });

  it("still generates when asked to invent names, under the standard labels", async () => {
    // WHAT WAS LOST: the mega-prompt AUTHORED fun names for "come up
    // with fun team names". The extractor never picks anything, so the
    // request is owned and the teams are built — with the default
    // labels. Losing the joke is not losing the feature.
    const body = "@Match Time generate the teams now, come up with fun team names";
    const { model } = stubModel({ [body]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(r.generated[0].teamNames).toBeUndefined();
    expect([...res.outcomes.values()][0].teamsGenerated).toBe(true);
  });
});

// ── 5. One generate per batch ──────────────────────────────────────────

describe("several generate requests in one window produce ONE team post", () => {
  const A = "@Match Time generate the teams";
  const B = "@Match Time regenerate the teams once more";

  it("fires the LAST one and reacts ⚽ on the earlier ones", async () => {
    const { model } = stubModel({ [A]: teamsFacts(), [B]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({
      messages: [msg({ waMessageId: "wa-a", body: A }), msg({ waMessageId: "wa-b", body: B })],
      deps: r.deps,
    });

    // ONE balancer run, not two.
    expect(r.generated).toHaveLength(1);
    expect(res.ownedIds).toEqual(new Set(["wa-a", "wa-b"]));

    const first = res.outcomes.get("wa-a")!;
    expect(first.reply).toBeNull();
    expect(first.react).toBe("⚽");
    expect(first.intent).toBe("noise");
    expect(first.teamsGenerated).toBe(false);

    const last = res.outcomes.get("wa-b")!;
    expect(last.reply).toBe(POST);
    expect(last.react).toBe("⚽");
    expect(last.intent).toBe("generate_teams_request");
    expect(last.teamsGenerated).toBe(true);
  });

  it("owns the superseded duplicates so nothing else speaks for them", async () => {
    // If the earlier ones were merely handed back, `route.ts`'s
    // catch-all would raise an operator note for a message the batch
    // handled perfectly well.
    const { model } = stubModel({ [A]: teamsFacts(), [B]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({
      messages: [msg({ waMessageId: "wa-a", body: A }), msg({ waMessageId: "wa-b", body: B })],
      deps: r.deps,
    });
    expect(res.outcomes.get("wa-a")!.reasoning).toMatch(/earlier duplicate/);
  });

  it("does not treat a LONE request as a superseded duplicate", async () => {
    // The one-message case asserted from the other side, so the slice
    // arithmetic cannot be off by one without a failure here.
    const { model } = stubModel({ [A]: teamsFacts() });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ waMessageId: "wa-a", body: A })], deps: r.deps });
    expect(res.outcomes.get("wa-a")!.teamsGenerated).toBe(true);
    expect(res.outcomes.get("wa-a")!.intent).toBe("generate_teams_request");
    expect(r.generated).toHaveLength(1);
  });

  it("does not look the match up at all when nothing will fire", async () => {
    // A `show` in the window is handed on before the selector is
    // reached, so a batch this module owns nothing in costs no query.
    const lookup = vi.fn(async () => ({ id: "match-1" }));
    const { model } = stubModel({ [SHOW_BODY]: teamsFacts({ action: "show" }) });
    const r = recorder(model, squadWorld(), { selectTeamsMatch: lookup });
    await run({ messages: [msg({ body: SHOW_BODY })], deps: r.deps });
    expect(lookup).not.toHaveBeenCalled();
  });
});

// ── 6. What it refuses to own ──────────────────────────────────────────

describe("actions this module does not own are handed on, with a reason", () => {
  const SHOW = "@Match Time show the teams";

  it("does not own `show` — that is answer-batch.ts's, on the same route", async () => {
    const { model } = stubModel({ [SHOW]: teamsFacts({ action: "show" }) });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: SHOW })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.generated).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/answer-batch\.ts owns show/);
  });

  it("does not own `swap` — route.ts's deterministic pre-peel already does", async () => {
    const body = "@Match Time swap Kemal and Sait";
    const { model } = stubModel({
      [body]: teamsFacts({ action: "swap", swaps: [{ personRef: "Kemal", team: "YELLOW" }] }),
    });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.generated).toEqual([]);
  });

  it("does not own `rename` — regenerating over a manual swap is c408649", async () => {
    const body = "@Match Time rename the teams to Sharks and Wolves";
    const { model } = stubModel({
      [body]: teamsFacts({ action: "rename", teamNames: ["Sharks", "Wolves"] }),
    });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.generated).toEqual([]);
  });

  it("hands back facts of the wrong shape entirely", async () => {
    const { model } = stubModel({ [GEN]: { first: 5, second: 3 } });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.generated).toEqual([]);
  });
});

// ── 7. The org gate ────────────────────────────────────────────────────

describe("team balancing off for the org means silence, owned", () => {
  it("owns the message, says nothing, and spends no model call", async () => {
    // `route.ts:3113-3128` returns `{react: null, reply: null}`. Owning
    // that silence stops the catch-all raising an operator note about a
    // feature an admin deliberately turned off.
    const { model, calls } = stubModel({});
    const r = recorder(model, squadWorld(), {
      loadFeatures: async () => ({ ...FEATURES_ON, teamBalancing: false }),
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(1);
    expect(calls).toEqual([]);
    expect(r.generated).toEqual([]);
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBeNull();
    expect(out.react).toBeNull();
    expect(out.action).toBe("none");
    expect(out.reasoning).toMatch(/team balancing is off/);
  });
});

// ── 8. Fail open, every way it can ─────────────────────────────────────

describe("every failure leaves the teams alone and says why", () => {
  it("a state load that throws owns nothing", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), {
      loadState: async () => {
        throw new Error("pg is down");
      },
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/state load failed.*pg is down/);
  });

  it("a feature load that throws owns nothing", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), {
      loadFeatures: async () => {
        throw new Error("no org row");
      },
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/feature load failed/);
  });

  it("an extractor that throws hands THAT message on, carrying the reason", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() }, { throwOn: "generate the teams" });
    const r = recorder(model, squadWorld());
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.generated).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/529 Overloaded/);
    expect(res.degradations.join(" ")).toMatch(/nothing was said/);
  });

  it("a match lookup that throws stays SILENT rather than claiming no match", async () => {
    // Saying "No match lined up to build teams for." over a database
    // error is a confident claim nothing checked.
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), {
      selectTeamsMatch: async () => {
        throw new Error("timeout");
      },
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/match lookup failed.*timeout/);
  });

  it("an engine that throws owns nothing rather than 500ing the request", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), {
      decide: () => {
        throw new Error("coverage violation");
      },
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/the engine threw.*coverage violation/);
  });

  it("refuses the WHOLE batch if the engine proposes a write this path cannot apply", async () => {
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const fake: EngineResult = {
      outcomes: [
        { messageId: "wa-x", route: "balancer", disposition: "acted", reasons: [], writes: [], react: null },
      ],
      writes: [
        {
          kind: "attendance",
          userId: "u-kemal",
          name: fullName("kemal"),
          status: "CONFIRMED",
          explicitBench: false,
          promote: false,
          sourceMessageId: "wa-x",
          reason: "smuggled",
        },
      ],
      nextState: squadWorld(),
      speech: [],
      degradations: [],
    };
    const r = recorder(model, squadWorld(), { decide: () => fake });
    const res = await run({ messages: [msg({ waMessageId: "wa-x", body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/cannot apply \(attendance\)/);
  });

  it("owns nothing rather than going silent if the engine proposes NO write", async () => {
    // Unreachable today: `handleTeams` emits unconditionally for a
    // tagged `generate`. Asserted anyway — "message understood, action
    // silently not taken" is this product's signature failure, and
    // "unreachable" is what the comments on four dead seatbelts said.
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const silent: EngineResult = {
      outcomes: [
        {
          messageId: "wa-x",
          route: "balancer",
          disposition: "noop",
          reasons: [],
          writes: [],
          react: null,
        },
      ],
      writes: [],
      nextState: squadWorld(),
      speech: [],
      degradations: [],
    };
    const r = recorder(model, squadWorld(), { decide: () => silent });
    const res = await run({ messages: [msg({ waMessageId: "wa-x", body: GEN })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.generated).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/engine proposed no write/);
  });

  it("says NOTHING at all when the balancer write throws (§3.2 S7)", async () => {
    // The 2026-05-15 Erdal incident in a different corner: announcing
    // teams the database never got.
    const { model } = stubModel({ [GEN]: teamsFacts() });
    const r = recorder(model, squadWorld(), {
      generateTeams: async () => {
        throw new Error("deadlock detected");
      },
    });
    const res = await run({ messages: [msg({ body: GEN })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBeNull();
    expect(out.react).toBeNull();
    expect(out.writeFailed).toBe(true);
    expect(out.action).toBe("none");
    expect(res.degradations.join(" ")).toMatch(/deadlock detected.*NOTHING was posted/);
  });

  it("says nothing when a force-include throws, rather than posting teams without them", async () => {
    // Posting line-ups that silently omit the player the message was
    // ABOUT is the failure this ordering exists to avoid.
    const body = "@Match Time generate the teams, Zair is playing";
    const { model } = stubModel({ [body]: teamsFacts({ includeRefs: ["Zair"] }) });
    const r = recorder(model, world({ confirmed: SQUAD, bench: ["zair"] }), {
      forceConfirm: async () => {
        throw new Error("row vanished");
      },
    });
    const res = await run({ messages: [msg({ body })], deps: r.deps });
    expect(r.generated).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBeNull();
    expect([...res.outcomes.values()][0].writeFailed).toBe(true);
  });
});

// ── 9. The operator's view ─────────────────────────────────────────────

describe("describeTeamOpsBatch", () => {
  it("reports the degradations even when nothing at all was owned", async () => {
    const { warns, info } = describeTeamOpsBatch(
      {
        ownedIds: new Set(),
        outcomes: new Map(),
        generatedMatchId: null,
        degradations: ["extractor died"],
        cost: { usd: 0, calls: 0, ms: 3 },
      },
      3,
    );
    expect(info).toMatch(/decided 0\/3/);
    expect(warns).toEqual(["[analyze] team-ops-engine degraded: extractor died"]);
  });

  it("is silent when there is nothing to say", () => {
    const { warns, info } = describeTeamOpsBatch(
      {
        ownedIds: new Set(),
        outcomes: new Map(),
        generatedMatchId: null,
        degradations: [],
        cost: { usd: 0, calls: 0, ms: 0 },
      },
      3,
    );
    expect(info).toBeNull();
    expect(warns).toEqual([]);
  });
});

// ── 10. The apply layer touches no database of its own ─────────────────

describe("the apply layer's dependencies are injected, asserted by scanning it", () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, "..", "team-ops-engine.ts"), "utf8");

  it("imports neither db nor Prisma", () => {
    expect(SRC).not.toMatch(/from ["']\.\/db["']/);
    expect(SRC).not.toMatch(/@prisma\/client/);
    expect(SRC).not.toMatch(/\bdb\s*\./);
  });

  it("does not reach for the balancer directly — it is injected", () => {
    // `team-generation.ts` imports Prisma. A static import here would
    // pull the client into a module the corpus loads from a worker that
    // must not have it.
    expect(SRC).not.toMatch(/from ["']\.\/team-generation["']/);
    expect(SRC).toMatch(/generateTeams:/);
  });
});
