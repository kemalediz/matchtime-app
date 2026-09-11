/**
 * Single source of truth for every e2e constant. NOTHING in here may
 * point at production — `assertSafeTestDbUrl` is the hard gate that
 * every DB-touching entry point (run.ts, playwright.config.ts,
 * test-db.ts) calls before connecting.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { APP_PORT_ENV, DB_PORT_ENV, resolvePorts } from "./ports";

// All entry points (npm scripts, the Playwright runner and its workers)
// run with cwd = repo root. Verified rather than assumed — this file is
// loaded in both CJS (playwright.config) and ESM (e2e/ is "type":
// "module") contexts, so __dirname/import.meta can't be used portably.
export const REPO_ROOT = process.cwd();
if (!existsSync(path.join(REPO_ROOT, "prisma", "schema.prisma"))) {
  throw new Error(`e2e: expected to run from the repo root, got cwd=${REPO_ROOT}`);
}

/**
 * Which ports this checkout owns. Derived from the checkout path, not
 * fixed, so two worktrees running the suite at once cannot share a
 * database or a dev server — see helpers/ports.ts for why derived rather
 * than dynamically allocated, and helpers/preflight.ts for what happens
 * when two checkouts hash to the same slot anyway.
 *
 * Everything else under `.e2e/` was already per-checkout (it hangs off
 * REPO_ROOT); the ports were the one piece of global state left.
 */
export const E2E_PORTS = resolvePorts(REPO_ROOT);

export const E2E = {
  /** Embedded Postgres — local-only, throwaway cluster under .e2e/. */
  DB_PORT: E2E_PORTS.db,
  DB_NAME: "matchtime_test",
  DB_USER: "postgres",
  DB_PASSWORD: "postgres",
  DATA_DIR: path.join(REPO_ROOT, ".e2e", "pgdata"),

  /** Next dev server under test. */
  APP_PORT: E2E_PORTS.app,

  /** One run per checkout — see acquireRunLock in helpers/preflight.ts.
   *  Overridable so the harness's own tests can exercise the guard
   *  without fighting a real run for the checkout's lock. */
  RUN_LOCK: process.env.MT_E2E_RUN_LOCK ?? path.join(REPO_ROOT, ".e2e", "run.lock"),

  /** Test-only secrets — deliberately NOT the prod values, so a token
   *  minted by the tests can never be valid against prod (and vice
   *  versa), and a prod-config'd server would 401 every API spec. */
  AUTH_SECRET: "mt-e2e-only-auth-secret-never-prod",
  WHATSAPP_API_KEY: "mt-e2e-whatsapp-key",
  CRON_SECRET: "mt-e2e-cron-secret",

  /**
   * `MT_TEST_DM_QA_STUB`'s value — a FLAG, not a path.
   *
   * It was `MT_TEST_LLM_STUB_FILE`, and that name was doing two
   * unrelated jobs: it pointed at the file `analyzeBatch` read verdicts
   * out of, AND it is `src/lib/dm-qa.ts`'s stub flag, read there as a
   * plain truthiness test and never opened. §10 step 8 deleted
   * `analyzeBatch`; this PR deleted the file-writing helper with the
   * specs that used it, which left a variable called "LLM stub file"
   * that was neither an LLM stub nor a file.
   *
   * So it is renamed and its value is now just "1". With it set,
   * `answerScopedQuestion` returns the SCOPED CONTEXT itself instead of
   * calling Anthropic, which is how `e2e/sim/qa.spec.ts` asserts the
   * no-leak guarantee structurally (no raw phone digits ever enter a
   * model's context) rather than by reading a model's prose.
   */
  DM_QA_STUB: "1",

  /** The ROUTER stub file (§10 step 5). Carries the router's answer AND
   *  the two step-5 flags, because the dev server's environment is fixed
   *  at boot and a spec needs to run one request with the gate on and
   *  the next with it off. `{}` — the default `clearRouterStub()` writes
   *  — means "no override", so the flags fall back to the env, which is
   *  off. Every other spec is therefore untouched by its existence. */
  ROUTER_STUB_FILE: path.join(REPO_ROOT, ".e2e", "router-stub.json"),

  /** The EXTRACTOR stub file (§10 step 6). Body → the raw JSON the
   *  attendance extractor would have returned. §10 step 6 puts the
   *  extractor on the WRITE path, and a write path that can only be
   *  exercised by spending money is a write path nobody exercises — so
   *  the free suite has to be able to drive the whole engine. Absent or
   *  `{}` → every body extracts NO claims, which is the direction that
   *  cannot invent a write in a spec that has never heard of it. */
  EXTRACTOR_STUB_FILE: path.join(REPO_ROOT, ".e2e", "extractor-stub.json"),

  /** The DM-INTENT stub file (2026-09-11). Body → the intent
   *  `lib/dm-intent.ts` would have returned. The 1:1 DM surface has no
   *  verdict pipeline, so this one classifier is the whole seam, and
   *  behind one of its three values sits `inviteRecentPlayers` — a mass
   *  DM to 13-27 real people. Same argument as the extractor stub: a
   *  write path that can only be exercised by spending money is a write
   *  path nobody exercises. Absent or `{}` → every body classifies as
   *  `other`, which DMs nobody. */
  DM_INTENT_STUB_FILE: path.join(REPO_ROOT, ".e2e", "dm-intent-stub.json"),

  /** WhatsApp group id of the seeded test org. */
  GROUP_ID: "e2e-test-group@g.us",
} as const;

export const E2E_DB_URL = `postgresql://${E2E.DB_USER}:${E2E.DB_PASSWORD}@127.0.0.1:${E2E.DB_PORT}/${E2E.DB_NAME}`;
// MUST be "localhost", not 127.0.0.1 — Next 16 dev blocks cross-origin
// requests to its dev resources (/_next/*), and it treats localhost as
// its own origin. A 127.0.0.1 baseURL leaves every page stuck with no JS.
export const E2E_BASE_URL = `http://localhost:${E2E.APP_PORT}`;

/**
 * ABSOLUTE SAFETY RULE — the test suite must never touch a non-local
 * database. Throws unless the URL is a loopback Postgres URL and free
 * of any cloud-host markers.
 */
export function assertSafeTestDbUrl(url: string | undefined): asserts url is string {
  if (!url) {
    throw new Error(
      "e2e: no test DATABASE_URL set. Run the suite via `npm run test:e2e` " +
        "(which provisions the isolated embedded Postgres) — never directly.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`e2e: test DATABASE_URL is not a valid URL: ${url}`);
  }
  const host = parsed.hostname;
  const ok = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const banned = /supabase|pooler|amazonaws|neon|render|vercel|gcp|azure/i;
  if (!ok || banned.test(url)) {
    throw new Error(
      `e2e: REFUSING to run — DATABASE_URL host "${host}" is not a local ` +
        `loopback address. The e2e suite must never point at a remote/prod DB.`,
    );
  }
}

/** Full env block for the Next dev server under test AND the Playwright
 *  worker processes. Every var that could reach an external service is
 *  pinned to an inert value so a stray `.env` can never leak in. */
export function buildTestEnv(): Record<string, string> {
  // Opt-in "live LLM" seam: when MT_SIM_LIVE_LLM=1, the group-simulator
  // harness exercises the real Anthropic model instead of the deterministic
  // stubs. It pins all three stub-file vars empty (so the router, the
  // extractors and dm-qa all fall through to a real model), passes the real
  // ANTHROPIC_API_KEY from the orchestrator's env, and propagates the flag
  // into the Playwright workers (where group.ts runs). When the flag is OFF
  // (the default), the returned env is byte-identical to the original
  // stubbed configuration.
  const live = process.env.MT_SIM_LIVE_LLM === "1";
  const env: Record<string, string> = {
    // Pin the resolved ports for every child process (Playwright and its
    // workers, the dev server). run.ts and playwright.config.ts are
    // separate processes that would each derive the same pair from cwd,
    // but passing them explicitly means one run can only ever have one
    // answer — and it puts the ports in `env` where a debugger can see
    // them.
    [APP_PORT_ENV]: String(E2E.APP_PORT),
    [DB_PORT_ENV]: String(E2E.DB_PORT),
    DATABASE_URL: E2E_DB_URL,
    DIRECT_URL: E2E_DB_URL,
    MT_E2E_DATABASE_URL: E2E_DB_URL,
    AUTH_SECRET: E2E.AUTH_SECRET,
    AUTH_TRUST_HOST: "1",
    NEXTAUTH_URL: E2E_BASE_URL,
    NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
    WHATSAPP_API_KEY: E2E.WHATSAPP_API_KEY,
    CRON_SECRET: E2E.CRON_SECRET,
    MT_TEST_MODE: "1",
    MT_TEST_DM_QA_STUB: E2E.DM_QA_STUB,
    MT_TEST_ROUTER_STUB_FILE: E2E.ROUTER_STUB_FILE,
    MT_TEST_EXTRACTOR_STUB_FILE: E2E.EXTRACTOR_STUB_FILE,
    MT_TEST_DM_INTENT_STUB_FILE: E2E.DM_INTENT_STUB_FILE,
    // Phase 1 autonomous onboarding (bot-added → intro → YES → org).
    // ON for the suite so the flow is exercisable; prod keeps it OFF
    // until deliberately flipped (the route no-ops without it).
    ONBOARDING_AUTOSTART: "1",
    // The nightly `none`-bucket shadow sweep. ON for the suite, for the
    // same reason as the line above: prod keeps it behind a flag, but a
    // path the free suite cannot drive is a path nobody exercises — and
    // this one went five nights filing nothing while `gate.ts` rested its
    // containment argument on it (§1.4,
    // MDs/router-accuracy-2026-09-11.md). Nothing runs it implicitly: it
    // has one caller, `GET /api/cron/none-bucket-shadow`, and only
    // `e2e/api/none-bucket-shadow.spec.ts` calls that. What the flag does
    // reach is `bot-health`'s `none-shadow-stale` rule, which is the
    // whole point — the alert has to be provable in a test.
    NONE_BUCKET_SHADOW_ENABLED: "1",
    // Deliberately inert — never let real keys load from any .env file.
    ANTHROPIC_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    RESEND_API_KEY: "",
    EMAIL_FROM: "e2e@localhost.invalid",
    GOOGLE_CLIENT_ID: "e2e-dummy-google-client-id",
    GOOGLE_CLIENT_SECRET: "e2e-dummy-google-client-secret",
  };
  if (live) {
    // PINNED EMPTY, NOT DELETED. The child is spawned with
    // `{ ...process.env, ...thisOverlay }` (run.ts) and Playwright's
    // webServer merges the same way, so DELETING the key here only
    // removes it from the overlay — a stub flag already in the
    // orchestrator's own environment survived into the dev server and
    // the "live" sweep ran entirely off the stub. An empty string
    // overrides it, and every reader's check is a plain truthiness test.
    // helpers/live-llm.ts asserts the result rather than trusting it.
    //
    // THIS ONE PINS `dm-qa.ts`'s scoped-answer stub, and nothing else.
    // (It used to pin `analyzeBatch` too, under the old
    // `MT_TEST_LLM_STUB_FILE` name; §10 step 8 deleted that reader and
    // this PR renamed the variable to say what is left.) A "live"
    // DM-Q&A sweep that echoed the scoped context back would prove
    // nothing about the model. The two seams that decide a WRITE are
    // pinned below.
    env.MT_TEST_DM_QA_STUB = "";
    // Same reasoning, for the router: a "live" sweep must not be able to
    // read a canned route out of a file, and must not be able to have
    // the floor or step 7's route ownership flipped by one either
    // (`RouterStubConfig.floor`, `engineRoutes`). Pinned empty, not
    // deleted.
    env.MT_TEST_ROUTER_STUB_FILE = "";
    // And for the extractor (§10 step 6). A "live" sweep that could read
    // canned FACTS out of a file would be grading its own answer key —
    // the trap `e2e/corpus/README.md` warns about under "Do not
    // 'record' stubs from a live run". Pinned empty, not deleted, for
    // the same reason as the two above.
    env.MT_TEST_EXTRACTOR_STUB_FILE = "";
    // And for the DM surface's only classifier (2026-09-11). A "live"
    // DM sweep that could read a canned intent out of a file would be
    // grading its own answer key in front of a mass DM. Pinned empty,
    // not deleted, for the same reason as the three above.
    env.MT_TEST_DM_INTENT_STUB_FILE = "";
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
    env.MT_SIM_LIVE_LLM = "1";
    // The pipeline's remaining flags, forwarded ONLY on a live run.
    //
    // This is how "the corpus, with the pipeline configured THIS way"
    // becomes runnable: the same 47 incident cases, the same real model,
    // the real router in front, scored against the same baseline. A
    // stubbed run could not answer it — stubbing the router means
    // choosing the routes, which is assuming the conclusion.
    //
    // Live only, deliberately. A stubbed run has no key, so the router
    // fails on every batch; the flags would read as on and mean nothing.
    //
    // ── THE LIST CHANGED TWICE ON 2026-09-06 (§10 step 8) ────────────
    //
    // `ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED` LEFT it,
    // because they were deleted from `pipeline/gate.ts`. Both were
    // reverts and the thing they reverted to was `analyzeBatch`; with it
    // gone, `ATTENDANCE_ENGINE_ENABLED=0` would have meant nobody at all
    // handles `self_att` / `other_att` / `offer` / `unsure`, which is a
    // kill switch for the core write path wearing the name of a tuning
    // lever. Forwarding a name nothing reads would look like an arm of a
    // sweep that cannot exist.
    //
    // STEP 7'S FOUR JOINED it, and their sense INVERTED with the same
    // change: they now default ON, so forwarding them is how a sweep
    // turns a route OFF — the "MatchTime goes quiet on questions and an
    // operator is told" arm, which is a survivable degradation and the
    // reason those four were kept when the other two were deleted.
    //
    // Still forwarded ONLY when the operator set them, so an unmodified
    // `npm run test:corpus:live` is unchanged.
    for (const flag of [
      "ROUTER_GATE_FLOOR_ENABLED",
      "NONE_BUCKET_SHADOW_ENABLED",
      "QUESTION_ENGINE_ENABLED",
      "BALANCER_ENGINE_ENABLED",
      "SCORE_ENGINE_ENABLED",
      "ADMIN_OPS_ENGINE_ENABLED",
    ]) {
      if (process.env[flag]) env[flag] = process.env[flag]!;
    }
    // Cost metering (e2e/replay/meter.ts): the server's Anthropic SDK is
    // pointed at a local proxy that forwards every call verbatim and
    // banks the `usage` block, so a sweep can report MEASURED cost
    // against §8.2 without editing anything under src/.
    //   MT_REPLAY_METER_PORT   — the replay spec owns the proxy.
    //   MT_E2E_LIVE_METER_PORT — run.ts owns it, for every live run, so
    //                            that "no call was ever made" is a fact
    //                            the orchestrator can state rather than
    //                            a possibility nobody checked.
    const meterPort = process.env.MT_REPLAY_METER_PORT || process.env.MT_E2E_LIVE_METER_PORT;
    if (meterPort) {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${meterPort}`;
      if (process.env.MT_REPLAY_METER_PORT) env.MT_REPLAY_METER_PORT = process.env.MT_REPLAY_METER_PORT;
      if (process.env.MT_E2E_LIVE_METER_PORT)
        env.MT_E2E_LIVE_METER_PORT = process.env.MT_E2E_LIVE_METER_PORT;
    }
  }
  return env;
}
