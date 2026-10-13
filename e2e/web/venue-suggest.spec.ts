/**
 * VENUE SUGGESTIONS: the list of real places under the venue box, end to
 * end in a browser against a real Postgres (2026-10-13).
 *
 * The box is on /create-org (the club setup form) and, on
 * /admin/activities, in the new game, edit game and Change boxes.
 *
 *   - pick a suggestion and create the club: the SERVER asks Google what
 *     the picked place is (Place Details, same session token) and stores
 *     that exact place, high confidence, confirmed by the organiser;
 *   - type free text with no suggestion and create the club: accepted
 *     exactly as typed;
 *   - the service failing: no list, no error, and the form still works;
 *   - the text edited after a pick: the pick is dropped, it is free text;
 *   - a place id Google does not resolve: the typed text is looked up
 *     instead, and the club is still created;
 *   - keyboard: Down, Up, Enter, Escape;
 *   - phone width, and the page does not move when the list opens;
 *   - Turkish; the per-person hourly cap; signed out.
 *
 * GOOGLE IS A STUB (e2e/helpers/geocode-stub.ts): the server under test
 * never uses the network, and the spec asserts exactly what it would
 * have sent. The stubbed bodies are the Places API (New) documented
 * shapes. No model is involved anywhere.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import { E2E_BASE_URL } from "../helpers/env";
import {
  clearGeocodeStub,
  geocodeCalls,
  googlePlace,
  placeDetailsBody,
  placesCalls,
  placesSuggestions,
  setGeocodeStub,
  type GeocodeStub,
} from "../helpers/geocode-stub";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const CROYDON = { placeId: "ChIJ_e2e_croydon_01", name: "Powerleague Croydon", address: "Purley Way, Croydon CR0 4RQ, UK", lat: 51.3562, lng: -0.1167 };
const SHOREDITCH = { placeId: "ChIJ_e2e_shoreditch1", name: "Powerleague Shoreditch", address: "Braithwaite Street, London E1 6GJ, UK", lat: 51.5229, lng: -0.0757 };
const GHOST_ID = "ChIJ_e2e_ghost_0001";

const POWERLEAGUES = placesSuggestions([
  { placeId: CROYDON.placeId, main: "Powerleague Croydon", secondary: "Purley Way, Croydon, UK" },
  { placeId: SHOREDITCH.placeId, main: "Powerleague Shoreditch", secondary: "Braithwaite Street, London, UK" },
  { placeId: "ChIJ_e2e_wembley_001", main: "Powerleague Wembley", secondary: "Engineers Way, Wembley, UK" },
]);

const STUB: GeocodeStub = {
  places: {
    autocomplete: {
      "powerleague croy": { body: POWERLEAGUES },
      // Google is down for this one.
      "broken service": { httpStatus: 500, body: { error: { code: 500, status: "INTERNAL" } } },
      // Suggested, but Place Details does not know it (no entry below: a 404).
      "ghost place": { body: placesSuggestions([{ placeId: GHOST_ID, main: "Ghost Place", secondary: "Nowhere Road, London, UK" }]) },
    },
    details: {
      [CROYDON.placeId]: { body: placeDetailsBody(CROYDON) },
      [SHOREDITCH.placeId]: { body: placeDetailsBody(SHOREDITCH) },
    },
  },
  geocode: {
    "ghost place": { body: googlePlace({ placeId: "ChIJ_e2e_ghost_geo", address: "Ghost Lane, London N1 1AA, UK" }) },
  },
};

async function flag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-self-join", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

/** A user with a phone verified by a used WhatsApp code, and no club. */
async function verifiedUser(id: string, phone: string, name: string) {
  const db = testDb();
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
    [id, name, `${id}@e2e.local`, phone],
  );
  await db.run(
    `INSERT INTO "PhoneOtp" (id, phone, code, "expiresAt", "usedAt", attempts, "createdAt") VALUES ($1,$2,'123456',now(),now(),0,now())`,
    [`${id}-otp`, phone.replace(/\D/g, "")],
  );
}

interface GameRow {
  venue: string;
  venueId: string | null;
  venueConfidence: string | null;
  venueMatchSource: string | null;
  venueLookupStatus: string | null;
  venueConfirmedById: string | null;
  placeId: string | null;
  formattedAddress: string | null;
  lat: number | null;
  lng: number | null;
}
const GAME_SQL = `SELECT a.venue, a."venueId", a."venueConfidence", a."venueMatchSource", a."venueLookupStatus", a."venueConfirmedById",
                         v."placeId", v."formattedAddress", v.lat, v.lng
                    FROM "Activity" a LEFT JOIN "Venue" v ON v.id = a."venueId"`;
const gameOfClub = (clubName: string) =>
  testDb().one<GameRow>(`${GAME_SQL} JOIN "Organisation" o ON o.id = a."orgId" WHERE o.name = $1`, [clubName]);
const seededGame = () => testDb().one<GameRow>(`${GAME_SQL} WHERE a.id = $1`, [ACTIVITY_ID]) as Promise<GameRow>;

/** The lookup runs after the save has answered: wait until it reported. */
async function settled(read: () => Promise<GameRow | null>): Promise<GameRow> {
  await expect
    .poll(async () => (await read())?.venueLookupStatus ?? null, { timeout: 30_000 })
    .toMatch(/^(found|none|failed|capped)$/);
  return (await read())!;
}

const popup = (page: Page) => page.getByTestId("venue-suggest-popup");
/** The suggestions only (a `<select>` has options of its own). */
const options = (page: Page) => popup(page).getByRole("option");

/** /create-org, signed in as a fresh verified user, with the form's fixed fields filled. */
async function setupForm(page: Page, context: BrowserContext, userId: string, phone: string, clubName: string) {
  await verifiedUser(userId, phone, "Vera Venue");
  await flag(context, true);
  await signInAs(page, userId);
  await page.goto("/create-org");
  await expect(page.getByRole("heading", { name: "Set up your club" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Club name").fill(clubName);
  await page.getByLabel("Kick-off time").fill("20:00");
  return page.getByRole("combobox", { name: "Venue" });
}

async function createClub(page: Page) {
  await page.getByRole("button", { name: "Create club" }).click();
  await page.waitForURL("**/admin", { timeout: 30_000 });
}

test.beforeAll(() => {
  resetDb();
  clearGeocodeStub();
  setGeocodeStub(STUB);
});

test.afterAll(async () => {
  clearGeocodeStub();
  await testDb().run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  await testDb().run(`DELETE FROM "VenueSuggestUsage"`);
});

test("create a club: type, pick a suggestion, and the exact place is stored by the SERVER", async ({ page, context }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const venue = await setupForm(page, context, "e2e-vs-pick", "+447700900971", "Pickers FC");

  // An ordinary text box until something is typed: no list, nothing sent.
  await expect(venue).toHaveAttribute("aria-expanded", "false");
  await expect(venue).toHaveAttribute("aria-autocomplete", "list");
  await expect(page.getByTestId("sj-venue-hint")).toHaveText(
    "Pick your venue from the list, or keep what you typed. What you type here is sent to Google to suggest places.",
  );
  expect(placesCalls()).toEqual([]);
  const submit = page.getByRole("button", { name: "Create club" });
  const before = await submit.boundingBox();
  const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);

  // Two characters: still nothing sent.
  await venue.fill("Po");
  await page.waitForTimeout(700);
  expect(placesCalls()).toEqual([]);

  await venue.fill("Powerleague Croy");
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  await expect(venue).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("listbox", { name: "Suggested places" })).toBeVisible();
  await expect(options(page)).toHaveCount(3);
  await expect(options(page).nth(0)).toContainText("Powerleague Croydon");
  await expect(options(page).nth(0)).toContainText("Purley Way, Croydon, UK");
  // Google's required attribution, in the list.
  await expect(popup(page).getByTestId("venue-suggest-attribution")).toHaveText("Powered by Google");
  await expect(page.getByTestId("venue-suggest-status")).toHaveText("3 suggestions. Use the arrow keys to choose.");
  await expect(page.getByTestId("venue-suggest-status")).toHaveAttribute("role", "status");

  // THE PAGE DOES NOT MOVE: the list lies over what is below the box.
  const during = await submit.boundingBox();
  expect(during!.y, "the button under the box did not move").toBe(before!.y);
  expect(await page.evaluate(() => document.documentElement.scrollHeight), "the page did not grow").toBe(heightBefore);
  // Phone width: no sideways scroll, and the list fits the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const box = await popup(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  // No Google script, no map, no key in the browser.
  expect(await page.locator('script[src*="google"], script[src*="maps"], iframe').count()).toBe(0);
  expect(await page.content()).not.toContain("e2e-dummy-maps-key-never-real");

  // Tap one.
  await options(page).nth(0).click();
  await expect(popup(page)).toBeHidden();
  await expect(venue).toHaveValue("Powerleague Croydon");
  await expect(venue).toBeFocused();

  await createClub(page);
  const game = await settled(() => gameOfClub("Pickers FC"));
  expect(game).toEqual({
    venue: "Powerleague Croydon",
    venueId: game.venueId,
    venueConfidence: "high",
    venueMatchSource: "pick",
    venueLookupStatus: "found",
    venueConfirmedById: "e2e-vs-pick",
    // Every one of these came from "Google's" Place Details answer.
    placeId: CROYDON.placeId,
    formattedAddress: CROYDON.address,
    lat: CROYDON.lat,
    lng: CROYDON.lng,
  });

  // What the server sent Google: one Autocomplete, then Place Details for
  // the picked place with the SAME session token and the four-field mask.
  const calls = placesCalls();
  expect(calls).toHaveLength(2);
  const token = calls[0].sessionToken!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{1,36}$/);
  expect(calls[0]).toEqual({
    kind: "autocomplete",
    method: "POST",
    input: "Powerleague Croy",
    sessionToken: token,
    languageCode: "en",
    bodyKeys: ["input", "languageCode", "sessionToken"],
    hasKey: true,
    fieldMask: "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text",
  });
  expect(calls[1]).toEqual({
    kind: "place-details",
    method: "GET",
    placeId: CROYDON.placeId,
    sessionToken: token,
    languageCode: "en",
    params: ["languageCode", "sessionToken"],
    hasKey: true,
    fieldMask: "id,displayName,formattedAddress,location",
  });
  // The picked place needed no lookup of the text.
  expect(geocodeCalls()).toEqual([]);
  // A pick answers no query: the shared query cache is untouched.
  expect(await testDb().count(`SELECT count(*) FROM "VenueQuery"`)).toBe(0);
});

test("create a club with FREE TEXT and no suggestion: accepted exactly as typed", async ({ page, context }) => {
  const venue = await setupForm(page, context, "e2e-vs-free", "+447700900972", "Cagers FC");
  const placesBefore = placesCalls().length;
  const geoBefore = geocodeCalls().length;

  await venue.fill("School cage behind the library");
  // Google was asked and had nothing: no list, and nothing in the way.
  await expect.poll(() => placesCalls().length, { timeout: 15_000 }).toBe(placesBefore + 1);
  await page.waitForTimeout(300);
  await expect(popup(page)).toHaveCount(0);
  await expect(venue).toHaveAttribute("aria-expanded", "false");

  await createClub(page);
  const game = await settled(() => gameOfClub("Cagers FC"));
  expect(game).toMatchObject({
    venue: "School cage behind the library",
    venueId: null,
    venueMatchSource: null,
    // The ordinary background lookup of the text ran, and found nothing.
    venueLookupStatus: "none",
    venueConfirmedById: null,
  });
  expect(placesCalls().slice(placesBefore).map((c) => c.kind)).toEqual(["autocomplete"]);
  expect(geocodeCalls().slice(geoBefore).map((c) => c.address)).toEqual(["School cage behind the library"]);
});

test("the suggestion service FAILING: no list, no error, and the club is still created", async ({ page, context }) => {
  const venue = await setupForm(page, context, "e2e-vs-down", "+447700900973", "Downtime FC");
  const placesBefore = placesCalls().length;
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/venue/suggest") && r.status() !== 200) failed.push(`${r.status()}`);
  });

  await venue.fill("Broken service");
  await expect.poll(() => placesCalls().length, { timeout: 15_000 }).toBe(placesBefore + 1);
  await page.waitForTimeout(300);
  await expect(popup(page)).toHaveCount(0);
  // The route answered a plain empty list: the browser never saw an error.
  expect(failed).toEqual([]);
  await expect(page.locator(".bg-red-50")).toHaveCount(0);
  await expect(venue).toHaveValue("Broken service");

  await createClub(page);
  expect((await settled(() => gameOfClub("Downtime FC"))).venue).toBe("Broken service");
});

test("the text EDITED AFTER A PICK: the pick is dropped and it is free text again", async ({ page, context }) => {
  const venue = await setupForm(page, context, "e2e-vs-edit", "+447700900974", "Editors FC");
  const placesBefore = placesCalls().length;
  const geoBefore = geocodeCalls().length;

  await venue.fill("Powerleague Croy");
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  await options(page).nth(0).click();
  await expect(venue).toHaveValue("Powerleague Croydon");
  // The organiser types on: this is their own name for the place now.
  await venue.pressSequentially(" pitch 4");
  await expect(venue).toHaveValue("Powerleague Croydon pitch 4");

  await createClub(page);
  const game = await settled(() => gameOfClub("Editors FC"));
  expect(game.venue).toBe("Powerleague Croydon pitch 4");
  expect(game.venueMatchSource).not.toBe("pick");
  expect(game.venueConfirmedById).toBeNull();
  // No Place Details call: the place id never left the browser.
  expect(placesCalls().slice(placesBefore).filter((c) => c.kind === "place-details")).toEqual([]);
  // The text was looked up like any other typed venue.
  expect(geocodeCalls().slice(geoBefore).map((c) => c.address)).toEqual(["Powerleague Croydon pitch 4"]);
});

test("a picked place Google does not resolve: the typed text is looked up instead, and the club is still created", async ({ page, context }) => {
  const venue = await setupForm(page, context, "e2e-vs-ghost", "+447700900975", "Ghosts FC");
  const placesBefore = placesCalls().length;
  const geoBefore = geocodeCalls().length;

  await venue.fill("Ghost place");
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  await options(page).nth(0).click();
  await expect(venue).toHaveValue("Ghost Place");

  await createClub(page);
  const game = await settled(() => gameOfClub("Ghosts FC"));
  // Exactly what a typed venue gets: a text match, NOT confirmed.
  expect(game).toMatchObject({
    venue: "Ghost Place",
    venueMatchSource: "text",
    venueLookupStatus: "found",
    venueConfirmedById: null,
    placeId: "ChIJ_e2e_ghost_geo",
  });
  expect(placesCalls().slice(placesBefore).map((c) => [c.kind, c.placeId ?? c.input])).toEqual([
    ["autocomplete", "Ghost place"],
    ["place-details", GHOST_ID],
  ]);
  expect(geocodeCalls().slice(geoBefore).map((c) => c.address)).toEqual(["Ghost Place"]);
});

test("KEYBOARD on the edit form: Down and Up move, Escape closes, Enter picks, and Enter with no list saves", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${ACTIVITY_ID}`)).toBeVisible({ timeout: 30_000 });
  const before = await seededGame();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.locator("form").filter({ hasText: "Save changes" });
  const venue = page.getByTestId("edit-activity-venue");
  await expect(venue).toHaveValue(before.venue);
  await expect(venue).toHaveAttribute("role", "combobox");

  await venue.fill("Powerleague Croy");
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  // Nothing is highlighted until an arrow is pressed.
  await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);
  await expect(venue).not.toHaveAttribute("aria-activedescendant", /.+/);

  const active = () => page.locator('[role="option"][aria-selected="true"]');
  await venue.press("ArrowDown");
  await expect(active()).toContainText("Powerleague Croydon");
  await expect(venue).toHaveAttribute("aria-activedescendant", (await active().getAttribute("id"))!);
  await venue.press("ArrowDown");
  await expect(active()).toContainText("Powerleague Shoreditch");
  await venue.press("ArrowUp");
  await expect(active()).toContainText("Powerleague Croydon");
  // Up from the first wraps to the last.
  await venue.press("ArrowUp");
  await expect(active()).toContainText("Powerleague Wembley");

  // Escape closes the list and nothing else: the form stays, the text stays.
  await venue.press("Escape");
  await expect(popup(page)).toBeHidden();
  await expect(form).toBeVisible();
  await expect(venue).toHaveValue("Powerleague Croy");
  await expect(venue).toBeFocused();

  // Down opens it again on the first; Down again, then Enter picks the second.
  await venue.press("ArrowDown");
  await expect(active()).toContainText("Powerleague Croydon");
  await venue.press("ArrowDown");
  await venue.press("Enter");
  await expect(popup(page)).toBeHidden();
  await expect(venue).toHaveValue("Powerleague Shoreditch");
  // That Enter picked; it did NOT submit the form.
  await expect(form).toBeVisible();
  expect((await seededGame()).venue).toBe(before.venue);

  // Enter with no list is the form's, as in any text box.
  const placesBefore = placesCalls().length;
  await venue.press("Enter");
  await expect(form).toBeHidden({ timeout: 30_000 });
  const game = await settled(seededGame);
  expect(game).toMatchObject({
    venue: "Powerleague Shoreditch",
    venueConfidence: "high",
    venueMatchSource: "pick",
    venueConfirmedById: U.admin,
    placeId: SHOREDITCH.placeId,
    formattedAddress: SHOREDITCH.address,
  });
  expect(placesCalls().slice(placesBefore).map((c) => [c.kind, c.placeId])).toEqual([["place-details", SHOREDITCH.placeId]]);

  // The confirm line is quiet: the organiser picked this exact place.
  const line = page.getByTestId(`venue-loc-${ACTIVITY_ID}`);
  await expect(line).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });
  await expect(line.getByTestId("venue-loc-address")).toHaveText(SHOREDITCH.address);
});

test("the Change box: a picked place replaces the location and keeps the venue name; a pasted link asks for no suggestions", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await page.goto("/admin/activities");
  const line = page.getByTestId(`venue-loc-${ACTIVITY_ID}`);
  await expect(line).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });

  await line.getByRole("button", { name: "Change" }).click();
  const box = line.getByLabel("Address or map link");
  await expect(box).toHaveAttribute("role", "combobox");
  await expect(line).toContainText("What you type here is sent to Google to suggest places.");

  // A pasted map link is read as before: no suggestion call at all.
  const placesBefore = placesCalls().length;
  await box.fill("https://www.google.com/maps/place/Our+Pitch/@51.52,-0.07,17z");
  await page.waitForTimeout(900);
  expect(placesCalls().length).toBe(placesBefore);
  await expect(popup(page)).toHaveCount(0);

  await box.fill("Powerleague Croy");
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  await popup(page).getByRole("option").nth(0).click();
  await expect(box).toHaveValue("Powerleague Croydon");
  await line.getByRole("button", { name: "Find place" }).click();

  await expect(line.getByTestId("venue-loc-address")).toHaveText(CROYDON.address, { timeout: 30_000 });
  await expect(line).toHaveAttribute("data-state", "confirmed");
  expect(await seededGame()).toMatchObject({
    // The name the group reads is untouched.
    venue: "Powerleague Shoreditch",
    venueMatchSource: "pick",
    venueConfidence: "high",
    venueConfirmedById: U.admin,
    placeId: CROYDON.placeId,
    lat: CROYDON.lat,
    lng: CROYDON.lng,
  });
  const calls = placesCalls().slice(placesBefore);
  expect(calls.map((c) => c.kind)).toEqual(["autocomplete", "place-details"]);
  expect(calls[1].sessionToken).toBe(calls[0].sessionToken);
});

test("typing a whole name is ONE call or a few, never one per keystroke; and a new game can be made with a pick", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${ACTIVITY_ID}`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Create activity" }).click();
  const form = page.locator("form").filter({ hasText: "Match duration" });
  await form.getByPlaceholder("e.g. Tuesday 7-a-side").fill("Thursday 5s");

  const venue = page.getByTestId("new-activity-venue");
  const placesBefore = placesCalls().length;
  // Sixteen keystrokes, 25 ms apart: the box waits for a pause before asking.
  await venue.pressSequentially("Powerleague Croy", { delay: 25 });
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  const asked = placesCalls().slice(placesBefore);
  expect(asked.length, "far fewer calls than keystrokes").toBeLessThanOrEqual(4);
  expect(asked[asked.length - 1].input).toBe("Powerleague Croy");
  // One session for the whole exchange.
  expect(new Set(asked.map((c) => c.sessionToken)).size).toBe(1);

  await popup(page).getByRole("option", { name: /Powerleague Croydon/ }).click();
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });

  const read = () => testDb().one<GameRow>(`${GAME_SQL} WHERE a.name = 'Thursday 5s' AND a."orgId" = $1`, [ORG_ID]);
  expect(await settled(read)).toMatchObject({
    venue: "Powerleague Croydon",
    venueMatchSource: "pick",
    venueConfirmedById: U.admin,
    placeId: CROYDON.placeId,
  });
  // The same place as the seeded game's: ONE shared row for it.
  expect(await testDb().count(`SELECT count(*) FROM "Venue" WHERE "placeId" = $1`, [CROYDON.placeId])).toBe(1);
  await testDb().run(`DELETE FROM "Activity" WHERE name = 'Thursday 5s' AND "orgId" = $1`, [ORG_ID]);
});

test("Turkish: the list, its attribution and the hint speak the club's language, and Google is asked in Turkish", async ({ page }) => {
  await testDb().run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/activities");
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${ACTIVITY_ID}`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.locator("form").filter({ hasText: "Save changes" });
  await expect(form).toContainText("Sahanızı listeden seçin ya da yazdığınız haliyle bırakın.");
  await expect(form).toContainText("Buraya yazdıklarınız, yer önerilebilmesi için Google'a gönderilir.");

  const placesBefore = placesCalls().length;
  await page.getByTestId("edit-activity-venue").fill("Powerleague Croy");
  await expect(popup(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("listbox", { name: "Önerilen yerler" })).toBeVisible();
  await expect(popup(page).getByTestId("venue-suggest-attribution")).toHaveText("Google tarafından desteklenmektedir");
  await expect(form.getByTestId("venue-suggest-status")).toHaveText("3 öneri. Seçmek için ok tuşlarını kullanın.");
  expect(placesCalls().slice(placesBefore)[0].languageCode).toBe("tr");

  await testDb().run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("the per-person cap: after 120 calls in the hour the box is a plain text box, and saving still works", async ({ page }) => {
  // The 120 are on record for this hour (and the next, in case the clock turns over mid-test).
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (const start of [hour, hour + 3_600_000]) {
    const iso = new Date(start).toISOString();
    await testDb().run(
      `INSERT INTO "VenueSuggestUsage" (key, "userId", "windowStart", count) VALUES ($1,$2,$3,120)
       ON CONFLICT (key) DO UPDATE SET count = 120`,
      [`${U.admin}|${iso}`, U.admin, iso],
    );
  }
  await signInAs(page, U.admin, "/admin/activities");
  await page.goto("/admin/activities");
  await expect(page.getByTestId(`venue-loc-${ACTIVITY_ID}`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.locator("form").filter({ hasText: "Save changes" });
  const venue = page.getByTestId("edit-activity-venue");

  const placesBefore = placesCalls().length;
  const answered = page.waitForResponse((r) => r.url().includes("/api/venue/suggest"));
  await venue.fill("Powerleague Croy");
  const res = await answered;
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ suggestions: [] });
  await expect(popup(page)).toHaveCount(0);
  // Google was not called for the refused request.
  expect(placesCalls().length).toBe(placesBefore);

  // Free text still saves.
  await venue.fill("The cage by the canal");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await seededGame()).venue, { timeout: 30_000 }).toBe("The cage by the canal");
  await expect(page.getByRole("heading", { name: "Edit activity" })).toBeHidden({ timeout: 30_000 });

  // Another person is not affected by this one's count: a real row, counted by the real database.
  await testDb().run(`DELETE FROM "VenueSuggestUsage" WHERE "userId" <> $1`, [U.admin]);
  const other = await page.context().browser()!.newContext({ baseURL: E2E_BASE_URL });
  const otherPage = await other.newPage();
  await signInAs(otherPage, "e2e-vs-pick", "/");
  const ok = await otherPage.request.get("/api/venue/suggest?q=Powerleague%20Croy&session=e2e-session-token-1&lang=en");
  expect(((await ok.json()) as { suggestions: unknown[] }).suggestions).toHaveLength(3);
  expect(await testDb().all(`SELECT "userId", count FROM "VenueSuggestUsage" WHERE "userId" = 'e2e-vs-pick'`)).toEqual([
    { userId: "e2e-vs-pick", count: 1 },
  ]);
  await other.close();
  await testDb().run(`DELETE FROM "VenueSuggestUsage"`);
});

test("the route: signed out is refused; signed in it answers placeId, primary and secondary only", async ({ page, browser }) => {
  const anon = await browser.newContext({ baseURL: E2E_BASE_URL });
  const placesBefore = placesCalls().length;
  // The middleware turns a signed-out caller away before the route runs
  // (the route has its own 401 behind it: venue-suggest-route.test.ts).
  // The redirect carries the path only, never what was typed.
  const refused = await anon.request.get("/api/venue/suggest?q=Powerleague%20Croy&session=e2e-session-token-2", { maxRedirects: 0 });
  expect(refused.status()).toBe(307);
  expect(refused.headers().location).toContain("/login");
  expect(refused.headers().location).not.toMatch(/Powerleague|Croy|session-token/);
  expect(placesCalls().length, "nothing is sent for a signed-out caller").toBe(placesBefore);
  await anon.close();

  // Any signed-in person (a plain player too: on /create-org there is no club yet).
  await signInAs(page, U.player, "/");
  const res = await page.request.get("/api/venue/suggest?q=Powerleague%20Croy&session=e2e-session-token-2&lang=en");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(await res.json()).toEqual({
    suggestions: [
      { placeId: CROYDON.placeId, primary: "Powerleague Croydon", secondary: "Purley Way, Croydon, UK" },
      { placeId: SHOREDITCH.placeId, primary: "Powerleague Shoreditch", secondary: "Braithwaite Street, London, UK" },
      { placeId: "ChIJ_e2e_wembley_001", primary: "Powerleague Wembley", secondary: "Engineers Way, Wembley, UK" },
    ],
  });
  // Too short, and a missing session token: an empty list and nothing sent.
  const after = placesCalls().length;
  for (const qs of ["q=Po&session=e2e-session-token-2", "q=Powerleague%20Croy"]) {
    expect(await (await page.request.get(`/api/venue/suggest?${qs}`)).json()).toEqual({ suggestions: [] });
  }
  expect(placesCalls().length).toBe(after);
});
