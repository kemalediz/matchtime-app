/**
 * Single source of truth for every e2e constant. NOTHING in here may
 * point at production — `assertSafeTestDbUrl` is the hard gate that
 * every DB-touching entry point (run.ts, playwright.config.ts,
 * test-db.ts) calls before connecting.
 */
import path from "node:path";
import { existsSync } from "node:fs";

// All entry points (npm scripts, the Playwright runner and its workers)
// run with cwd = repo root. Verified rather than assumed — this file is
// loaded in both CJS (playwright.config) and ESM (e2e/ is "type":
// "module") contexts, so __dirname/import.meta can't be used portably.
export const REPO_ROOT = process.cwd();
if (!existsSync(path.join(REPO_ROOT, "prisma", "schema.prisma"))) {
  throw new Error(`e2e: expected to run from the repo root, got cwd=${REPO_ROOT}`);
}

export const E2E = {
  /** Embedded Postgres — local-only, throwaway cluster under .e2e/. */
  DB_PORT: 54311,
  DB_NAME: "matchtime_test",
  DB_USER: "postgres",
  DB_PASSWORD: "postgres",
  DATA_DIR: path.join(REPO_ROOT, ".e2e", "pgdata"),

  /** Next dev server under test. */
  APP_PORT: 3105,

  /** Test-only secrets — deliberately NOT the prod values, so a token
   *  minted by the tests can never be valid against prod (and vice
   *  versa), and a prod-config'd server would 401 every API spec. */
  AUTH_SECRET: "mt-e2e-only-auth-secret-never-prod",
  WHATSAPP_API_KEY: "mt-e2e-whatsapp-key",
  CRON_SECRET: "mt-e2e-cron-secret",

  /** The LLM stub file the server reads fresh on every analyzeBatch. */
  LLM_STUB_FILE: path.join(REPO_ROOT, ".e2e", "llm-stub.json"),

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
  return {
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
    MT_TEST_LLM_STUB_FILE: E2E.LLM_STUB_FILE,
    // Phase 1 autonomous onboarding (bot-added → intro → YES → org).
    // ON for the suite so the flow is exercisable; prod keeps it OFF
    // until deliberately flipped (the route no-ops without it).
    ONBOARDING_AUTOSTART: "1",
    // Deliberately inert — never let real keys load from any .env file.
    ANTHROPIC_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    RESEND_API_KEY: "",
    EMAIL_FROM: "e2e@localhost.invalid",
    GOOGLE_CLIENT_ID: "e2e-dummy-google-client-id",
    GOOGLE_CLIENT_SECRET: "e2e-dummy-google-client-secret",
  };
}
