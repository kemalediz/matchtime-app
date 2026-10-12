/**
 * `expandShortLink` INSIDE THE NEXT SERVER, through the `fetch` Next.js
 * patches, against a real hostile HTTP server on this machine
 * (e2e/helpers/short-link-server.ts). Review of PR #241, fix 9.
 *
 * The same checks pass under plain Node
 * (src/lib/__tests__/map-link-real-fetch.test.ts). They are repeated here
 * because the production code runs in a Next route handler or server
 * action, where `fetch` is not Node's own: `redirect: "manual"`, the
 * abort signal and the unread body have to hold THERE.
 *
 * Reached through /api/test/venue-short-link, a route that answers 404
 * unless the server was booted with MT_TEST_MODE exactly "1" and can
 * reach nothing but 127.0.0.1.
 *
 * Loopback only. No model, no internet.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E_BASE_URL } from "../helpers/env";
import { MAP_TARGET, startShortLinkServer, type ShortLinkServer } from "../helpers/short-link-server";

test.describe.configure({ mode: "serial" });

let server: ShortLinkServer;

const PLACE = { ok: true, target: { kind: "coords", provider: "google", lat: 51.5229437, lng: -0.0757291, label: "Our Pitch" } };

interface Answer {
  result: unknown;
  requested: string[];
  ms: number;
}

async function expand(page: Page, path: string, timeoutMs?: number): Promise<Answer> {
  server.hits.length = 0;
  const res = await page.request.get(
    `/api/test/venue-short-link?port=${server.port}&path=${encodeURIComponent(path)}${timeoutMs ? `&timeoutMs=${timeoutMs}` : ""}`,
    { timeout: 60_000 },
  );
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Answer;
}

test.beforeAll(async () => {
  resetDb();
  server = await startShortLinkServer();
});

test.afterAll(async () => {
  await server.close();
});

test("inside Next: a redirect to a map is read from the Location header in one request", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  expect(MAP_TARGET).toContain("!3d51.5229437");
  // Warm the route up, so the timings below are the expander's and not a first compile.
  await expand(page, "/to-map");
  const got = await expand(page, "/to-map");
  expect(got.result).toEqual(PLACE);
  expect(server.hits).toEqual(["/to-map"]);
});

test("inside Next: redirect 'manual' HOLDS. Next's fetch does not follow the redirect, and neither does the expander", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  const got = await expand(page, "/redir");
  expect(got.result).toEqual({ ok: false, reason: "left-allow-list" });
  expect(server.hits, "/followed was never requested").toEqual(["/redir"]);
  expect(got.requested).toEqual(["https://maps.app.goo.gl/redir"]);
});

test("inside Next: a hop to another host is refused and never requested; a relative hop is followed by hand", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  const other = await expand(page, "/other-host");
  expect(other.result).toEqual({ ok: false, reason: "left-allow-list" });
  expect(other.requested).toEqual(["https://maps.app.goo.gl/other-host"]);
  expect(server.hits).toEqual(["/other-host"]);

  const relative = await expand(page, "/relative");
  expect(relative.result).toEqual(PLACE);
  expect(server.hits).toEqual(["/relative", "/to-map"]);
});

test("inside Next: a host that never sends its headers is cut off by the timeout", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  const got = await expand(page, "/slow-header", 400);
  expect(got.result).toEqual({ ok: false, reason: "timeout" });
  expect(got.ms).toBeLessThan(3000);
});

test("inside Next: an endless body is never read, for a page and for a redirect", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  const before = server.aborted();
  const pageBody = await expand(page, "/endless-page", 5000);
  expect(pageBody.result).toEqual({ ok: false, reason: "no-redirect" });
  expect(pageBody.ms, "did not wait for the body or the timeout").toBeLessThan(2500);

  const redirectBody = await expand(page, "/endless-redirect", 5000);
  expect(redirectBody.result).toEqual(PLACE);
  expect(redirectBody.ms).toBeLessThan(2500);
  // Both connections were dropped by the server under test, mid-body.
  await expect.poll(() => server.aborted() - before, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
});

test("inside Next: a three hop chain ends at the place in exactly three requests; an endless chain stops after three", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  const chain = await expand(page, "/hop1");
  expect(chain.result).toEqual(PLACE);
  expect(server.hits).toEqual(["/hop1", "/hop2", "/maps/hop3"]);
  expect(chain.requested).toEqual(["https://maps.app.goo.gl/hop1", "https://maps.app.goo.gl/hop2", "https://goo.gl/maps/hop3"]);

  const loop = await expand(page, "/loop1");
  expect(loop.result).toEqual({ ok: false, reason: "too-many-hops" });
  expect(server.hits).toEqual(["/loop1", "/loop2", "/loop3"]);
});

test("the test route is test-only by its own check, and a signed-out caller never reaches it", async ({ page, playwright }) => {
  // The route's own gate is `MT_TEST_MODE !== "1"` -> 404, read from the source: this
  // server IS in test mode, so the 404 cannot be shown from here.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/app/api/test/venue-short-link/route.ts", "utf8");
  expect(src).toMatch(/if \(process\.env\.MT_TEST_MODE !== "1"\) return new NextResponse\(null, \{ status: 404 \}\);/);
  expect(src.indexOf('process.env.MT_TEST_MODE !== "1"')).toBeLessThan(src.indexOf("expandShortLink(new URL"));

  // Signed out: the middleware sends the caller to /login before the route runs.
  const anon = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
  const res = await anon.get(`/api/test/venue-short-link?port=${server.port}&path=/to-map`, { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(res.status());
  await anon.dispose();

  // A path or port it does not like is refused.
  await signInAs(page, U.admin, "/");
  expect((await page.request.get(`/api/test/venue-short-link?port=${server.port}&path=http://evil.example`)).status()).toBe(400);
  expect((await page.request.get(`/api/test/venue-short-link?port=abc&path=/to-map`)).status()).toBe(400);
});
