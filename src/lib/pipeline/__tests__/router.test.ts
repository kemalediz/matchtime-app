/**
 * STAGE 1 — the router, and the deterministic floor under it.
 *
 * §11.1 names router misclassification as the biggest risk in the whole
 * design AND a genuine regression: "a message routed `none` disappears
 * silently — no write, no reply, no reaction, no signal. Today the
 * mega-call at least emits SOMETHING for every message."
 *
 * Three containments are tested here. The fourth (a frozen eval set) is
 * `e2e/corpus`, which runs the real model.
 */
import { describe, it, expect } from "vitest";
import {
  ROUTER_SYSTEM_PROMPT,
  normaliseRoute,
  parseRouterResponse,
  routeFloor,
  routeBatch,
} from "../router";
import type { PipelineModel, ModelResponse } from "../llm";

function fakeModel(responses: string[] | ((n: number) => string)): PipelineModel & {
  calls: Array<{ system: string; user: string; maxTokens: number }>;
} {
  const calls: Array<{ system: string; user: string; maxTokens: number }> = [];
  let i = 0;
  return {
    name: "fake",
    calls,
    async complete(req): Promise<ModelResponse> {
      calls.push({ system: req.system, user: req.user, maxTokens: req.maxTokens });
      const text = typeof responses === "function" ? responses(i) : (responses[i] ?? responses[responses.length - 1]);
      i++;
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 5,
      };
    },
  };
}

// ── The deterministic floor (§11.1) ────────────────────────────────────

describe("the regex floor — built new, because the old one was deleted", () => {
  // ⚠️ §11.1 corrects its own first draft: the regex fast path CANNOT
  // serve as this floor, because it was deleted on 2026-04-21 and
  // handlers.ts:7-10 records that "Kemal explicitly asked for this". So
  // the floor is built new, deliberately TINY, and it force-routes
  // regardless of what the router says.
  it.each([
    ["in", "self_att"],
    ["IN", "self_att"],
    ["In 👍", "self_att"],
    ["i'm in", "self_att"],
    ["im in", "self_att"],
    ["I am in", "self_att"],
    ["out", "self_att"],
    ["OUT", "self_att"],
    ["i'm out", "self_att"],
    ["+1", "self_att"],
    ["+2", "self_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    "Zeeshan is out 😂😂 vote him out lads",
    "anyone watching the derby tonight",
    "my brother can play if needed",
    "I was in last week and nobody added me",
    "we're in trouble lads",
    "@Match Time who's on the bench?",
    "in the end we lost",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

// ── Parsing and normalisation ──────────────────────────────────────────

describe("normaliseRoute", () => {
  it("accepts the nine routes", () => {
    expect(normaliseRoute("self_att")).toBe("self_att");
    expect(normaliseRoute("NONE")).toBe("none");
  });

  it("maps the `lineup_ops` alias onto other_att", () => {
    // §6.1's unfixed prototype failure: "move Mustafa to the bench, keep
    // Idris in" routed `team_ops` 3/3 because "bench" reads as
    // team-shaped vocabulary. We rename team_ops → balancer AND accept
    // lineup_ops as an alias, so roster surgery has somewhere natural to
    // land without creating a second attendance path in the engine.
    expect(normaliseRoute("lineup_ops")).toBe("other_att");
    expect(normaliseRoute("team_ops")).toBe("balancer");
  });

  it("returns null for a route the model invented", () => {
    expect(normaliseRoute("attendance_change")).toBeNull();
  });
});

describe("parseRouterResponse", () => {
  it("parses the documented shape", () => {
    const out = parseRouterResponse('{"routes":[{"id":"wa-1","route":"none"}]}', ["wa-1"]);
    expect(out.routes).toEqual([{ messageId: "wa-1", route: "none", source: "model" }]);
    expect(out.degradations).toHaveLength(0);
  });

  it("survives markdown fences and preamble", () => {
    const out = parseRouterResponse(
      'Here you go:\n```json\n{"routes":[{"id":"wa-1","route":"self_att"}]}\n```',
      ["wa-1"],
    );
    expect(out.routes[0].route).toBe("self_att");
  });

  it("fills a MISSING id with `unsure`, never `none`, and says so", () => {
    // The asymmetry §11.1 demands, built in rather than hoped for: a
    // false positive costs one extractor call (~$0.002) that returns no
    // claims; a false negative costs a player their slot.
    const out = parseRouterResponse('{"routes":[{"id":"wa-1","route":"none"}]}', ["wa-1", "wa-2"]);
    expect(out.routes).toHaveLength(2);
    expect(out.routes[1]).toMatchObject({ messageId: "wa-2", route: "unsure", source: "fallback" });
    expect(out.degradations[0].detail).toMatch(/no route/i);
  });

  it("drops an id the model invented", () => {
    const out = parseRouterResponse(
      '{"routes":[{"id":"wa-1","route":"none"},{"id":"ghost","route":"score"}]}',
      ["wa-1"],
    );
    expect(out.routes).toHaveLength(1);
    expect(out.degradations.some((d) => /unknown id/i.test(d.detail))).toBe(true);
  });

  it("falls back to `unsure` on unparseable output, and never throws", () => {
    const out = parseRouterResponse("the model said something else entirely", ["wa-1", "wa-2"]);
    expect(out.routes.map((r) => r.route)).toEqual(["unsure", "unsure"]);
    expect(out.degradations.length).toBeGreaterThan(0);
  });
});

// ── The prompt itself ──────────────────────────────────────────────────

describe("the router prompt", () => {
  it("is small — its size is the argument (§6.1)", () => {
    // ~360 tokens in the proposal. A generous character ceiling keeps
    // this honest without pinning the wording.
    expect(ROUTER_SYSTEM_PROMPT.length).toBeLessThan(2600);
  });

  it("carries the bias-toward-action rule", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/in doubt/i);
  });

  it("names every route it can emit", () => {
    for (const r of ["none", "self_att", "other_att", "offer", "question", "balancer", "score", "admin_ops", "unsure"]) {
      expect(ROUTER_SYSTEM_PROMPT, r).toContain(r);
    }
  });
});

// ── The batch call ─────────────────────────────────────────────────────

describe("routeBatch", () => {
  const msgs = [
    { id: "wa-1", authorName: "Ayoub", body: "😂😂😂" },
    { id: "wa-2", authorName: "Najib", body: "In" },
  ];

  it("routes a batch in ONE call and lets the floor override the model", async () => {
    const model = fakeModel(['{"routes":[{"id":"wa-1","route":"none"},{"id":"wa-2","route":"none"}]}']);
    const out = await routeBatch(model, msgs);
    expect(model.calls).toHaveLength(1);
    expect(out.routes[0]).toMatchObject({ route: "none", source: "model" });
    // "In" is bare self-attendance. The router said banter; the floor
    // wins, because losing that is losing a player's slot.
    expect(out.routes[1]).toMatchObject({ route: "self_att", source: "floor" });
    expect(out.degradations.some((d) => /floor overrode/i.test(d.detail))).toBe(true);
  });

  it("routes EVERYTHING to the attendance extractor when the model throws (§11.4)", async () => {
    const model: PipelineModel = {
      name: "broken",
      async complete() {
        throw new Error("router timeout");
      },
    };
    const out = await routeBatch(model, msgs);
    expect(out.routes.map((r) => r.route)).toEqual(["unsure", "self_att"]);
    expect(out.degradations[0].detail).toMatch(/router timeout/);
  });

  it("caps max_tokens well below the SDK's non-streaming limit", async () => {
    const model = fakeModel(['{"routes":[]}']);
    await routeBatch(model, msgs);
    expect(model.calls[0].maxTokens).toBeLessThanOrEqual(16_384);
  });

  it("never calls the model at all when every message hits the floor", async () => {
    const model = fakeModel(['{"routes":[]}']);
    const out = await routeBatch(model, [
      { id: "wa-1", authorName: "Najib", body: "in" },
      { id: "wa-2", authorName: "Zair", body: "out" },
    ]);
    expect(model.calls).toHaveLength(0);
    expect(out.routes.every((r) => r.source === "floor")).toBe(true);
  });
});

// ── Found by the first live corpus sweep (2026-09-01) ──────────────────

describe("the mention floor — a tagged person plus a bare IN/OUT", () => {
  // §11.1 in its purest form: `@Ehtisham Ul Haq In` routed `none` on the
  // live corpus, so a real third-party registration disappeared with no
  // write, no reply and no signal. It is the same shape as the bare
  // self-attendance floor — a mention and a token, nothing else — so it
  // gets the same treatment, one route along.
  it.each([
    ["@Ehtisham Ul Haq In", "other_att"],
    ["@Najib in", "other_att"],
    ["@Zair Malik out", "other_att"],
    ["@Faris Nasser IN 👍", "other_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // A tagged bot is never a player. Without this, "@Match Time in"
    // would try to register a member called "Match Time" — the ghost
    // user class of bug, one layer up.
    "@Match Time in",
    "@MatchTime out",
    // Not a bare declaration: anything past the token is a sentence.
    "@Zair Malik is in if we're short",
    "@all we need more players pls",
    "@Kemal Ediz my brother can play if needed",
    "@Match Time who's on the bench?",
    "@Ehtisham Ul Haq is replacing @Elnur Mammadov",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

describe("router prompt rules added after the live sweep", () => {
  it("tells the router that a reposted roster is not a team sheet", () => {
    // Live corpus: a 14-name numbered list (S26's reposted roster) routed
    // `balancer`, so the tag gate refused it as a team op and two real
    // registrations were lost.
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/list of players|roster/i);
  });

  it("tells the router that an @mention with in/out is other_att", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/@-?mention|mention/i);
  });
});
