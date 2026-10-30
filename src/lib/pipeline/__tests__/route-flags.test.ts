/**
 * §10 STEP 7 — "revert: per-route flag", asserted rather than asserted-in-prose.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE DEFAULT INVERTED ON 2026-09-06 (§10 STEP 8), AND THAT IS THE
 * POINT OF MOST OF THIS FILE
 * ─────────────────────────────────────────────────────────────────────
 *
 * Property 1 used to read: "DEFAULT OFF. Step 6's flag test exists
 * because a flag that defaults on is a production change disguised as a
 * refactor." That was right while an unowned route fell back to the
 * 19,850-token mega-prompt, which answered it. Step 8 deletes the
 * mega-prompt. Default-off would now mean MatchTime answers no question,
 * records no score and credits no payment — it would go silent on four
 * of its nine routes and call it a safe default.
 *
 * So the four routes are ON unless a flag EXPLICITLY says otherwise, and
 * the strictness moves with the default: only `0`, `false`, `no` and
 * `off` take a route off the air. A typo in a Vercel env var must not
 * silently stop MatchTime replying, which is the exact mirror of the
 * rule these flags shipped with.
 *
 * The three properties this file proves are otherwise unchanged:
 *
 *   1. DEFAULT ON, AND ONLY AN EXPLICIT OFF SPELLING TURNS A ROUTE OFF.
 *      An unrecognised value leaves the route ON — the direction that
 *      cannot lose a reply.
 *   2. INDEPENDENCE. Four routes need the property pairwise: reverting
 *      the money must not revert the reads. A shared spelling helper
 *      would not give it — a loosened spelling would loosen all of them
 *      at once — so `route-flags.ts` keeps a deliberate copy of
 *      `gate.ts`'s and the two are cross-checked below.
 *   3. A FLAG ONLY EXISTS ONCE IT OWNS ITS ROUTE. Part 1 kept
 *      `SCORE_ENGINE_ENABLED` and `ADMIN_OPS_ENGINE_ENABLED` as reserved
 *      names nothing read; part 2 honours them because
 *      `score-engine-batch.ts` and `admin-ops-engine-batch.ts` exist.
 *      The tests below assert both halves: the reserved SPELLINGS were
 *      the ones adopted, and each flag turns off exactly its own route.
 *
 * WHAT IS NO LONGER ASSERTABLE: step 5's and step 6's flags are deleted
 * (`gate.ts` carries the argument), so "they cannot turn a step-7 route
 * on" is now a statement about two names nothing reads. It is kept as
 * "an unrelated env var changes nothing", which is the surviving half.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { isNoneBucketShadowEnabled, routerIsNeeded } from "../gate";
import {
  ADMIN_OPS_ENGINE_ROUTES,
  ADMIN_OPS_FLAG,
  ALL_TEAM_ACTIONS,
  ANSWER_ENGINE_ROUTES,
  ANSWER_TEAM_ACTIONS,
  BALANCER_FLAG,
  QUESTION_FLAG,
  SCORE_ENGINE_ROUTES,
  SCORE_FLAG,
  STEP_SEVEN_HEADER,
  STEP_SEVEN_ROUTES,
  TEAM_OPS_ENGINE_ROUTES,
  TEAM_OPS_FLAG,
  TEAM_OPS_TEAM_ACTIONS,
  enabledStepSevenRoutes,
  routesHeaderOverride,
  stepSevenNeedsRouter,
  stepSevenOwnsRoute,
  type TeamAction,
} from "../route-flags";
import type { Route, TeamFacts } from "../types";

/** The ONLY four spellings that take a route off the air, plus the
 *  casing and padding variants the reader is expected to tolerate. */
const OFF = ["0", "false", "no", "off", "OFF", " False ", "NO"];

/**
 * Everything else. Unset, empty, a typo, a value that looks like it
 * means something — every one of these leaves the route ON.
 *
 * `"maybe"`, `"disabled"` and `"2"` are the load-bearing entries: they
 * are what a mistyped env var looks like, and after §10 step 8 the
 * failure they would cause is MatchTime silently not replying to a
 * question or not recording a score, with no error anywhere.
 */
const ON = [
  undefined,
  "",
  " ",
  "1",
  "true",
  "yes",
  "on",
  "ON",
  " Yes ",
  "TRUE",
  "maybe",
  "yes please",
  "disabled",
  "enabled",
  "2",
  "-1",
  "null",
];

const ALL_FOUR: Route[] = ["question", "balancer", "score", "admin_ops"];
const sorted = (routes: Iterable<Route>) => [...routes].sort();

describe("step 7 per-route flags", () => {
  it("owns ALL FOUR routes with an empty environment", () => {
    // THE INVERSION, stated first because it is the whole change. Before
    // §10 step 8 this asserted `[]`, and that was correct while an
    // unowned route fell through to the mega-prompt. With the
    // mega-prompt deleted, owning nothing means answering nothing.
    expect(sorted(enabledStepSevenRoutes({}))).toEqual(sorted(ALL_FOUR));
    expect(stepSevenNeedsRouter(enabledStepSevenRoutes({}))).toBe(true);
  });

  it("owns all four when the process environment is whatever it happens to be", () => {
    // The real `process.env` of a dev machine or CI runner. If this ever
    // starts returning FEWER than four, something has put a step-7 flag
    // into a shell profile or a .env that the test suite inherits — and
    // after step 8 that accident is silence rather than a bigger bill.
    expect(sorted(enabledStepSevenRoutes())).toEqual(sorted(ALL_FOUR));
  });

  it.each(OFF)("QUESTION_ENGINE_ENABLED=%s turns OFF `question` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [QUESTION_FLAG]: v });
    expect(sorted(routes)).toEqual(sorted(["balancer", "score", "admin_ops"]));
    expect(stepSevenOwnsRoute("question", routes)).toBe(false);
    expect(stepSevenOwnsRoute("balancer", routes)).toBe(true);
  });

  it.each(ON)("QUESTION_ENGINE_ENABLED=%s leaves it ON", (v) => {
    expect(sorted(enabledStepSevenRoutes({ [QUESTION_FLAG]: v }))).toEqual(sorted(ALL_FOUR));
  });

  it.each(OFF)("BALANCER_ENGINE_ENABLED=%s turns OFF `balancer` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [BALANCER_FLAG]: v });
    expect(sorted(routes)).toEqual(sorted(["question", "score", "admin_ops"]));
    expect(stepSevenOwnsRoute("balancer", routes)).toBe(false);
    expect(stepSevenOwnsRoute("question", routes)).toBe(true);
  });

  it.each(ON)("BALANCER_ENGINE_ENABLED=%s leaves it ON", (v) => {
    expect(sorted(enabledStepSevenRoutes({ [BALANCER_FLAG]: v }))).toEqual(sorted(ALL_FOUR));
  });

  it("AN UNRECOGNISED VALUE LEAVES THE ROUTE ON — the direction that cannot lose a reply", () => {
    // The single most important case in this file after the inversion.
    // `QUESTION_ENGINE_ENABLED=fasle` is a typo somebody makes at 11pm
    // in a Vercel dashboard; if it read as OFF, MatchTime would stop
    // answering questions with no error, no log and nothing in any
    // dashboard — the same invisible-failure shape as the max_tokens
    // bug that shipped three times.
    //
    // NOTE what is NOT in this list: `"0 "`. Both readers `.trim()`, so
    // padding is not a typo, it is whitespace — `" False "` is in OFF
    // for the same reason.
    for (const typo of ["fasle", "of", "nope", "disabled", "FALSE!", "n", "0x0"]) {
      expect(
        sorted(enabledStepSevenRoutes({ [QUESTION_FLAG]: typo })),
        `"${typo}" must not take a route off the air`,
      ).toEqual(sorted(ALL_FOUR));
    }
  });

  it("the two flags are independent in both directions", () => {
    expect(sorted(enabledStepSevenRoutes({ [QUESTION_FLAG]: "0", [BALANCER_FLAG]: "1" }))).toEqual(
      sorted(["balancer", "score", "admin_ops"]),
    );
    expect(sorted(enabledStepSevenRoutes({ [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "0" }))).toEqual(
      sorted(["question", "score", "admin_ops"]),
    );
    expect(sorted(enabledStepSevenRoutes({ [QUESTION_FLAG]: "0", [BALANCER_FLAG]: "0" }))).toEqual(
      sorted(["score", "admin_ops"]),
    );
  });

  it("an unrelated env var changes nothing", () => {
    // This case used to read "step 5 and step 6's flags cannot turn a
    // step-7 route on", with `ROUTER_GATE_ENABLED` and
    // `ATTENDANCE_ENGINE_ENABLED` as the two names. Both flags are
    // DELETED (`gate.ts` carries the argument for why an off position
    // with no implementation is worse than no flag), so those names are
    // now just strings nothing reads — which is exactly what this
    // asserts, alongside a name that never meant anything at all.
    expect(
      sorted(
        enabledStepSevenRoutes({
          ROUTER_GATE_ENABLED: "0",
          ATTENDANCE_ENGINE_ENABLED: "0",
          QUESTION_ENGINE_ENABLE: "0",
          NODE_ENV: "production",
        }),
      ),
    ).toEqual(sorted(ALL_FOUR));
  });

  it("a step-7 flag cannot turn the none-bucket sweep on", () => {
    const env = { [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "1" };
    expect(isNoneBucketShadowEnabled(env)).toBe(false);
  });

  it("its OFF spellings and gate.ts's ON spellings are DISJOINT, so neither can drift", () => {
    // The two readers are deliberate copies of one another, inverted.
    // `gate.ts`'s `on()` accepts 1/true/yes/on for two flags that
    // default OFF; this file's `off()` accepts 0/false/no/off for four
    // that default ON. Each direction is the one that cannot lose
    // anything for the flag it guards, and the cross-check is that no
    // single value can be read as "affirmative" by both — which is what
    // a copied-then-edited helper would produce.
    for (const v of OFF) {
      expect(isNoneBucketShadowEnabled({ NONE_BUCKET_SHADOW_ENABLED: v })).toBe(false);
      expect(enabledStepSevenRoutes({ [QUESTION_FLAG]: v }).has("question")).toBe(false);
    }
    for (const v of ["1", "true", "yes", "on", "ON", " Yes ", "TRUE"]) {
      expect(isNoneBucketShadowEnabled({ NONE_BUCKET_SHADOW_ENABLED: v })).toBe(true);
      expect(enabledStepSevenRoutes({ [QUESTION_FLAG]: v }).has("question")).toBe(true);
    }
  });

  it.each(OFF)("SCORE_ENGINE_ENABLED=%s turns OFF `score` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [SCORE_FLAG]: v });
    expect(sorted(routes)).toEqual(sorted(["question", "balancer", "admin_ops"]));
    expect(stepSevenOwnsRoute("score", routes, SCORE_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("admin_ops", routes, ADMIN_OPS_ENGINE_ROUTES)).toBe(true);
  });

  it.each(ON)("SCORE_ENGINE_ENABLED=%s leaves it ON", (v) => {
    expect(sorted(enabledStepSevenRoutes({ [SCORE_FLAG]: v }))).toEqual(sorted(ALL_FOUR));
  });

  it.each(OFF)("ADMIN_OPS_ENGINE_ENABLED=%s turns OFF `admin_ops` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [ADMIN_OPS_FLAG]: v });
    expect(sorted(routes)).toEqual(sorted(["question", "balancer", "score"]));
    expect(stepSevenOwnsRoute("admin_ops", routes, ADMIN_OPS_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("score", routes, SCORE_ENGINE_ROUTES)).toBe(true);
  });

  it.each(ON)("ADMIN_OPS_ENGINE_ENABLED=%s leaves it ON", (v) => {
    expect(sorted(enabledStepSevenRoutes({ [ADMIN_OPS_FLAG]: v }))).toEqual(sorted(ALL_FOUR));
  });

  it("all four flags are pairwise independent", () => {
    // §10's revert column is "per-route flag" in those words. Reverting
    // the money must not revert the reads, and vice versa. The property
    // is unchanged by the inversion; only its direction is. Each flag
    // set to `0` removes EXACTLY its own route and leaves the other
    // three alone.
    const FLAGS = [QUESTION_FLAG, BALANCER_FLAG, SCORE_FLAG, ADMIN_OPS_FLAG];
    const ROUTE_OF: Record<string, Route> = {
      [QUESTION_FLAG]: "question",
      [BALANCER_FLAG]: "balancer",
      [SCORE_FLAG]: "score",
      [ADMIN_OPS_FLAG]: "admin_ops",
    };
    for (const flag of FLAGS) {
      const env = Object.fromEntries(FLAGS.map((f) => [f, f === flag ? "0" : "1"]));
      expect(sorted(enabledStepSevenRoutes(env))).toEqual(
        sorted(ALL_FOUR.filter((r) => r !== ROUTE_OF[flag])),
      );
    }
    const allOff = Object.fromEntries(FLAGS.map((f) => [f, "0"]));
    expect([...enabledStepSevenRoutes(allOff)]).toEqual([]);
    expect(stepSevenNeedsRouter(enabledStepSevenRoutes(allOff))).toBe(false);
  });

  it("each owner is scoped to the routes it has a handler for", () => {
    // The trap this replaces: with every flag on and no `within`
    // narrowing, `answer-batch.ts` would treat a `score` message as a
    // candidate, pay for a question-extractor call on it, find no branch
    // that matches, and own nothing. Not a failure — a bill.
    const all = enabledStepSevenRoutes({});
    expect(stepSevenOwnsRoute("score", all, ANSWER_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("admin_ops", all, ANSWER_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("question", all, SCORE_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("score", all, ADMIN_OPS_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("question", all, TEAM_OPS_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("score", all, TEAM_OPS_ENGINE_ROUTES)).toBe(false);
    // …and the owner lists together cover exactly step 7's routes.
    const owners = [
      ...ANSWER_ENGINE_ROUTES,
      ...SCORE_ENGINE_ROUTES,
      ...ADMIN_OPS_ENGINE_ROUTES,
      ...TEAM_OPS_ENGINE_ROUTES,
    ];
    expect([...new Set(owners)].sort()).toEqual([...STEP_SEVEN_ROUTES].sort());
  });

  it("has exactly ONE route with two owners, and it is `balancer`", () => {
    // Until §10 step 8 this file asserted `new Set(owners).size ===
    // owners.length` — no route owned twice. Step 8 gave `balancer` a
    // second owner ON PURPOSE (`team-ops-engine-batch.ts` owns
    // `generate`, `answer-batch.ts` owns `show`), so the invariant is
    // restated rather than deleted: the DOUBLE-OWNED SET IS EXACTLY
    // {balancer}, and the next accidental collision still fails here.
    const owners = [
      ...ANSWER_ENGINE_ROUTES,
      ...SCORE_ENGINE_ROUTES,
      ...ADMIN_OPS_ENGINE_ROUTES,
      ...TEAM_OPS_ENGINE_ROUTES,
    ];
    const seen = new Set<Route>();
    const twice = new Set<Route>();
    for (const r of owners) {
      if (seen.has(r)) twice.add(r);
      seen.add(r);
    }
    expect([...twice]).toEqual(["balancer"]);
  });

  it("the two owners of `balancer` are DISJOINT on the team action", () => {
    // This is the property that makes two owners safe rather than merely
    // intended. Both modules import these lists rather than copying a
    // predicate, so they cannot drift into overlapping.
    for (const a of ANSWER_TEAM_ACTIONS) expect(TEAM_OPS_TEAM_ACTIONS).not.toContain(a);
    for (const a of TEAM_OPS_TEAM_ACTIONS) expect(ANSWER_TEAM_ACTIONS).not.toContain(a);
    expect([...ANSWER_TEAM_ACTIONS]).toEqual(["show"]);
    expect([...TEAM_OPS_TEAM_ACTIONS]).toEqual(["generate"]);
  });

  it("every team action is accounted for — owned by one module, or by none", () => {
    // `rename` and `swap` are owned by NEITHER, deliberately:
    // `route.ts`'s deterministic pre-peel already owns the swap on the
    // raw body, and re-running the balancer for a rename is c408649.
    // Asserted so a fifth action added to `TeamFacts` cannot silently
    // become nobody's problem AND nobody's decision.
    const owned = [...ANSWER_TEAM_ACTIONS, ...TEAM_OPS_TEAM_ACTIONS];
    const unowned = ALL_TEAM_ACTIONS.filter((a) => !owned.includes(a));
    expect([...ALL_TEAM_ACTIONS].sort()).toEqual(["generate", "rename", "show", "suggest", "swap"]);
    expect(unowned.sort()).toEqual(["rename", "suggest", "swap"]);
  });

  it("names every team action the facts type does, and no others", () => {
    // `route-flags.ts` restates `TeamFacts["action"]` rather than
    // importing the facts module for one union. This is the assertion
    // that keeps the two spellings identical: it fails to COMPILE if
    // either side gains a member the other lacks.
    const fromFacts: Record<TeamFacts["action"], true> = {
      show: true,
      generate: true,
      rename: true,
      swap: true,
      suggest: true,
    };
    const fromFlags: Record<TeamAction, true> = fromFacts;
    expect(Object.keys(fromFlags).sort()).toEqual([...ALL_TEAM_ACTIONS].sort());
  });

  it("adds NO fifth flag, and the team-ops alias points at the balancer flag", () => {
    // `enabledStepSevenRoutes` answers in `Route`s and both owners of
    // the team route key off the same one, so a fifth flag would either
    // turn `answer-batch.ts` on as a side effect or own nothing while
    // looking enabled — `gate.ts:227`'s "worst kind of flag". What it
    // costs is stated rather than hidden: reverting `generate` reverts
    // `show` with it.
    expect(TEAM_OPS_FLAG).toBe(BALANCER_FLAG);
    // One name reverts both team owners; a `TEAM_OPS_ENGINE_ENABLED`
    // that nothing reads cannot revert either.
    expect(enabledStepSevenRoutes({ [TEAM_OPS_FLAG]: "0" }).has("balancer")).toBe(false);
    expect(enabledStepSevenRoutes({ TEAM_OPS_ENGINE_ENABLED: "0" }).has("balancer")).toBe(true);
  });

  it("no flag name is left RESERVED — every one of them owns a route", () => {
    // Part 1 kept `SCORE_ENGINE_ENABLED` and `ADMIN_OPS_ENGINE_ENABLED`
    // as names nothing read, because `gate.ts:227` calls a flag that
    // looks enabled and does nothing "the worst kind of flag". Part 2
    // may honour them only because they now have owners. This asserts
    // the promotion actually happened and used the reserved spellings.
    expect(SCORE_FLAG).toBe("SCORE_ENGINE_ENABLED");
    expect(ADMIN_OPS_FLAG).toBe("ADMIN_OPS_ENGINE_ENABLED");
    expect(enabledStepSevenRoutes({ [SCORE_FLAG]: "0" }).has("score")).toBe(false);
    expect(enabledStepSevenRoutes({ [ADMIN_OPS_FLAG]: "0" }).has("admin_ops")).toBe(false);
  });

  it("only routes step 7 can actually own are listed", () => {
    expect([...STEP_SEVEN_ROUTES]).toEqual(["question", "balancer", "score", "admin_ops"]);
    // `unsure` is doubt and `none` is banter; neither is ever owned by
    // something that speaks (gate.ts:113-123 makes the same argument for
    // the attendance engine).
    expect(STEP_SEVEN_ROUTES).not.toContain("unsure");
    expect(STEP_SEVEN_ROUTES).not.toContain("none");
  });

  it("an undefined route — a message the router never mentioned — is never owned", () => {
    // Unchanged by the inversion, and worth keeping precisely because of
    // it: "every route defaults on" must not become "every MESSAGE
    // defaults owned". A message the router never mentioned still
    // belongs to nobody.
    const routes = enabledStepSevenRoutes({});
    expect(stepSevenOwnsRoute(undefined, routes)).toBe(false);
  });
});

describe("the test-only routes header", () => {
  const TEST = { MT_TEST_MODE: "1" };

  it("is inert unless MT_TEST_MODE is exactly 1", () => {
    expect(routesHeaderOverride("question", {})).toBeNull();
    expect(routesHeaderOverride("question", { MT_TEST_MODE: "0" })).toBeNull();
    expect(routesHeaderOverride("question", { MT_TEST_MODE: "true" })).toBeNull();
    expect(routesHeaderOverride("question", { MT_TEST_MODE: " 1" })).toBeNull();
  });

  it("falls back to the env when absent or empty", () => {
    expect(routesHeaderOverride(null, TEST)).toBeNull();
    expect(routesHeaderOverride(undefined, TEST)).toBeNull();
    expect(routesHeaderOverride("  ", TEST)).toBeNull();
  });

  it("selects one route, or several", () => {
    expect([...routesHeaderOverride("question", TEST)!]).toEqual(["question"]);
    expect([...routesHeaderOverride("balancer", TEST)!]).toEqual(["balancer"]);
    expect([...routesHeaderOverride("question,balancer", TEST)!].sort()).toEqual([
      "balancer",
      "question",
    ]);
    expect([...routesHeaderOverride(" QUESTION , balancer ", TEST)!].sort()).toEqual([
      "balancer",
      "question",
    ]);
  });

  it("states an empty selection explicitly, so a baseline arm can say `own nothing`", () => {
    expect([...routesHeaderOverride("none", TEST)!]).toEqual([]);
    expect([...routesHeaderOverride("off", TEST)!]).toEqual([]);
    expect([...routesHeaderOverride("0", TEST)!]).toEqual([]);
  });

  it("cannot invent a route", () => {
    // Not a step-7 route, not a route at all, and a route that belongs
    // to another step. None of them may be smuggled in through a header.
    for (const bad of ["self_att", "other_att", "offer", "unsure", "none", "teams", "banana"]) {
      expect([...routesHeaderOverride(bad, TEST)!]).toEqual([]);
    }
  });

  it("wins over the environment, in both directions", () => {
    const env = { ...TEST, [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "1" };
    expect([...enabledStepSevenRoutes(env, routesHeaderOverride("none", TEST))]).toEqual([]);
    expect([...enabledStepSevenRoutes({ ...TEST }, routesHeaderOverride("question", TEST))]).toEqual(
      ["question"],
    );
  });

  it("is named so it cannot collide with step 6's header", () => {
    expect(STEP_SEVEN_HEADER).toBe("x-mt-engine-routes");
    expect(STEP_SEVEN_HEADER).not.toBe("x-mt-attendance-engine");
  });
});

describe("the stub-file seam", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-route-flags-"));
  const file = path.join(dir, "router-stub.json");
  const env = (extra: Record<string, string | undefined> = {}) => ({
    MT_TEST_ROUTER_STUB_FILE: file,
    ...extra,
  });
  const write = (cfg: unknown) => fs.writeFileSync(file, JSON.stringify(cfg));

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is inert unless MT_TEST_ROUTER_STUB_FILE is set", () => {
    write({ engineRoutes: ["question"] });
    expect(sorted(enabledStepSevenRoutes({}))).toEqual(sorted(ALL_FOUR));
  });

  it("reads the SAME file gate.ts reads, so one stub configures the whole pipeline", () => {
    // `enabled` and `engine` were dropped from `RouterStubConfig` with
    // their flags in §10 step 8; a stub that still carries them is
    // ignored rather than rejected, which this asserts by leaving them
    // in. `floor` is the one boolean left, and `engineRoutes` still sets
    // an EXPLICIT route set that wins over the (now ON) defaults.
    write({ enabled: true, engine: true, floor: true, engineRoutes: ["question", "balancer"] });
    expect(sorted(enabledStepSevenRoutes(env()))).toEqual(["balancer", "question"]);
  });

  it("a stub with no engineRoutes key falls through to the env, exactly as gate.ts does", () => {
    // `gate.ts` reads its own key as `typeof stub.floor === "boolean"`
    // and otherwise falls back to the env; this file matches that
    // convention rather than inventing a second one, and the two are
    // asserted side by side so neither can drift into the other's shape.
    // A spec that means "own nothing" says so with `engineRoutes: []` —
    // it CANNOT be expressed by omission any more, which is the point of
    // the inversion.
    write({ floor: true });
    expect(sorted(enabledStepSevenRoutes(env({ [QUESTION_FLAG]: "0" })))).toEqual(
      sorted(["balancer", "score", "admin_ops"]),
    );
    expect(sorted(enabledStepSevenRoutes(env()))).toEqual(sorted(ALL_FOUR));
    write({ floor: true, engineRoutes: [] });
    expect([...enabledStepSevenRoutes(env({ [QUESTION_FLAG]: "1" }))]).toEqual([]);
  });

  it("cannot invent a route through the stub file either", () => {
    write({ engineRoutes: ["self_att", "banana", "question"] });
    expect([...enabledStepSevenRoutes(env())]).toEqual(["question"]);
  });

  it("a garbled stub file falls back to the env rather than throwing", () => {
    // It used to own NOTHING here, and the comment said that was "the
    // direction that cannot lose a reply" because an unowned route went
    // to the analyzer. After step 8 the direction that cannot lose a
    // reply is the other one: a garbled stub means "no stub", and no
    // stub means the env, and the env defaults to all four.
    fs.writeFileSync(file, "{ not json");
    expect(() => enabledStepSevenRoutes(env())).not.toThrow();
    expect(sorted(enabledStepSevenRoutes(env()))).toEqual(sorted(ALL_FOUR));
  });

  it("the header still wins over the stub file", () => {
    write({ engineRoutes: ["question", "balancer"] });
    expect([
      ...enabledStepSevenRoutes(env({ MT_TEST_MODE: "1" }), routesHeaderOverride("balancer", {
        MT_TEST_MODE: "1",
      })),
    ]).toEqual(["balancer"]);
  });
});

describe("the router has to run for a step-7 route to own anything", () => {
  it("says so, rather than owning nothing while looking enabled", () => {
    expect(stepSevenNeedsRouter(new Set())).toBe(false);
    expect(stepSevenNeedsRouter(new Set<Route>(["question"]))).toBe(true);
    expect(stepSevenNeedsRouter(new Set<Route>(["balancer"]))).toBe(true);
  });

  it("the trap it guarded is gone, because the router now always runs", () => {
    // What stood here: "a stub file (or an env flag) can turn `question`
    // on while `ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED` are
    // both off, in which case `routerIsNeeded` is false, the router
    // never runs, every route is `undefined`, and step 7 owns nothing
    // while its flag reads on."
    //
    // That trap needed a `routerIsNeeded` that could answer false. Both
    // flags it read are deleted, and §10 step 8 made a route the only
    // thing that says which owner a message belongs to — so the router
    // runs unconditionally and the predicate takes no arguments. The
    // case is kept, inverted, so that anyone reintroducing a condition
    // to `routerIsNeeded` has to come past the reason it has none.
    expect(routerIsNeeded()).toBe(true);
    expect(stepSevenNeedsRouter(enabledStepSevenRoutes({}))).toBe(true);
  });
});
