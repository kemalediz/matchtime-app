/**
 * VENUE LOCATION: creating a club never fails and never waits for Google.
 *
 * A new organiser sets up a club WITH its weekly game on /create-org
 * (self-join). The venue is looked up AFTER the club has been created and
 * the organiser has been answered. This spec creates three clubs, against
 * a real Postgres, with "Google" (a stub: e2e/helpers/geocode-stub.ts)
 *
 *   - answering 500,
 *   - not answering for 30 seconds (the server's own limit is 2.5s),
 *   - and answering normally,
 *
 * and asserts every club and its weekly game exist, the organiser lands
 * on the club page promptly, a failed lookup leaves the game with no
 * place (and no error anywhere the organiser can see), and a good one
 * links the place a moment later.
 *
 * It also pins what was sent: the venue text and the country only. Never
 * the club's name, the organiser's name or their phone.
 *
 * Deterministic: no model and no real network anywhere in this flow.
 */
import { execFileSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs } from "../fixtures";
import { E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { clearGeocodeStub, geocodeCalls, googlePlace, setGeocodeStub } from "../helpers/geocode-stub";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

/** Generous for a dev server compiling pages, and far below the 30s the
 *  slow "Google" holds its answer for. */
const PROMPT_MS = 20_000;

async function selfJoinOn(context: BrowserContext) {
  await context.addCookies([{ name: "mt-test-self-join", value: "1", url: E2E_BASE_URL }]);
}

/** A user with a phone verified by a used WhatsApp code, and no club. */
async function verifiedUser(id: string, phone: string, name: string) {
  const db = testDb();
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
     VALUES ($1,$2,$3,$4,true,true,now())`,
    [id, name, `${id}@e2e.local`, phone],
  );
  await db.run(
    `INSERT INTO "PhoneOtp" (id, phone, code, "expiresAt", "usedAt", attempts, "createdAt")
     VALUES ($1,$2,'123456',now(),now(),0,now())`,
    [`${id}-otp`, phone.replace(/\D/g, "")],
  );
}

interface Game {
  id: string;
  venue: string;
  venueId: string | null;
  venueConfidence: string | null;
  venueResolvedAt: Date | null;
}
const gameOf = (clubName: string) =>
  testDb().one<Game>(
    `SELECT a.id, a.venue, a."venueId", a."venueConfidence", a."venueResolvedAt"
       FROM "Activity" a JOIN "Organisation" o ON o.id = a."orgId" WHERE o.name = $1`,
    [clubName],
  );

/** Fill /create-org and submit. Returns how long the organiser waited. */
async function createClub(page: Page, clubName: string, venue: string): Promise<number> {
  await page.goto("/create-org");
  await expect(page.getByRole("heading", { name: "Set up your club" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Club name").fill(clubName);
  await page.getByLabel("Kick-off time").fill("20:00");
  await page.getByLabel("Venue", { exact: true }).fill(venue);
  const started = Date.now();
  await page.getByRole("button", { name: "Create club" }).click();
  await page.waitForURL("**/admin", { timeout: 60_000 });
  return Date.now() - started;
}

test.beforeAll(async ({ browser }) => {
  resetDb();
  clearGeocodeStub();
  await verifiedUser("e2e-venue-org-500", "+447700900971", "Secret Organiser One");
  await verifiedUser("e2e-venue-org-slow", "+447700900972", "Secret Organiser Two");
  await verifiedUser("e2e-venue-org-ok", "+447700900973", "Secret Organiser Three");

  // Warm the pages up so the timings below measure the save, not a first compile.
  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  const page = await context.newPage();
  await page.goto("/login");
  await context.close();
});

test.afterAll(() => {
  clearGeocodeStub();
});

test("Google answers 500: the club and its game are created, promptly, with no place and no error", async ({ page, context }) => {
  setGeocodeStub({ geocode: { "*": { httpStatus: 500, body: { error: "boom" } } } });
  await selfJoinOn(context);
  await signInAs(page, "e2e-venue-org-500", "/create-org");

  const waited = await createClub(page, "Venue Club Five Hundred", "Hackney Marshes Pitch 4");
  expect(waited).toBeLessThan(PROMPT_MS);
  await expect(page.getByTestId("club-connect-card")).toBeVisible({ timeout: 30_000 });

  // The lookup ran after the answer, failed, and left the game alone.
  await expect.poll(() => geocodeCalls().length, { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(1000);
  const game = await gameOf("Venue Club Five Hundred");
  expect(game).toMatchObject({ venue: "Hackney Marshes Pitch 4", venueId: null, venueConfidence: null, venueResolvedAt: null });
  expect(await testDb().count(`SELECT count(*) FROM "Venue"`)).toBe(0);
});

test("Google does not answer for 30 seconds: the organiser is not kept waiting, and the lookup gives up on its own", async ({
  page,
  context,
}) => {
  clearGeocodeStub();
  setGeocodeStub({
    geocode: { "*": { delayMs: 30_000, body: googlePlace({ placeId: "ChIJ_e2e_too_late", address: "Too Late Road, London, UK" }) } },
  });
  await selfJoinOn(context);
  await signInAs(page, "e2e-venue-org-slow", "/create-org");

  const waited = await createClub(page, "Venue Club Slow", "Wandsworth Common Astro");
  expect(waited, "nowhere near the 30 seconds Google is taking").toBeLessThan(PROMPT_MS);
  await expect(page.getByTestId("club-connect-card")).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => geocodeCalls().length, { timeout: 15_000 }).toBe(1);
  // Well past the server's 2.5 second limit: the late answer is never used.
  await page.waitForTimeout(5000);
  const game = await gameOf("Venue Club Slow");
  expect(game).toMatchObject({ venue: "Wandsworth Common Astro", venueId: null, venueResolvedAt: null });
  expect(await testDb().count(`SELECT count(*) FROM "Venue" WHERE "placeId" = 'ChIJ_e2e_too_late'`)).toBe(0);

  // The organiser's page for the game just shows the "add the place" line.
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${game!.id}`)).toHaveAttribute("data-state", "none", { timeout: 40_000 });
});

test("Google answers: the place is linked a moment after the club is created, and only the venue and country were sent", async ({
  page,
  context,
}) => {
  clearGeocodeStub();
  setGeocodeStub({
    geocode: {
      "goals north cheam": { body: googlePlace({ placeId: "ChIJ_e2e_cheam", address: "Goals, North Cheam, Sutton SM3 9BY, UK", lat: 51.37, lng: -0.21 }) },
    },
  });
  await selfJoinOn(context);
  await signInAs(page, "e2e-venue-org-ok", "/create-org");

  const waited = await createClub(page, "Venue Club Secret Name", "Goals North Cheam");
  expect(waited).toBeLessThan(PROMPT_MS);

  await expect.poll(async () => (await gameOf("Venue Club Secret Name"))?.venueId ?? null, { timeout: 20_000 }).not.toBeNull();
  const game = await gameOf("Venue Club Secret Name");
  expect(game).toMatchObject({ venue: "Goals North Cheam", venueConfidence: "high" });
  expect(game!.venueResolvedAt).not.toBeNull();

  const calls = geocodeCalls();
  expect(calls).toEqual([
    { kind: "geocode", address: "Goals North Cheam", placeId: null, region: "uk", params: ["address", "key", "region"] },
  ]);
  expect(JSON.stringify(calls)).not.toMatch(/Secret|447700900973|Venue Club/);

  // The organiser sees it as a question on the game's page.
  await page.goto("/admin/activities");
  const l = page.getByTestId(`venue-loc-${game!.id}`);
  await expect(l).toHaveAttribute("data-state", "question", { timeout: 30_000 });
  await expect(l.getByTestId("venue-loc-address")).toHaveText("Goals, North Cheam, Sutton SM3 9BY, UK");
});

test("the backfill script: a dry run writes nothing, --apply links the high confidence matches only", async () => {
  // The world the three tests above left: two clubs whose lookup failed,
  // the seeded club that was never looked up, and one club already linked.
  clearGeocodeStub();
  setGeocodeStub({
    geocode: {
      "hackney marshes pitch 4": {
        body: googlePlace({ placeId: "ChIJ_e2e_hackney", address: "Hackney Marshes Centre, London E9 5PF, UK", lat: 51.55, lng: -0.03 }),
      },
      // Google is not sure: a partial match.
      "wandsworth common astro": {
        body: googlePlace({ placeId: "ChIJ_e2e_wandsworth", address: "Wandsworth Common, London SW18, UK", partialMatch: true }),
      },
    },
  });
  const run = (args: string[]) =>
    execFileSync("npx", ["tsx", "scripts/backfill-venue-locations.ts", ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const linked = () => testDb().count(`SELECT count(*) FROM "Activity" WHERE "venueId" IS NOT NULL`);
  const venues = () => testDb().count(`SELECT count(*) FROM "Venue"`);
  expect(await linked()).toBe(1);

  // ── Dry run ──
  const dry = run([]);
  expect(dry).toContain("DRY RUN");
  expect(dry).toMatch(/Hackney Marshes Pitch 4\tHackney Marshes Centre, London E9 5PF, UK\thigh\tlink/);
  expect(dry).toMatch(/Wandsworth Common Astro\tWandsworth Common, London SW18, UK\tlow\tlow-confidence/);
  expect(dry).toMatch(/E2E Arena\t\t\tnot-found/);
  expect(dry).not.toContain("Goals North Cheam"); // already linked: not looked at
  expect(dry).toContain("3 Google calls.");
  expect(dry).toContain("Dry run: nothing was written. 1 would be linked with --apply.");
  expect(await linked(), "a dry run links nothing").toBe(1);
  expect(await venues(), "a dry run creates no place").toBe(1);
  expect(geocodeCalls()).toHaveLength(3);

  // ── Apply ──
  const applied = run(["--apply"]);
  expect(applied).toContain("Applied: 1 activities linked.");
  expect(await gameOf("Venue Club Five Hundred")).toMatchObject({ venueConfidence: "high" });
  const source = await testDb().one<{ venueMatchSource: string; venueConfirmedAt: Date | null; placeId: string }>(
    `SELECT a."venueMatchSource", a."venueConfirmedAt", v."placeId" FROM "Activity" a
       JOIN "Venue" v ON v.id = a."venueId" JOIN "Organisation" o ON o.id = a."orgId" WHERE o.name = 'Venue Club Five Hundred'`,
  );
  expect(source).toEqual({ venueMatchSource: "backfill", venueConfirmedAt: null, placeId: "ChIJ_e2e_hackney" });
  // Low confidence and not found are left exactly as they were.
  expect(await gameOf("Venue Club Slow")).toMatchObject({ venueId: null, venueConfidence: null, venueResolvedAt: null });
  expect(await linked()).toBe(2);
  expect(await venues()).toBe(2);

  // Running it again is harmless: the linked game is no longer looked at.
  const again = run(["--apply"]);
  expect(again).not.toContain("Hackney Marshes Pitch 4");
  expect(again).toContain("Applied: 0 activities linked.");
  expect(await linked()).toBe(2);
});
