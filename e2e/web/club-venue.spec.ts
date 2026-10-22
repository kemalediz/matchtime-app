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

  await expect(row.getByTestId("club-venue-home")).toContainText("Club venue: Powerleague Croydon, Purley Way, Croydon CR0 4RQ, UK", { timeout: 15_000 });
  await expect(row.getByTestId("club-venue-prompt")).toHaveCount(0);
  // The SERVER asked Google for the picked place, and stored Google's answer.
  expect(placesCalls().some((c) => c.kind === "place-details" && c.placeId === CROYDON.placeId)).toBe(true);
  expect(await home(db)).toEqual({ placeId: CROYDON.placeId, name: CROYDON.name, lat: CROYDON.lat, lng: CROYDON.lng });

  // Editing the text after the pick drops it: Save is off again.
  await input.fill("Powerleague Croydonx");
  await expect(save).toBeDisabled();
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
  await expect(row.getByTestId("club-venue-game")).toContainText("Nearby clubs are measured from your game's venue, E2E Arena Pitches.");
  await expect(row.getByTestId("club-venue-prompt")).toHaveCount(0);

  // A game that is not active does not count.
  await db.run(`UPDATE "Activity" SET "isActive" = false WHERE id = $1`, [ACTIVITY_ID]);
  await page.reload();
  await expect(venueRow(page).getByTestId("club-venue-prompt")).toBeVisible({ timeout: 30_000 });
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
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});
