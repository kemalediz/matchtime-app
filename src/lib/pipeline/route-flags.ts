/**
 * §10 STEP 7 — ONE FLAG PER ROUTE.
 *
 *   "Migrate the rest — `question`, `team_ops`, `score`, `admin_ops`,
 *    one per week. Retire the mega-prompt when the last route leaves."
 *    risk: low each.  revert: PER-ROUTE FLAG.
 *
 * Step 5 shipped one flag (`ROUTER_GATE_ENABLED`) and step 6 shipped a
 * second (`ATTENDANCE_ENGINE_ENABLED`) covering three routes at once,
 * because those three are one decision: they all end in an attendance
 * write and share every capacity, authorisation and corroboration rule.
 * The four routes left are NOT one decision. A question is a read, a
 * team post is a different read, a score is a write against a finished
 * match and a payment credit is real money on a live club. Reverting one
 * must not revert the others, so each gets its own switch — which is
 * what §10's revert column asks for, in those words.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY ONLY TWO FLAGS ARE DEFINED HERE
 * ─────────────────────────────────────────────────────────────────────
 * `gate.ts:227` states the rule this file obeys: a flag that looks
 * enabled and does nothing is "the worst kind of flag". `score` and
 * `admin_ops` have no owner in this change — see
 * `answer-batch.ts`'s header for the measured reasons — so defining
 * `SCORE_ENGINE_ENABLED` and `ADMIN_OPS_ENGINE_ENABLED` now would ship
 * exactly that. The names are RESERVED below as constants nothing reads,
 * so the next step cannot pick a different spelling by accident, and a
 * test asserts they are not honoured.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEFAULT OFF, AND IT CANNOT BE OTHERWISE
 * ─────────────────────────────────────────────────────────────────────
 * Same four spellings as `gate.ts`, same strictness, and a unit test
 * asserts the two readers agree — so a typo in a Vercel env var can
 * never turn a route over, and a value that turns the attendance engine
 * on cannot turn a step-7 route on as a side effect.
 */
import { readFileSync } from "node:fs";
import { ROUTER_STUB_FILE_ENV } from "./gate";
import type { Route } from "./types";

// ── The flags that exist ──────────────────────────────────────────────

/** §3.2 S16 — the single heaviest section of the mega-prompt at 2,010
 *  measured tokens (`message-analyzer.ts:454-464`), six sub-rules, four
 *  incidents. Unset or `0` and every question goes back to it. */
export const QUESTION_FLAG = "QUESTION_ENGINE_ENABLED";

/** §3.2 S19 — "show the teams again" re-ran the balancer and destroyed
 *  an admin's manual swap (`c408649`). 331 measured tokens
 *  (`message-analyzer.ts:484-486`). This flag owns SHOWING only; see
 *  `answer-batch.ts` on why generating stays with the analyzer. */
export const BALANCER_FLAG = "BALANCER_ENGINE_ENABLED";

// ── The flags that do NOT exist yet, named so they cannot drift ───────

/**
 * RESERVED. Nothing reads these. They are here so the follow-up change
 * uses these exact spellings rather than inventing
 * `SCORE_ROUTE_ENABLED` beside a documented `SCORE_ENGINE_ENABLED`.
 *
 * `enabledStepSevenRoutes` deliberately ignores them, and
 * `__tests__/route-flags.test.ts` asserts that setting either one to
 * "1" changes nothing at all.
 */
export const RESERVED_FLAGS = {
  score: "SCORE_ENGINE_ENABLED",
  admin_ops: "ADMIN_OPS_ENGINE_ENABLED",
} as const;

/**
 * The routes step 7 can own TODAY, in flag order.
 *
 * `unsure` is absent for the same reason `gate.ts:124` leaves it out of
 * the attendance engine: a route the router itself could not settle is
 * doubt, and §13's conservative default makes doubt cost an analyzer
 * call. `none` is step 5's business and is never owned by anything that
 * speaks.
 */
export const STEP_SEVEN_ROUTES: readonly Route[] = ["question", "balancer"];

type Env = Record<string, string | undefined>;

/**
 * Deliberately strict, and deliberately a COPY of `gate.ts`'s private
 * `on()` rather than an import of it.
 *
 * Two reasons, and the second is the load-bearing one. First, `on()` is
 * not exported. Second, this module and `gate.ts` are edited by
 * different changes for different reasons, and a shared mutable helper
 * is how "we loosened the spelling for one flag" quietly loosens it for
 * all of them. `__tests__/route-flags.test.ts` asserts the two readers
 * agree on the same 40 inputs, which is a stronger guarantee than a
 * shared function: it fails loudly if either one drifts.
 */
function on(env: Env, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ── The test seams ────────────────────────────────────────────────────

/**
 * TEST-ONLY per-request override, for the one thing an env var cannot
 * do: a LIVE A/B in one process.
 *
 * Identical shape, identical double gate and identical blast radius to
 * `gate.ts`'s `x-mt-attendance-engine` (`gate.ts:197-209`):
 *
 *   1. `MT_TEST_MODE` must be exactly "1". Nothing sets that but
 *      `e2e/helpers/env.ts:buildTestEnv()` — it is not in
 *      `.env.example`, not in Vercel and not on the Pi.
 *   2. Anything unrecognised yields `null` and the caller falls back to
 *      the env flags, which are off.
 *
 * The VALUE is a comma-separated route list rather than a boolean,
 * because step 7's whole point is that the routes move one at a time
 * and an A/B has to be able to say WHICH one moved. Unknown names are
 * dropped rather than throwing: a header cannot invent a route.
 */
export const STEP_SEVEN_HEADER = "x-mt-engine-routes";

export function routesHeaderOverride(
  header: string | null | undefined,
  env: Env = process.env,
): Set<Route> | null {
  if (env.MT_TEST_MODE !== "1") return null;
  const raw = header?.trim().toLowerCase();
  if (raw === undefined || raw === "") return null;
  // An explicit "none" is how an arm says "own nothing" without falling
  // back to the env — the baseline arm of an A/B needs to be able to
  // state that rather than rely on the server's flags happening to be
  // off.
  if (raw === "none" || raw === "off" || raw === "0") return new Set();
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const routes = new Set<Route>();
  for (const w of wanted) {
    const match = STEP_SEVEN_ROUTES.find((r) => r === w);
    if (match) routes.add(match);
  }
  return routes.size > 0 ? routes : new Set();
}

interface RouteStubConfig {
  /** Routes step 7 owns for this request. Same seam, same blast radius
   *  as `gate.ts`'s `engine` field: only ever read when
   *  MT_TEST_ROUTER_STUB_FILE is set, which nothing outside the e2e
   *  harness sets. */
  engineRoutes?: string[];
}

/**
 * Read fresh on every call, like the router stub, so a spec can rewrite
 * it between requests. It reads the SAME file `gate.ts` reads, under the
 * same env var, so one stub JSON configures the whole pipeline for a
 * spec rather than two files that can disagree about which request they
 * are describing.
 */
function routeStubConfig(env: Env = process.env): RouteStubConfig | null {
  const file = env[ROUTER_STUB_FILE_ENV];
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RouteStubConfig;
  } catch {
    // Missing or garbled → behave as if there were no stub at all, which
    // means the env flags, which are off, which means every message
    // reaches the analyzer. The direction that cannot lose a reply.
    return null;
  }
}

// ── The decision ──────────────────────────────────────────────────────

/**
 * Which of step 7's routes are live for this request?
 *
 * Precedence, highest first: the test-only header, the test-only stub
 * file, the environment. Exactly the order `gate.ts` uses, so an
 * operator reading one file understands both.
 */
export function enabledStepSevenRoutes(
  env: Env = process.env,
  headerOverride: Set<Route> | null = null,
): Set<Route> {
  if (headerOverride) return new Set(headerOverride);

  const stub = routeStubConfig(env);
  if (stub && Array.isArray(stub.engineRoutes)) {
    const routes = new Set<Route>();
    for (const raw of stub.engineRoutes) {
      const match = STEP_SEVEN_ROUTES.find((r) => r === String(raw).trim().toLowerCase());
      if (match) routes.add(match);
    }
    return routes;
  }

  const routes = new Set<Route>();
  if (on(env, QUESTION_FLAG)) routes.add("question");
  if (on(env, BALANCER_FLAG)) routes.add("balancer");
  return routes;
}

/** Does step 7 decide this route for this request? A route it has never
 *  heard of — including `undefined`, which is what a message the router
 *  never mentioned looks like — is never owned. */
export function stepSevenOwnsRoute(
  route: Route | undefined,
  enabled: Set<Route>,
): boolean {
  return route !== undefined && enabled.has(route);
}

/**
 * Must the router run for step 7's sake?
 *
 * The same trap `gate.ts:227` documents: turning a route flag on
 * without the router running would own nothing while looking enabled.
 * The analyze route ORs this with `routerIsNeeded`.
 */
export function stepSevenNeedsRouter(enabled: Set<Route>): boolean {
  return enabled.size > 0;
}
