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
  venueLookupStatus: string | null;
  venueResolvedAt: Date | null;
}
const gameOf = (clubName: string) =>
  testDb().one<Game>(
    `SELECT a.id, a.venue, a."venueId", a."venueConfidence", a."venueLookupStatus", a."venueResolvedAt"
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

  // The lookup ran after the answer, failed, and recorded exactly that:
  // "could not check", never "not found".
  await expect.poll(() => geocodeCalls().length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await gameOf("Venue Club Five Hundred"))?.venueLookupStatus, { timeout: 15_000 }).toBe("failed");
  const game = await gameOf("Venue Club Five Hundred");
  expect(game).toMatchObject({ venue: "Hackney Marshes Pitch 4", venueId: null, venueConfidence: null });
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${game!.id}`)).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  await expect(page.getByTestId(`venue-loc-${game!.id}`)).toContainText("We couldn't check this place just now. Try again later.");
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
  expect(game).toMatchObject({ venue: "Wandsworth Common Astro", venueId: null, venueLookupStatus: "failed" });
  expect(await testDb().count(`SELECT count(*) FROM "Venue" WHERE "placeId" = 'ChIJ_e2e_too_late'`)).toBe(0);

  // The organiser's page for the game says it could not check, and offers another try.
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${game!.id}`)).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  await expect(page.getByTestId(`venue-loc-${game!.id}`).getByRole("button", { name: "Try again" })).toBeVisible();
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

/** Run the backfill script against the test database. Never throws: the exit code is part of what is asserted. */
function backfill(args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/backfill-venue-locations.ts", ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const failed = e as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? -1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

const BACKFILL_STUB = {
  geocode: {
    "hackney marshes pitch 4": {
      body: googlePlace({ placeId: "ChIJ_e2e_hackney", address: "Hackney Marshes Centre, London E9 5PF, UK", lat: 51.55, lng: -0.03 }),
    },
    // Google is not sure: a partial match.
    "wandsworth common astro": {
      body: googlePlace({ placeId: "ChIJ_e2e_wandsworth", address: "Wandsworth Common, London SW18, UK", partialMatch: true }),
    },
  },
};
const linked = () => testDb().count(`SELECT count(*) FROM "Activity" WHERE "venueId" IS NOT NULL`);
const venues = () => testDb().count(`SELECT count(*) FROM "Venue"`);

test("the backfill script refuses --org with no value, an unknown club and an unknown argument, before anything is read or written", async () => {
  // The world the three tests above left: two clubs whose lookup failed,
  // the seeded club that was never looked up, and one club already linked.
  clearGeocodeStub();
  setGeocodeStub(BACKFILL_STUB);
  expect(await linked()).toBe(1);

  for (const args of [["--org"], ["--apply", "--org"], ["--org", "--apply"]]) {
    const got = backfill(args);
    expect(got.code, args.join(" ")).toBe(2);
    expect(got.err, args.join(" ")).toContain("--org needs a club id or slug");
    expect(got.err).toContain("Usage:");
    expect(got.out, "nothing was printed as done").toBe("");
  }
  const unknownClub = backfill(["--apply", "--org", "no-such-club"]);
  expect(unknownClub.code).toBe(2);
  expect(unknownClub.err).toContain('No club has the id or slug "no-such-club"');
  const typo = backfill(["--aply"]);
  expect(typo.code).toBe(2);
  expect(typo.err).toContain("Unknown argument: --aply");

  expect(geocodeCalls(), "Google was never asked").toEqual([]);
  expect(await linked(), "and nothing was written to any club").toBe(1);
  expect(await venues()).toBe(1);
});

test("the backfill script stops on a quota answer and at --limit; --org runs one club only", async () => {
  // Quota: one call, then it stops, says so, and exits non-zero.
  clearGeocodeStub();
  setGeocodeStub({ geocode: { "*": { body: { status: "OVER_QUERY_LIMIT", results: [] } } } });
  const quota = backfill([]);
  expect(quota.code).toBe(1);
  expect(quota.out).toContain("STOPPED EARLY: Google answered with a quota or rate limit.");
  expect(quota.out).toContain("1 Google calls.");
  expect(geocodeCalls(), "it did not keep calling").toHaveLength(1);
  expect(await linked()).toBe(1);

  // A refused key stops it the same way.
  clearGeocodeStub();
  setGeocodeStub({ geocode: { "*": { body: { status: "REQUEST_DENIED", results: [] } } } });
  const denied = backfill(["--apply"]);
  expect(denied.code).toBe(1);
  expect(denied.out).toContain("STOPPED EARLY: Google refused the key.");
  expect(geocodeCalls()).toHaveLength(1);
  expect(await linked()).toBe(1);

  // --limit 1: one call, a normal end.
  clearGeocodeStub();
  setGeocodeStub(BACKFILL_STUB);
  const limited = backfill(["--limit", "1"]);
  expect(limited.code).toBe(0);
  expect(limited.out).toContain("STOPPED EARLY: --limit 1 Google calls reached.");
  expect(geocodeCalls()).toHaveLength(1);

  // --org: that club's game and nobody else's.
  clearGeocodeStub();
  setGeocodeStub(BACKFILL_STUB);
  const slug = (await testDb().one<{ slug: string }>(`SELECT slug FROM "Organisation" WHERE name = 'Venue Club Slow'`))!.slug;
  const one = backfill(["--org", slug]);
  expect(one.code).toBe(0);
  expect(one.out).toContain(`1 activities with no place linked in club ${slug}`);
  expect(one.out).toContain("Wandsworth Common Astro");
  expect(one.out).not.toContain("Hackney Marshes Pitch 4");
  expect(geocodeCalls().map((c) => c.address)).toEqual(["Wandsworth Common Astro"]);
  expect(await linked(), "all of the above were dry runs or stopped before anything was found").toBe(1);
});

test("the backfill script: a dry run writes nothing; --apply links high as high and low as low, and confirms nothing", async () => {
  clearGeocodeStub();
  setGeocodeStub(BACKFILL_STUB);

  // ── Dry run ──
  const dry = backfill([]);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain("DRY RUN");
  expect(dry.out).toContain("across EVERY club");
  expect(dry.out).toMatch(/Hackney Marshes Pitch 4\tHackney Marshes Centre, London E9 5PF, UK\thigh\tlink\n/);
  expect(dry.out).toMatch(/Wandsworth Common Astro\tWandsworth Common, London SW18, UK\tlow\tlink-low\n/);
  expect(dry.out).toMatch(/E2E Arena\t\t\tnot-found/);
  expect(dry.out).not.toContain("Goals North Cheam"); // already linked: not looked at
  expect(dry.out).toContain("3 Google calls.");
  expect(dry.out).toContain("Dry run: nothing was written. 2 would be linked with --apply.");
  expect(await linked(), "a dry run links nothing").toBe(1);
  expect(await venues(), "a dry run creates no place").toBe(1);
  expect(await testDb().count(`SELECT count(*) FROM "VenueQuery"`), "and records no answer").toBe(1);
  expect(geocodeCalls()).toHaveLength(3);

  // ── Apply ──
  const applied = backfill(["--apply"]);
  expect(applied.code).toBe(0);
  expect(applied.out).toContain(
    "Applied: 2 activities linked (1 high confidence, 1 low confidence for the organiser to check), 1 recorded as not found. Nothing was marked confirmed.",
  );
  const row = (club: string) =>
    testDb().one<{ venueConfidence: string; venueMatchSource: string; venueLookupStatus: string; venueConfirmedAt: Date | null; venueConfirmedById: string | null; placeId: string }>(
      `SELECT a."venueConfidence", a."venueMatchSource", a."venueLookupStatus", a."venueConfirmedAt", a."venueConfirmedById", v."placeId"
         FROM "Activity" a JOIN "Venue" v ON v.id = a."venueId" JOIN "Organisation" o ON o.id = a."orgId" WHERE o.name = $1`,
      [club],
    );
  expect(await row("Venue Club Five Hundred")).toEqual({
    venueConfidence: "high",
    venueMatchSource: "backfill",
    venueLookupStatus: "found",
    venueConfirmedAt: null,
    venueConfirmedById: null,
    placeId: "ChIJ_e2e_hackney",
  });
  // LOW is linked as low and unconfirmed: the organiser gets the question, not "not found".
  expect(await row("Venue Club Slow")).toEqual({
    venueConfidence: "low",
    venueMatchSource: "backfill",
    venueLookupStatus: "found",
    venueConfirmedAt: null,
    venueConfirmedById: null,
    placeId: "ChIJ_e2e_wandsworth",
  });
  // Google answered nothing for the seeded club's venue: recorded as that.
  expect(await testDb().one(`SELECT "venueId", "venueLookupStatus" FROM "Activity" WHERE venue = 'E2E Arena'`)).toEqual({
    venueId: null,
    venueLookupStatus: "none",
  });
  expect(await testDb().count(`SELECT count(*) FROM "Activity" WHERE "venueConfirmedAt" IS NOT NULL`), "nothing confirmed, anywhere").toBe(0);
  expect(await linked()).toBe(3);
  expect(await venues()).toBe(3);
  expect(await testDb().all(`SELECT key, confidence FROM "VenueQuery" ORDER BY key`)).toEqual([
    { key: "GB|goals north cheam", confidence: "high" },
    { key: "GB|hackney marshes pitch 4", confidence: "high" },
    { key: "GB|wandsworth common astro", confidence: "low" },
  ]);

  // Running it again is harmless: the linked games are no longer looked at.
  const again = backfill(["--apply"]);
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("Hackney Marshes Pitch 4");
  expect(again.out).not.toContain("Wandsworth Common Astro");
  expect(again.out).toContain("Applied: 0 activities linked");
  expect(await linked()).toBe(3);
});

test("the low confidence game the backfill linked shows its organiser the question, in amber", async ({ page }) => {
  await signInAs(page, "e2e-venue-org-slow", "/admin/activities");
  await page.goto("/admin/activities");
  const game = await gameOf("Venue Club Slow");
  const l = page.getByTestId(`venue-loc-${game!.id}`);
  await expect(l).toHaveAttribute("data-state", "low", { timeout: 30_000 });
  await expect(l).toContainText("We are not sure this is where you play.");
  await expect(l).toContainText("Is this the right place?");
  await expect(l.getByTestId("venue-loc-address")).toHaveText("Wandsworth Common, London SW18, UK");
});

test("the cap under real concurrency, the query cache and pin cleanup, against Postgres (tsx)", async () => {
  test.setTimeout(180_000);
  let stdout = "";
  try {
    stdout = execFileSync("npx", ["tsx", "e2e/helpers/venue-lib-tests.ts"], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 170_000,
    });
  } catch (e) {
    const failed = e as { stdout?: string; stderr?: string };
    throw new Error(`venue lib tests failed:\n${failed.stdout ?? ""}\n${failed.stderr ?? ""}`);
  }
  expect(stdout).toContain("OK: 6 venue checks against Postgres");
});
