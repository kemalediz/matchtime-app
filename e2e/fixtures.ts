/**
 * Shared Playwright fixtures + helpers for the MatchTime e2e suite.
 *
 * Auth strategy: magic-link tokens (signed with the TEST AUTH_SECRET —
 * see helpers/env.ts) establish a real NextAuth session by visiting
 * /r/<token>, exactly like a player tapping a WhatsApp link.
 *
 * DB access from specs goes through the pg-based TestDb (helpers/
 * test-db.ts); full reseeds shell out to the tsx seed (resetDb).
 */
import { execFileSync } from "node:child_process";
import { test as base, expect, type Page, type APIRequestContext } from "@playwright/test";
import { signMagicLinkToken } from "@/lib/magic-link";
import { testDb, TestDb } from "./helpers/test-db";
import { E2E, REPO_ROOT } from "./helpers/env";
import { clearPipelineStubs } from "./helpers/stub";
import { U } from "./helpers/constants";

export const test = base.extend<{ db: TestDb }>({
  // (named "provide" rather than Playwright's conventional "use" so the
  // react-hooks lint rule doesn't mistake the fixture for a hook call;
  // browserName is destructured only because Playwright requires the
  // object-destructuring pattern for the first fixture argument)
  db: async ({ browserName }, provide) => {
    void browserName;
    await provide(testDb());
  },
});

export { expect, U };

/**
 * Wipe + reseed the ISOLATED test DB to the canonical fixture world, and
 * empty BOTH pipeline stub seams.
 *
 * The stubs are cleared here rather than in each spec's `afterEach`
 * because the two files are per-CHECKOUT and long-lived: a spec that
 * arms a route and then fails leaves that route armed for whatever runs
 * next, and the next spec would pass or fail against a world nobody
 * wrote. `resetDb` is already the "start from a known world" call every
 * spec file makes, and the routes and facts ARE part of that world now.
 */
export function resetDb(): void {
  execFileSync("npx", ["tsx", "e2e/helpers/seed-cli.ts"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    env: process.env,
  });
  clearPipelineStubs();
}

/** Mint a magic-link token for a seeded user (test AUTH_SECRET). */
export function mintToken(
  userId: string,
  opts: { nextPath?: string; matchId?: string; purpose?: "sign-in" | "rate-match"; ttlSeconds?: number } = {},
): string {
  return signMagicLinkToken({
    userId,
    purpose: opts.purpose ?? "sign-in",
    ...(opts.matchId ? { matchId: opts.matchId } : {}),
    ...(opts.nextPath ? { nextPath: opts.nextPath } : {}),
    ttlSeconds: opts.ttlSeconds ?? 60 * 60,
  });
}

/** Sign the page's browser context in AS the given seeded user by
 *  driving the real /r/<token> flow, then wait until we've left /r/. */
export async function signInAs(page: Page, userId: string, nextPath?: string): Promise<void> {
  const token = mintToken(userId, { nextPath });
  await page.goto(`/r/${token}`);
  await page.waitForURL((url) => !url.pathname.startsWith("/r/"), { timeout: 30_000 });
}

export const asAdmin = (page: Page, nextPath?: string) => signInAs(page, U.admin, nextPath);
export const asPlayer = (page: Page, nextPath?: string) => signInAs(page, U.player, nextPath);
export const asCollector = (page: Page, nextPath?: string) => signInAs(page, U.collector, nextPath);

/** POST a batch to /api/whatsapp/analyze the way the Pi bot does. */
export async function postAnalyze(
  request: APIRequestContext,
  messages: Array<{
    waMessageId: string;
    body: string;
    authorPhone: string;
    authorName: string | null;
    /** Simulate an @Match Time tag (interaction-contract gate signal). */
    botMentioned?: boolean;
    /** Raw WhatsApp mention JIDs, exactly as the Pi forwards them. */
    mentions?: string[];
    /** Per-JID display names the Pi's contact lookup produced. UNVERIFIED
     *  — the route checks each against the org roster. */
    mentionNames?: Array<{ jid: string; name: string }>;
    /** The message's ORIGINAL WhatsApp send time, ISO. Defaults to now;
     *  set it to replay a copy that arrived late. */
    timestamp?: string;
  }>,
) {
  const res = await request.post("/api/whatsapp/analyze", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: {
      groupId: E2E.GROUP_ID,
      messages: messages.map((m) => ({ ...m, timestamp: m.timestamp ?? new Date().toISOString() })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
