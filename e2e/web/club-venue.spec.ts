/**
 * PARTNER DISCOVERY, slice P1: the club venue on /admin/settings, end to
 * end in a browser against a real Postgres (2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, section 2.1.
 *
 *   - set ONLY through the venue lookup: typing alone saves nothing (the
 *     Save button stays off), picking a suggestion and saving stores the
 *     exact place the SERVER got from Google, as the club's home venue;
 *   - "Confirm your venue to find clubs near you" shows while the club has
 *     neither an active game with a geocoded venue nor a club venue, and
 *     goes once either exists;
 *   - the reminder's link (#club-venue) lands on the venue row;
 *   - a venue in use is shown as the current state, a card with its name
 *     ("Set from your game" or "Club venue"), and the lookup stays hidden
 *     behind "Change" or "Set a club venue" until tapped (2026-10-22: an
 *     admin read the empty input under a grey line as "no venue set");
 *   - in Turkish.
 *
 * GOOGLE IS A STUB (e2e/helpers/geocode-stub.ts). No model anywhere.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import { clearGeocodeStub, placeDetailsBody, placesCalls, placesSuggestions, setGeocodeStub } from "../helpers/geocode-stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const CROYDON = { placeId: "ChIJ_e2e_cv_croydon", name: "Powerleague Croydon", address: "Purley Way, Croydon CR0 4RQ, UK", lat: 51.3562, lng: -0.1167 };

const home = (db: TestDb) =>
  db.one<{ placeId: string | null; name: string; lat: number | null; lng: number | null }>(
    `SELECT v."placeId", v.name, v.lat, v.lng FROM "Organisation" o JOIN "Venue" v ON v.id = o."homeVenueId" WHERE o.id = $1`,
    [ORG_ID],
  );

const venueRow = (page: Page) => page.getByTestId("club-venue");

test.beforeAll(() => {
  resetDb();
  clearGeocodeStub();
  setGeocodeStub({
    places: {
      autocomplete: { "powerleague croy": { body: placesSuggestions([{ placeId: CROYDON.placeId, main: CROYDON.name, secondary: "Purley Way, Croydon, UK" }]) } },
      details: { [CROYDON.placeId]: { body: placeDetailsBody(CROYDON) } },
    },
  });
});

test.afterAll(async ({ db }) => {
  clearGeocodeStub();
  await db.run(`DELETE FROM "VenueSuggestUsage"`);
  resetDb();
});

test("no venue: the prompt; typing alone saves nothing; a picked place becomes the club venue and the prompt goes", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings#club-venue");
  const row = venueRow(page);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("club-venue-prompt")).toContainText("Confirm your venue to find clubs near you");
  await expect(row.getByTestId("club-venue-prompt")).toContainText("Pick your pitch from the list below.");
  // The reminder's link lands on the row.
  await expect(row).toBeInViewport();

  // The ⓘ.
  await row.getByRole("button", { name: "What is Club venue?" }).click();
  await expect(page.getByRole("dialog")).toContainText("Pick your pitch from the list of real places");
  await page.getByRole("button", { name: "Close" }).click();

  // Typed text with no pick: nothing to save. No postcode or town entry.
  const input = row.getByTestId("club-venue-input");
  const save = row.getByTestId("club-venue-save");
  await input.fill("CR0 4RQ");
  await expect(save).toBeDisabled();

  // Pick a suggestion, and save.
  await input.fill("Powerleague Croy");
  const option = page.getByTestId("venue-suggest-popup").getByRole("option").first();
  await expect(option).toContainText("Powerleague Croydon", { timeout: 15_000 });
  await option.click();
  await expect(input).toHaveValue("Powerleague Croydon");
  await expect(save).toBeEnabled();
  await save.click();

  // Saved: the club venue is the current state, and the lookup closes.
  const card = row.getByTestId("club-venue-home");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("club-venue-current-label")).toHaveText("Club venue");
  await expect(card.getByTestId("club-venue-current-name")).toHaveText("Powerleague Croydon");
  await expect(card.getByTestId("club-venue-current-address")).toHaveText("Purley Way, Croydon CR0 4RQ, UK");
  await expect(row.getByTestId("club-venue-prompt")).toHaveCount(0);
  await expect(row.getByTestId("club-venue-input")).toHaveCount(0);
  await expect(row.getByTestId("club-venue-save")).toHaveCount(0);
  // The SERVER asked Google for the picked place, and stored Google's answer.
  expect(placesCalls().some((c) => c.kind === "place-details" && c.placeId === CROYDON.placeId)).toBe(true);
  expect(await home(db)).toEqual({ placeId: CROYDON.placeId, name: CROYDON.name, lat: CROYDON.lat, lng: CROYDON.lng });

  // "Change" opens the lookup, empty; editing the text after a pick drops it.
  const change = row.getByTestId("club-venue-change");
  await expect(change).toHaveText("Change");
  await change.click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("Powerleague Croy");
  await page.getByTestId("venue-suggest-popup").getByRole("option").first().click();
  await expect(save).toBeEnabled();
  await input.fill("Powerleague Croydonx");
  await expect(save).toBeDisabled();
  // "Cancel" closes it again; the current venue stays.
  await row.getByTestId("club-venue-cancel").click();
  await expect(row.getByTestId("club-venue-input")).toHaveCount(0);
  await expect(card.getByTestId("club-venue-current-name")).toHaveText("Powerleague Croydon");
});

test("a club venue already set shows as the current venue on load, with Change and no open input", async ({ page }) => {
  // The previous test saved Powerleague Croydon as the home venue.
  await signInAs(page, U.admin, "/admin/settings");
  const row = venueRow(page);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("club-venue-home").getByTestId("club-venue-current-name")).toHaveText("Powerleague Croydon");
  await expect(row.getByTestId("club-venue-game")).toHaveCount(0);
  await expect(row.getByTestId("club-venue-prompt")).toHaveCount(0);
  await expect(row.getByTestId("club-venue-input")).toHaveCount(0);
  await expect(row.getByTestId("club-venue-change")).toHaveText("Change");
  await row.getByTestId("club-venue-change").click();
  await expect(row.getByTestId("club-venue-input")).toBeVisible();
  await expect(row.getByTestId("club-venue-save")).toBeDisabled();
});

test("a club whose active game has a geocoded venue sees no prompt, and is told where it is measured from", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = NULL WHERE id = $1`, [ORG_ID]);
  await db.run(
    `INSERT INTO "Venue" (id, "placeId", name, lat, lng, source, "createdAt", "updatedAt") VALUES ('e2e-cv-game', 'ChIJ_e2e_cv_game01', 'E2E Arena Pitches', 51.36, -0.17, 'google', now(), now())`,
  );
  await db.run(`UPDATE "Activity" SET "venueId" = 'e2e-cv-game' WHERE id = $1`, [ACTIVITY_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const row = venueRow(page);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const card = row.getByTestId("club-venue-game");
  await expect(card.getByTestId("club-venue-current-label")).toHaveText("Set from your game");
  await expect(card.getByTestId("club-venue-current-name")).toHaveText("E2E Arena Pitches");
  await expect(card).toContainText("The club venue is used only while you have no active game.");
  await expect(row.getByTestId("club-venue-prompt")).toHaveCount(0);
  // No empty input under the current venue until the admin asks for one.
  await expect(row.getByTestId("club-venue-input")).toHaveCount(0);
  await expect(row.getByTestId("club-venue-save")).toHaveCount(0);
  const set = row.getByTestId("club-venue-change");
  await expect(set).toHaveText("Set a club venue");
  await set.click();
  await expect(row.getByTestId("club-venue-input")).toBeVisible();
  await expect(row.getByTestId("club-venue-save")).toBeDisabled();

  // With a club venue as well, the game's venue stays the one in use, and
  // the club venue is listed under it with "Change".
  await db.run(
    `INSERT INTO "Venue" (id, "placeId", name, "formattedAddress", lat, lng, source, "createdAt", "updatedAt") VALUES ('e2e-cv-home', 'ChIJ_e2e_cv_home01', 'E2E Home Ground', 'Sutton SM1 1AA, UK', 51.37, -0.19, 'google', now(), now())`,
  );
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = 'e2e-cv-home' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  await expect(venueRow(page).getByTestId("club-venue-game").getByTestId("club-venue-current-name")).toHaveText("E2E Arena Pitches", { timeout: 30_000 });
  await expect(venueRow(page).getByTestId("club-venue-home").getByTestId("club-venue-current-name")).toHaveText("E2E Home Ground");
  await expect(venueRow(page).getByTestId("club-venue-home").getByTestId("club-venue-current-address")).toHaveText("Sutton SM1 1AA, UK");
  await expect(venueRow(page).getByTestId("club-venue-change")).toHaveText("Change");
  await expect(venueRow(page).getByTestId("club-venue-input")).toHaveCount(0);
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = NULL WHERE id = $1`, [ORG_ID]);

  // A game that is not active does not count.
  await db.run(`UPDATE "Activity" SET "isActive" = false WHERE id = $1`, [ACTIVITY_ID]);
  await page.reload();
  await expect(venueRow(page).getByTestId("club-venue-prompt")).toBeVisible({ timeout: 30_000 });
  // No venue at all: the lookup is open, with no card and no Change button.
  await expect(venueRow(page).getByTestId("club-venue-input")).toBeVisible();
  await expect(venueRow(page).getByTestId("club-venue-game")).toHaveCount(0);
  await expect(venueRow(page).getByTestId("club-venue-change")).toHaveCount(0);
  await db.run(`UPDATE "Activity" SET "isActive" = true, "venueId" = NULL WHERE id = $1`, [ACTIVITY_ID]);
});

test("in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr', "homeVenueId" = NULL WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const row = venueRow(page);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Kulüp sahası");
  await expect(row.getByTestId("club-venue-prompt")).toContainText("Yakınınızdaki kulüpleri bulmak için sahanızı onaylayın");
  await expect(row.getByTestId("club-venue-input")).toHaveAttribute("placeholder", "Sahanızın adını yazmaya başlayın");
  await expect(row.getByTestId("club-venue-save")).toHaveText("Sahayı kaydet");
  await row.getByRole("button", { name: /Kulüp sahası/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Sahanızı, yazarken çıkan gerçek yerler listesinden seçin.");
  await page.getByRole("button", { name: "Kapat" }).click();

  // The game's venue in use.
  await db.run(`UPDATE "Activity" SET "venueId" = 'e2e-cv-game' WHERE id = $1`, [ACTIVITY_ID]);
  await page.reload();
  const game = venueRow(page).getByTestId("club-venue-game");
  await expect(game.getByTestId("club-venue-current-label")).toHaveText("Maçınızdan alındı", { timeout: 30_000 });
  await expect(game.getByTestId("club-venue-current-name")).toHaveText("E2E Arena Pitches");
  await expect(game).toContainText("Kulüp sahası yalnızca etkin bir maçınız yokken kullanılır.");
  await expect(venueRow(page).getByTestId("club-venue-change")).toHaveText("Kulüp sahası belirle");
  await expect(venueRow(page).getByTestId("club-venue-input")).toHaveCount(0);

  // A club venue, with no game venue.
  await db.run(`UPDATE "Activity" SET "venueId" = NULL WHERE id = $1`, [ACTIVITY_ID]);
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = 'e2e-cv-home' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  const homeCard = venueRow(page).getByTestId("club-venue-home");
  await expect(homeCard.getByTestId("club-venue-current-label")).toHaveText("Kulüp sahası", { timeout: 30_000 });
  await expect(homeCard.getByTestId("club-venue-current-name")).toHaveText("E2E Home Ground");
  await expect(venueRow(page).getByTestId("club-venue-change")).toHaveText("Değiştir");
  await venueRow(page).getByTestId("club-venue-change").click();
  await expect(venueRow(page).getByTestId("club-venue-cancel")).toHaveText("Vazgeç");
  await expect(venueRow(page).getByTestId("club-venue-input")).toHaveAttribute("placeholder", "Sahanızın adını yazmaya başlayın");

  await db.run(`UPDATE "Organisation" SET language = 'en', "homeVenueId" = NULL WHERE id = $1`, [ORG_ID]);
});
