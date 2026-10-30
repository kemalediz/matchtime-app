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
 * ═════════════════════════════════════════════════════════════════════
 * THE DEFAULT INVERTED ON 2026-09-06 (§10 STEP 8): ALL FOUR ROUTES ARE
 * ON UNLESS A FLAG EXPLICITLY SAYS OTHERWISE
 * ═════════════════════════════════════════════════════════════════════
 *
 * What stood here, verbatim, and it was right for as long as there was
 * something behind these flags:
 *
 *   "DEFAULT OFF, AND IT CANNOT BE OTHERWISE. Same four spellings as
 *    `gate.ts`, same strictness … so a typo in a Vercel env var can
 *    never turn a route over."
 *
 * Step 8 deletes `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT`.
 * The thing an unowned route fell back to is gone, so default-off no
 * longer means "the analyzer handles it" — it means MatchTime answers no
 * question, shows no teams, records no score and credits no payment. It
 * would go silent on four of its nine routes and call that a safe
 * default. So the default flips, and the STRICTNESS FLIPS WITH IT: only
 * `0`, `false`, `no` and `off` take a route off the air, and anything
 * else — a typo, an empty string, an unset variable — leaves it ON.
 * That is the same rule as before, pointed at the same outcome: a
 * mistyped env var must never silently change what MatchTime does.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THESE FOUR ARE KEPT WHEN TWO OTHER FLAGS WERE DELETED
 * ─────────────────────────────────────────────────────────────────────
 *
 * `ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED` were deleted in
 * the same change rather than defaulted on (`gate.ts` carries the full
 * argument). The distinction is not stylistic, and it is the one to
 * apply to the next flag anybody proposes:
 *
 *   AN OFF POSITION MUST HAVE AN IMPLEMENTATION.
 *
 *   • These four have one, and it is survivable. If the question engine
 *     starts answering wrongly at 2am, `QUESTION_ENGINE_ENABLED=0` makes
 *     MatchTime go QUIET on questions and `lib/operator-note.ts` DMs an
 *     admin to say a message went unowned. The club loses a convenience
 *     and a human finds out. That is a useful lever at 2am.
 *   • `ATTENDANCE_ENGINE_ENABLED=0` would have left NOBODY handling
 *     `self_att` / `other_att` / `offer` / `unsure` — every "IN", every
 *     "can't make it". A kill switch for the product's core write path
 *     wearing the name of a tuning flag. There is no such flag any more.
 *
 * SAY IT PLAINLY, because a reader in six months will assume otherwise:
 * "OFF" NO LONGER MEANS "THE ANALYZER DECIDES IT". IT MEANS SILENCE IN
 * THE GROUP PLUS AN OPERATOR NOTE. And these flags are per-route tuning,
 * not a revert of step 8 — THE REVERT FOR STEP 8 AS A WHOLE IS
 * `git revert`, not a flag.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ALL FOUR FLAGS EXIST — AND THAT IS A CLAIM, NOT A TIDY-UP
 * ─────────────────────────────────────────────────────────────────────
 * Part 1 shipped two and RESERVED the other two as constants nothing
 * read, because `gate.ts` states the rule this file obeys: a flag that
 * looks enabled and does nothing is "the worst kind of flag".
 *
 * Part 2 promoted them, and the rule is the reason it may: `score` and
 * `admin_ops` have owners — `score-engine-batch.ts` and
 * `admin-ops-engine-batch.ts`, each with its own apply layer — so
 * `SCORE_ENGINE_ENABLED=0` genuinely takes the route off the air rather
 * than handing it somewhere else. If either owner is ever deleted, its
 * flag must go with it in the same change.
 *
 * `route-flags.test.ts` asserts that each flag turns OFF exactly its own
 * route, that all four are pairwise independent, that an unrecognised
 * value leaves a route ON, and that an unrelated env var changes
 * nothing.
 */
import { readFileSync } from "node:fs";
import { ROUTER_STUB_FILE_ENV } from "./gate";
import type { Route } from "./types";

// ── The flags that exist ──────────────────────────────────────────────

/**
 * §3.2 S16 — the single heaviest section of the mega-prompt at 2,010
 * measured tokens, six sub-rules, four incidents. That section is
 * deleted; `pipeline/answer-batch.ts` owns the route.
 *
 * ON by default since §10 step 8. `QUESTION_ENGINE_ENABLED=0` no longer
 * sends questions "back to" anything — it makes MatchTime go quiet on
 * them and tells an admin, which is a lever worth having at 2am and is
 * why this flag survived while two others did not.
 */
export const QUESTION_FLAG = "QUESTION_ENGINE_ENABLED";

/**
 * §3.2 S19 — "show the teams again" re-ran the balancer and destroyed an
 * admin's manual swap (`c408649`). 331 measured tokens.
 *
 * ONE FLAG FOR THE WHOLE ROUTE, and since §10 step 8 that route has TWO
 * owners. See `TEAM_ACTION_OWNERSHIP` below. ON by default, and setting
 * it to `0` takes BOTH owners off the air at once — stated again where
 * it costs something, on `TEAM_OPS_FLAG`.
 */
export const BALANCER_FLAG = "BALANCER_ENGINE_ENABLED";

/**
 * The flag that owns `generate`. It IS `BALANCER_FLAG`, and this alias
 * exists so a reader looking for a team-ops flag finds the reason rather
 * than a missing symbol.
 *
 * A fifth flag was considered for step 8 and rejected on a mechanical
 * ground, not a stylistic one: `enabledStepSevenRoutes` returns a
 * `Set<Route>`, `stepSevenOwnsRoute` answers from that set, and BOTH
 * owners of the team route key off the same `Route` value (`balancer`) —
 * the router emits no other. A `TEAM_OPS_ENGINE_ENABLED` that removed
 * `balancer` from the set would therefore take `answer-batch.ts` off the
 * air as well, which is the opposite of an independent revert; and a
 * route the router never emits would be `gate.ts`'s "worst kind of
 * flag" — one that looks live and owns nothing.
 *
 * WHAT THIS COSTS, stated rather than hidden: reverting `generate` means
 * reverting `show` with it. Both are one env var, both fall back to the
 * same place, and the split that actually matters — a READ that cannot
 * write versus a WRITE that reruns the balancer — is enforced by
 * `TEAM_ACTION_OWNERSHIP` and asserted disjoint, not by an env var an
 * operator has to get right at 11pm.
 */
export const TEAM_OPS_FLAG = BALANCER_FLAG;

// ── The two flags part 2 promoted from RESERVED to real ──────────────

/**
 * §3.2 S17. The `score` route, and the FIRST step-7 flag that owns a
 * WRITE: `Match.redScore` / `yellowScore` plus the Elo deltas
 * (`route.ts:3505-3531`, `elo.ts:34`).
 *
 * Until part 2 this name was RESERVED — written down, read by nothing —
 * because `gate.ts` calls a flag that looks enabled and does nothing
 * "the worst kind of flag" and there was no owner. `score-engine-batch.ts`
 * is the owner, so the name is now honoured. The spelling is the one that
 * was reserved, which is the entire point of having reserved it.
 *
 * ON by default since §10 step 8. `SCORE_ENGINE_ENABLED=0` means a
 * "we won 5-3" is neither recorded nor answered, and an admin is told.
 * A score can be entered by hand in the admin UI, which is what makes
 * this off position survivable rather than a kill switch.
 */
export const SCORE_FLAG = "SCORE_ENGINE_ENABLED";

/**
 * §3.2 S21 + S22. The `admin_ops` route: a payment credit (real money,
 * live on Sutton FC since 2026-06-09), a personal reminder, and the
 * recruit blast.
 *
 * ONE flag for all three, unlike the rest of step 7's one-per-route
 * scheme, because they are one ROUTE. Splitting them further would mean
 * a router verdict of `admin_ops` whose ownership depended on a fact the
 * extractor had not returned yet — the flag would have to be consulted
 * after the model call rather than before it, and the "own nothing
 * cheaply" property that makes every carve-out free would be gone.
 * `admin-ops-engine-batch.ts` decides per action instead, and each
 * action's carve-outs are enumerated there.
 *
 * ON by default since §10 step 8, and it is the flag most likely to be
 * reached for in anger, because this route moves REAL MONEY on a live
 * club (Sutton FC, since 2026-06-09). `ADMIN_OPS_ENGINE_ENABLED=0`
 * means a "mark Habib as paid" in the group does nothing and an admin
 * is DMed about it; the payment can still be recorded in the admin UI.
 * That is the shape of a survivable off position: the capability moves
 * to a slower surface, it does not disappear.
 */
export const ADMIN_OPS_FLAG = "ADMIN_OPS_ENGINE_ENABLED";

/**
 * The routes step 7 can own, in flag order.
 *
 * `unsure` IS ABSENT, AND THE REASON CHANGED ON 2026-09-06. It used to
 * be "the same reason `gate.ts` leaves it out of the attendance engine:
 * a route the router itself could not settle is doubt, and §13's
 * conservative default makes doubt cost an analyzer call." Step 8
 * reversed that — `ENGINE_ROUTES` now CONTAINS `unsure`, because the
 * choice it presents is no longer "engine or analyzer" but "engine or
 * silence", and the attendance extractor is the one owner whose worst
 * case (no claims, nothing written) §6.2 has measured.
 *
 * It stays out of THIS list for a different reason: `unsure` has an
 * owner already, and it is the attendance engine. Adding it here would
 * hand one message to two deciders, which is the failure the whole
 * ownership scheme exists to prevent — `claim()` in the analyze route
 * asserts exactly one decider per message.
 *
 * `none` is the gate's business and is never owned by anything that
 * speaks.
 */
export const STEP_SEVEN_ROUTES: readonly Route[] = [
  "question",
  "balancer",
  "score",
  "admin_ops",
];

// ── WHICH OWNER OWNS WHICH ROUTE ─────────────────────────────────────
//
// Step 7 is no longer one module. `answer-batch.ts` owns the two READS
// and has no apply layer at all — a property `__tests__/zero-writes.test.ts`
// enforces by scanning the directory. The two routes below WRITE, so
// they live outside `pipeline/` with an apply layer each, exactly as
// step 6's `attendance-engine.ts` does.
//
// These lists exist so a runner cannot accidentally own a route it has
// no handler for. Without them, `enabledStepSevenRoutes` returning
// `{score}` and `answer-batch.ts` filtering only on `enabled.has(route)`
// would make the answer engine pay for an extractor call on every score
// message and then own none of them — which is not a bug that shows up
// as a failure, only as a bill.

/** Owned by `answer-batch.ts`. Reads; no apply layer; no writes. */
export const ANSWER_ENGINE_ROUTES: readonly Route[] = ["question", "balancer"];

/** Owned by `score-engine-batch.ts`. Writes, via `score-engine.ts`. */
export const SCORE_ENGINE_ROUTES: readonly Route[] = ["score"];

/** Owned by `admin-ops-engine-batch.ts`. Writes, via `admin-ops-engine.ts`. */
export const ADMIN_OPS_ENGINE_ROUTES: readonly Route[] = ["admin_ops"];

/**
 * Owned by `team-ops-engine-batch.ts`. Writes, via `team-ops-engine.ts`.
 *
 * ⚠️ THE ONE ROUTE IN THIS FILE WITH TWO OWNERS. It is the same
 * `balancer` route `ANSWER_ENGINE_ROUTES` names, and that is not an
 * oversight — see `TEAM_ACTION_OWNERSHIP` immediately below, which is
 * the thing that keeps the two apart.
 */
export const TEAM_OPS_ENGINE_ROUTES: readonly Route[] = ["balancer"];

// ── TEAM_ACTION_OWNERSHIP — ONE ROUTE, TWO HANDLERS, SPLIT ON A FACT ─
//
// Two owners for one route is the shape this codebase fears most, so it
// is written down here, in one place, rather than implied by two `if`s
// in two files.
//
// The router cannot tell "show me the teams" from "generate the teams" —
// both are `balancer`, and the difference is not knowable until the
// teams extractor has run. So the split is on the FACT the extractor
// returns, not on the route and not on a flag:
//
//   • `show`     → `answer-batch.ts`. A READ. No apply layer exists on
//                  that path and `__tests__/zero-writes.test.ts` scans
//                  the directory to keep it that way.
//   • `generate` → `team-ops-engine-batch.ts`. A WRITE: it rewrites
//                  every `TeamAssignment`, force-confirms named players,
//                  moves `Match.status` and runs the rating adjuster.
//   • `rename`,
//     `swap`,
//     `suggest`  → NEITHER. All three are handed back; the two modules'
//                  headers say why for the first two, `suggest`
//                  (2026-10-29) is the organisers' group's alone
//                  (`team-proposal.ts`), and `route.ts`'s deterministic
//                  pre-peel (`handleTeamSwapIfApplicable`) already owns
//                  the swap on the raw body with no verdict at all.
//
// The lists are exported so the two modules import the SAME constant —
// a predicate copied into two files is a predicate that drifts — and
// `__tests__/route-flags.test.ts` asserts they are disjoint, which is
// the property that makes two owners safe rather than merely intended.

/** `TeamFacts["action"]`, restated here so this file does not import the
 *  facts module for one union. `route-flags.test.ts` asserts the two
 *  spellings agree. */
export type TeamAction = "show" | "generate" | "rename" | "swap" | "suggest";

/** Team actions `answer-batch.ts` owns. Reads only. */
export const ANSWER_TEAM_ACTIONS: readonly TeamAction[] = ["show"];

/** Team actions `team-ops-engine-batch.ts` owns. */
export const TEAM_OPS_TEAM_ACTIONS: readonly TeamAction[] = ["generate"];

/** Every team action, so a new one cannot be added to `TeamFacts`
 *  without this file failing to compile against it. */
export const ALL_TEAM_ACTIONS: readonly TeamAction[] = ["show", "generate", "rename", "swap", "suggest"];

type Env = Record<string, string | undefined>;

/**
 * Is this route EXPLICITLY switched off?
 *
 * THE INVERSE OF `gate.ts`'s private `on()`, and deliberately a separate
 * function rather than `!on(...)`. Three things follow from that and all
 * three are the point:
 *
 *   1. `!on(env, key)` would be true for an UNSET variable, which is the
 *      default, which would take every route off the air. The negation
 *      of "explicitly on" is not "explicitly off".
 *   2. Only `0`, `false`, `no` and `off` count. A typo, an empty string,
 *      a `"disabled"`, a `"2"` — none of them silence a route. After
 *      §10 step 8 that is the direction that cannot lose a reply: a
 *      mistyped env var in a Vercel dashboard would otherwise stop
 *      MatchTime answering with no error and nothing in any log.
 *   3. It is still a COPY rather than an import, for the reason the
 *      previous version gave and which has not changed: `on()` is not
 *      exported, and this module and `gate.ts` are edited by different
 *      changes for different reasons — a shared mutable helper is how
 *      "we loosened the spelling for one flag" quietly loosens it for
 *      all of them. `__tests__/route-flags.test.ts` now asserts the two
 *      readers' accepted spellings are DISJOINT, which is the right
 *      cross-check once they point in opposite directions.
 */
function off(env: Env, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
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
  const unknown: string[] = [];
  for (const w of wanted) {
    const match = STEP_SEVEN_ROUTES.find((r) => r === w);
    if (match) routes.add(match);
    else unknown.push(w);
  }
  // A mistyped arm is the shape PR #38 exists to stop: it would own
  // nothing, score whatever the baseline scores, and report itself as
  // the candidate. It cannot throw from a request path, so it says so
  // instead — loudly enough that a sweep's log carries the reason its
  // numbers look like the incumbent's.
  if (unknown.length > 0) {
    console.warn(
      `[route-flags] ${STEP_SEVEN_HEADER} named ${unknown.length} route(s) step 7 cannot own ` +
        `(${unknown.join(", ")}); they were ignored. Valid: ${STEP_SEVEN_ROUTES.join(", ")}.`,
    );
  }
  return routes;
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
    // means the env flags, which since §10 step 8 default the four
    // routes ON. Still the direction that cannot lose a reply — it is
    // the other direction now, because what an unowned route falls back
    // to is silence rather than the analyzer.
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
 *
 * The two test seams set an EXPLICIT route set and still win outright,
 * unchanged by the default inversion — a spec that means "own nothing"
 * says so with `engineRoutes: []` or the header value `none`. What
 * changed is only the third case: an absent seam now yields all four
 * routes minus whatever a flag explicitly switched off, where it used to
 * yield the empty set unless a flag explicitly switched something on.
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

  // ON UNLESS EXPLICITLY OFF (§10 step 8). Start from EVERY route step 7
  // can own and REMOVE the ones a flag switches off, rather than
  // building the set up from flags. Written this way on purpose: a
  // future fifth route added to `STEP_SEVEN_ROUTES` without a flag is
  // then live by default, which is the direction that cannot lose a
  // reply — the opposite construction would leave it silently unowned.
  //
  // A `filter` rather than `new Set(ALL)` + `.delete(…)`, and the reason
  // is a real one rather than taste: `__tests__/zero-writes.test.ts`
  // scans every file in this directory for a Prisma mutation on every
  // build, and `routes.delete("question")` reads to that scanner exactly
  // like `db.x.delete(...)`. The scanner is deliberately blunt — it is
  // the thing standing between the dry-run pipeline and a write — so the
  // right fix is to stop writing the shape that trips it, not to teach
  // it a new exception.
  const isOff: Record<string, boolean> = {
    question: off(env, QUESTION_FLAG),
    balancer: off(env, BALANCER_FLAG),
    score: off(env, SCORE_FLAG),
    admin_ops: off(env, ADMIN_OPS_FLAG),
  };
  return new Set<Route>(STEP_SEVEN_ROUTES.filter((r) => !isOff[r]));
}

/**
 * Does step 7 decide this route for this request?
 *
 * A route it has never heard of — including `undefined`, which is what a
 * message the router never mentioned looks like — is never owned.
 *
 * `within` narrows the answer to the routes ONE OWNER can actually
 * handle, and every caller passes it. It is optional only so the
 * unqualified question ("is this route live at all?") stays askable; a
 * runner that omitted it would happily claim a route whose facts it has
 * no branch for, spend an extractor call on it and then own nothing.
 */
export function stepSevenOwnsRoute(
  route: Route | undefined,
  enabled: Set<Route>,
  within?: readonly Route[],
): boolean {
  if (route === undefined) return false;
  if (within && !within.includes(route)) return false;
  return enabled.has(route);
}

/**
 * Must the router run for step 7's sake?
 *
 * The same trap `gate.ts` documents: a route flag that is live while the
 * router does not run would own nothing while looking enabled.
 *
 * SINCE §10 STEP 8 THIS CAN NO LONGER ANSWER "NO" IN PRODUCTION, because
 * the default is all four routes and `routerIsNeeded()` is now
 * unconditionally true. It is kept for the one case that still answers
 * false — every flag explicitly off, or a test seam selecting no
 * routes — and because deleting a predicate whose answer happens to be
 * constant today is how the reason it existed gets lost.
 */
export function stepSevenNeedsRouter(enabled: Set<Route>): boolean {
  return enabled.size > 0;
}
