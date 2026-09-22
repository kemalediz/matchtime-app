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
import {
  MIN_CACHEABLE_TOKENS,
  ROUTER_MODEL,
  estimateTokens,
  type PipelineModel,
  type ModelResponse,
} from "../llm";

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
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // "+1" offers a GUEST, not the sender, so the floor must not claim
    // it: routing it self_att loses the guest and bypasses PR #29's
    // name-ask on the commonest way to offer one.
    "+1",
    "+2",
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
  // ⚠️ THE SIZE CEILING MOVED ON 2026-09-11, AND IT IS NOT A TASTE
  // CHANGE. §6.1's "its size is the argument" was tested as
  // `length < 2600`, which is a character count standing in for a
  // measurement nobody had made. `MDs/router-accuracy-2026-09-11.md`
  // made it: the 2,501-character prompt reached 83.3% owner accuracy
  // over 1,748 real messages, and the rewrite reached 91%+ for
  // $0.41/month more. Small was never the goal — cheap and right was.
  //
  // What replaces it is a bound that means something. Every token of
  // this prompt is paid on every call, because it sits under Haiku
  // 4.5's 4,096-token minimum cacheable prefix and therefore never
  // caches (`__tests__/cache-threshold.test.ts` pins that, and §1.5
  // probed it). So the ceiling IS the cache minimum: cross it and the
  // per-batch cost stops being a rounding error, and the honest fix is
  // to pass ~15,500 characters so it genuinely caches rather than to
  // creep up to it.
  it("stays under the minimum cacheable prefix, so every token is one we pay knowingly", () => {
    expect(estimateTokens(ROUTER_SYSTEM_PROMPT)).toBeLessThan(
      MIN_CACHEABLE_TOKENS[ROUTER_MODEL]!,
    );
  });

  it("carries the bias-toward-action rule", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/in doubt/i);
  });

  it("names every route it can emit", () => {
    for (const r of ["none", "self_att", "other_att", "offer", "question", "balancer", "score", "admin_ops", "unsure"]) {
      expect(ROUTER_SYSTEM_PROMPT, r).toContain(r);
    }
  });

  // ── The prompt TEACHES routes. A route it teaches that this file
  //    cannot parse is a silent degradation on every batch that copies
  //    it, so the worked examples are checked against the parser rather
  //    than read. This is the one property of the prompt's wording that
  //    is a behaviour and not a preference.
  it("never teaches a route the parser would reject", () => {
    const taught = [...ROUTER_SYSTEM_PROMPT.matchAll(/->\s*([a-z_]+)\s*$/gm)].map((m) => m[1]!);
    expect(taught.length).toBeGreaterThan(20);
    for (const route of taught) {
      expect(normaliseRoute(route), `worked example teaches "${route}"`).not.toBeNull();
    }
  });

  it("teaches the asker's own stats request as a question, in both languages (2026-09-17)", () => {
    // `STATS_REQUEST` used to catch these before the router ran. Without
    // a worked example, "@Match Time wrapped" routed `none` 3 of 3 live.
    for (const body of ["@Match Time my stats", "@Match Time wrapped", "@Match Time istatistiklerim"]) {
      const line = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.trim().startsWith(`"${body}"`));
      expect(line, body).toBeDefined();
      expect(line!).toMatch(/->\s*question\s*$/);
    }
  });

  // ── THE 2026-09-22 REPLACEMENT RULES ──────────────────────────────
  //
  // "Hi guys, Mojib is replacing Najib on the list. We can change" went
  // to `none`. These pin the worked examples that were added for it,
  // AND the direction of the change: rule 18 and its examples only ever
  // push a message TOWARDS attendance. That is what makes them safe for
  // the veto metric (attendance-routed-`none` must stay at 0 over the
  // 373-message gold corpus) without a live run: nothing was added that
  // could teach `none`, and no existing example moved.
  it("teaches every replacement shape as attendance, in both languages", () => {
    for (const body of [
      "Hi guys, Mojib is replacing Najib on the list. We can change",
      "Amir in for Zeeshan",
      "Najib is out, Mojib is in",
      "Zair takes Abid's place tonight",
      "Mojib, Najib'in yerine geliyor",
      "Najib çıkıyor, Mojib giriyor",
    ]) {
      const line = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.trim().startsWith(`"${body}"`));
      expect(line, body).toBeDefined();
      expect(line!, body).toMatch(/->\s*other_att\s*$/);
    }
  });

  it("states the replacement rule itself, and never as a reason to stay quiet", () => {
    const rule = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("18."));
    expect(rule).toBeDefined();
    expect(rule!).toMatch(/replacing/i);
    expect(rule!).toMatch(/other_att/);
    // The one property that protects the veto: this rule cannot send
    // anything to `none`.
    expect(rule!).not.toMatch(/\bnone\b/);
  });

  it("demands an output shape this file actually parses", () => {
    // The last line of the prompt is the contract between the model and
    // `parseRouterResponse`. Pull it out, fill it in, and run it through
    // the parser: if someone renames a field in the prompt, every batch
    // degrades to `unsure` and nothing else in this suite would notice.
    const line = ROUTER_SYSTEM_PROMPT.trimEnd().split("\n").at(-1)!;
    expect(line).toMatch(/^Return JSON only:/);
    const shape = line.slice(line.indexOf("{"));
    const filled = shape.replace("<id>", "wa-1").replace("<route>", "other_att");
    const out = parseRouterResponse(filled, ["wa-1"]);
    expect(out.routes).toEqual([{ messageId: "wa-1", route: "other_att", source: "model" }]);
    expect(out.degradations).toEqual([]);
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

// ── Turkish (2026-09-16): Erdal's group reads and writes in Turkish ────
//
// `MDs/second-group-readiness-erdal-2026-09-16.md` §2 measured the live
// router on the bare Turkish forms: "yokum" routed `none` 10 of 10,
// "yok" 10 of 10, "var" registered 0 of 10. Those are the Turkish "in"
// and "out" — the single most common attendance messages a group sends —
// and they were lost silently, exactly the failure the floor exists for.
// The floor's vocabulary grows; its flag, its shape and its one-way
// property do not.
describe("the floor reads the bare Turkish forms, same shape as the English ones", () => {
  it.each([
    ["var", "self_att"],
    ["Var", "self_att"],
    ["VAR", "self_att"],
    ["var.", "self_att"],
    ["varım", "self_att"],
    ["Varım", "self_att"],
    ["VARIM", "self_att"],
    ["varim", "self_att"],
    ["ben varım", "self_att"],
    ["Ben varım 👍", "self_att"],
    ["yok", "self_att"],
    ["Yok.", "self_att"],
    ["yokum", "self_att"],
    ["ben yokum", "self_att"],
    ["gelemiyorum", "self_att"],
    ["Gelemiyorum 😔", "self_att"],
    // The mention half: a tagged person plus a bare Turkish token.
    ["@Ali var", "other_att"],
    ["@Ali Yok", "other_att"],
    ["@Ali Veli yok", "other_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // Anything beyond the bare token is a sentence and goes to the model.
    "var mı?",
    "varım ama geç kalırım",
    "yok artık",
    "bir şey yok",
    "top var mı bugün",
    "varsa gelirim",
    "bu hafta yokum",
    "belki",
    "bakarız",
    "kesin değil",
    // A mention of the bot is never a player.
    "@Match Time var",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

describe("the router prompt reads Turkish", () => {
  it("says a message may be Turkish, and that a bare var/yok is attendance like a bare in/out", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/Turkish/);
    for (const w of ["var", "yok", "varım", "yokum"]) {
      expect(ROUTER_SYSTEM_PROMPT, w).toContain(`"${w}"`);
    }
  });

  it("teaches the seven Turkish shapes as worked examples, in the block the router copies from", () => {
    const taught = new Map(
      [...ROUTER_SYSTEM_PROMPT.matchAll(/^\s*"([^"]+)"\s+->\s*([a-z_]+)\s*$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    // bare IN and OUT forms
    expect(taught.get("var")).toBe("self_att");
    expect(taught.get("yokum")).toBe("self_att");
    // a hedge
    expect(taught.get("belki")).toBe("offer");
    // a relayed third-party IN and a third-party OUT
    expect(taught.get("Ali de geliyor")).toBe("other_att");
    expect(taught.get("Mehmet gelemiyor")).toBe("other_att");
    // a question
    expect(taught.get("kaç kişiyiz?")).toBe("question");
    // banter
    expect(
      [...taught.entries()].some(([body, route]) => /hadi|maç|😂/.test(body) && route === "none"),
    ).toBe(true);
  });
});
