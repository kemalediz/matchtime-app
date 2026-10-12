/**
 * VENUE LOCATION: the confirm line under a weekly game's venue on
 * /admin/activities, end to end in a browser against a real Postgres.
 *
 * The line has one look per recorded state, and this spec walks them all:
 *
 *   never      a game that existed before this feature, on first load:
 *              a small neutral line, NOT the amber "couldn't find";
 *   pending    never shown for an edit that schedules no lookup (the time);
 *   failed     Google could not be asked: neutral, with "Try again";
 *   none       Google answered and found nothing: the amber block;
 *   low        found, not sure: the amber question;
 *   question   found and confident: asked about; Yes records who confirmed;
 *   confirmed  quiet.
 *
 * Then Change by a fuller address and by a pasted map link (coordinates
 * in the link, Yandex's longitude-first links, a short Google link, and
 * the links that are refused), Turkish, and what a player of the club and
 * a member of another club can see (nothing of the place).
 *
 * GOOGLE IS A STUB (e2e/helpers/geocode-stub.ts). The server under test
 * never uses the network for this; the spec asserts exactly what it
 * would have sent. No model is involved anywhere.
 *
 * Screenshots of every state, desktop and 360px, are written to
 * test-results/venue-location/ (not committed).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ACTIVITY_ID, MATCH, ORG_ID, SPORT_ID } from "../helpers/constants";
import { E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { clearGeocodeStub, geocodeCalls, googlePlace, setGeocodeStub, type GeocodeStub } from "../helpers/geocode-stub";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SHOTS = path.join(REPO_ROOT, "test-results", "venue-location");
const SHOREDITCH_ADDRESS = "Braithwaite Street, London E1 6GJ, UK";
const WHISTON_ADDRESS = "12 Whiston Road, London E2 8BN, UK";

const STUB: GeocodeStub = {
  geocode: {
    "powerleague shoreditch": { body: googlePlace({ placeId: "ChIJ_e2e_shoreditch", address: SHOREDITCH_ADDRESS }) },
    // One word: a chain with dozens of sites. Google still answers with one.
    powerleague: {
      body: googlePlace({ placeId: "ChIJ_e2e_somewhere", address: "Powerleague, Mill Hill, London NW7 2BE, UK", lat: 51.61, lng: -0.24 }),
    },
    "12 whiston road, london e2 8bn": {
      body: googlePlace({
        placeId: "ChIJ_e2e_whiston",
        address: WHISTON_ADDRESS,
        lat: 51.5352,
        lng: -0.0712,
        types: ["premise"],
        locationType: "ROOFTOP",
      }),
    },
    "goals north cheam, sutton": {
      body: googlePlace({ placeId: "ChIJ_e2e_cheam", address: "Goals, North Cheam, Sutton SM3 9BY, UK", lat: 51.37, lng: -0.21 }),
    },
    // Google is down for this one.
    "broken lane ground": { httpStatus: 500, body: { error: "boom" } },
  },
  shortLinks: {
    "https://maps.app.goo.gl/E2eShort1": {
      location: "https://www.google.com/maps/place/Goals+North+Cheam,+Sutton/data=!4m2!3m1!1s0x0:0x1?entry=ttu",
    },
    "https://maps.app.goo.gl/E2eEvil": { location: "http://169.254.169.254/latest/meta-data/" },
    // What a cookieless server may be sent instead of the map.
    "https://maps.app.goo.gl/E2eConsent": { location: "https://consent.google.com/m?continue=https://www.google.com/maps/@51.5,-0.1,17z" },
  },
};

interface Row {
  venue: string;
  venueId: string | null;
  venueConfidence: string | null;
  venueMatchSource: string | null;
  venueLookupStatus: string | null;
  venueResolvedAt: Date | null;
  venueConfirmedAt: Date | null;
  venueConfirmedById: string | null;
}
const activity = () =>
  testDb().one<Row>(
    `SELECT venue, "venueId", "venueConfidence", "venueMatchSource", "venueLookupStatus",
            "venueResolvedAt", "venueConfirmedAt", "venueConfirmedById"
       FROM "Activity" WHERE id = $1`,
    [ACTIVITY_ID],
  ) as Promise<Row>;

const line = (page: Page) => page.getByTestId(`venue-loc-${ACTIVITY_ID}`);

async function open(page: Page) {
  await page.goto("/admin/activities");
  await expect(line(page)).toBeVisible({ timeout: 30_000 });
}

/** Edit the seeded activity through the page's own dialog. */
async function edit(page: Page, change: { venue?: string; time?: string }) {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.locator("form").filter({ hasText: "Save changes" });
  if (change.venue !== undefined) await form.locator('input:not([type="time"])').nth(1).fill(change.venue);
  if (change.time !== undefined) await form.locator('input[type="time"]').fill(change.time);
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
}
const editVenue = (page: Page, venue: string) => edit(page, { venue });

async function change(page: Page, value: string) {
  const l = line(page);
  if (!(await l.getByTestId("venue-loc-form").isVisible())) {
    await l.getByRole("button", { name: /^(Change|Add the place)$/ }).click();
  }
  await l.getByLabel("Address or map link").fill(value);
  await l.getByRole("button", { name: "Find place" }).click();
}

/** The line at desktop and at 360px, and no sideways scroll on the phone. */
async function shots(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  // Let the "Activity updated" toast go: it would sit over the line.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await line(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, `${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await line(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, `${name}-360.png`), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name}: no sideways scroll at 360px`).toBeLessThanOrEqual(0);
  const box = await line(page).boundingBox();
  expect(box!.x + box!.width, `${name}: the line fits a 360px screen`).toBeLessThanOrEqual(360);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.beforeAll(() => {
  resetDb();
  clearGeocodeStub();
  setGeocodeStub(STUB);
});

test.afterAll(async () => {
  clearGeocodeStub();
  await testDb().run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("first load of a game that existed before this feature: a neutral line, not 'we couldn't find this place'", async ({ page }) => {
  // Exactly what production holds on deploy day: no place, never looked up.
  expect(await activity()).toMatchObject({ venueId: null, venueLookupStatus: null, venueResolvedAt: null });
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  const l = line(page);
  // At once: nothing is inferred from when the row was last saved.
  await expect(l).toHaveAttribute("data-state", "never", { timeout: 5_000 });
  await expect(l).toContainText("Add where you play so MatchTime knows the location.");
  await expect(l).not.toContainText("couldn't find");
  await expect(l).not.toContainText("Looking for this place");
  await expect(l).not.toHaveClass(/amber/);
  expect(await l.locator('[class*="amber"]').count(), "no amber, no warning icon").toBe(0);
  await expect(l.getByRole("button", { name: "Add the place" })).toBeVisible();
  await expect(l.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(l.getByTestId("venue-loc-map")).toHaveCount(0);
  // The organiser's own venue text is still what the page prints.
  await expect(page.getByText("E2E Arena")).toBeVisible();
  expect(geocodeCalls(), "looking at the page looks nothing up").toEqual([]);
  await shots(page, "1-never-looked-up");
});

test("an edit of the time alone schedules no lookup: never 'Looking for this place', and nothing is sent", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  let sawPending = false;
  const watch = setInterval(() => {
    void line(page)
      .getAttribute("data-state")
      .then((s) => {
        if (s === "pending") sawPending = true;
      })
      .catch(() => undefined);
  }, 100);
  await edit(page, { time: "20:30" });
  await expect(page.getByText(/Tuesdays at 20:30/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  clearInterval(watch);
  expect(sawPending, "the line never said a lookup was under way").toBe(false);
  await expect(line(page)).toHaveAttribute("data-state", "never");
  expect(await activity()).toMatchObject({ venueLookupStatus: null, venueResolvedAt: null });
  expect(geocodeCalls()).toEqual([]);
});

test("Google cannot be asked: 'couldn't check just now' with Try again; when Google answers nothing: the amber 'couldn't find'", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  await editVenue(page, "Broken Lane Ground");

  const l = line(page);
  await expect(l).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  await expect(l).toContainText("We couldn't check this place just now. Try again later.");
  await expect(l).not.toContainText("couldn't find");
  expect(await l.locator('[class*="amber"]').count(), "a failed lookup is not a warning").toBe(0);
  expect(await activity()).toMatchObject({ venue: "Broken Lane Ground", venueId: null, venueLookupStatus: "failed" });
  await shots(page, "2-lookup-failed");

  // Still down: Try again asks once more and says the same.
  await l.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => geocodeCalls().length, { timeout: 15_000 }).toBe(2);
  await expect(l).toHaveAttribute("data-state", "failed");

  // Google is back and knows no such place: NOW it is "not found".
  setGeocodeStub({ ...STUB, geocode: { ...STUB.geocode, "broken lane ground": {} } });
  await l.getByRole("button", { name: "Try again" }).click();
  await expect(l).toHaveAttribute("data-state", "none", { timeout: 30_000 });
  await expect(l).toContainText(
    "We couldn't find this place. Add the address or paste a map link so MatchTime knows where you play.",
  );
  await expect(l).toHaveClass(/bg-amber-50/);
  await expect(l.getByRole("button", { name: "Add the place" })).toBeVisible();
  expect(await activity()).toMatchObject({ venueId: null, venueLookupStatus: "none" });
  expect(geocodeCalls().map((c) => c.address)).toEqual(["Broken Lane Ground", "Broken Lane Ground", "Broken Lane Ground"]);
  setGeocodeStub(STUB);
  await shots(page, "3-not-found");
});

test("the venue text is edited: looked up after the save, found and confident, then confirmed with Yes", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  const callsBefore = geocodeCalls().length;
  await editVenue(page, "Powerleague Shoreditch");

  const l = line(page);
  await expect(l).toHaveAttribute("data-state", "question", { timeout: 30_000 });
  await expect(l.getByTestId("venue-loc-address")).toHaveText(SHOREDITCH_ADDRESS);
  await expect(l).toContainText("Is this the right place?");
  await expect(l.getByTestId("venue-loc-map")).toHaveAttribute(
    "href",
    "https://www.google.com/maps/search/?api=1&query=51.5229%2C-0.0757&query_place_id=ChIJ_e2e_shoreditch",
  );
  // No embedded map and no map script: a plain link only.
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.locator('script[src*="google"], script[src*="maps"]').count()).toBe(0);

  expect(await activity()).toMatchObject({
    venue: "Powerleague Shoreditch",
    venueConfidence: "high",
    venueMatchSource: "text",
    venueLookupStatus: "found",
    venueConfirmedAt: null,
    venueConfirmedById: null,
  });
  // Google's answer is on record for the query, with no club on it.
  expect(await testDb().all(`SELECT key, confidence FROM "VenueQuery" ORDER BY key`)).toEqual([
    { key: "GB|powerleague shoreditch", confidence: "high" },
  ]);

  // ONE Google call, carrying the venue text and the country and nothing else.
  expect(geocodeCalls().slice(callsBefore)).toEqual([
    { kind: "geocode", address: "Powerleague Shoreditch", placeId: null, region: "uk", params: ["address", "key", "region"] },
  ]);
  await shots(page, "5-found-high");

  await l.getByRole("button", { name: "Yes" }).click();
  await expect(l).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });
  await expect(l.getByTestId("venue-loc-address")).toHaveText(SHOREDITCH_ADDRESS);
  await expect(l).not.toContainText("Is this the right place?");
  const row = await activity();
  expect(row.venueConfirmedById).toBe(U.admin);
  expect(row.venueConfirmedAt).not.toBeNull();
  // The confirmation is the club's: neither shared table has a column for it.
  const shared = await testDb().all<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name IN ('Venue', 'VenueQuery')`,
  );
  expect(shared.map((c) => c.column_name).filter((c) => /confirm|org|user/i.test(c))).toEqual([]);
  await shots(page, "6-confirmed-quiet");

  // Saving the SAME words again (case and spacing aside) keeps the place and asks Google nothing.
  await editVenue(page, "powerleague  shoreditch");
  await expect(line(page)).toHaveAttribute("data-state", "confirmed");
  expect((await activity()).venueConfirmedById).toBe(U.admin);
  expect(geocodeCalls().slice(callsBefore)).toHaveLength(1);
});

test("new venue words: the old place is cleared, and a vague venue comes back as a low confidence question", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  const before = await activity();
  expect(before.venueId).not.toBeNull();

  await editVenue(page, "Powerleague");
  const l = line(page);
  await expect(l).toHaveAttribute("data-state", "low", { timeout: 30_000 });
  await expect(l).toContainText("We are not sure this is where you play.");
  await expect(l).toContainText("Is this the right place?");
  await expect(l.getByTestId("venue-loc-address")).toHaveText("Powerleague, Mill Hill, London NW7 2BE, UK");
  await expect(l).toHaveClass(/bg-amber-50/);

  const after = await activity();
  expect(after).toMatchObject({ venue: "Powerleague", venueConfidence: "low", venueMatchSource: "text", venueConfirmedAt: null, venueConfirmedById: null });
  expect(after.venueId).not.toBe(before.venueId);
  await shots(page, "4-found-low");
});

test("Change by a fuller address: the place changes, the venue name the group sees does not", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  const callsBefore = geocodeCalls().length;

  // An address Google does not know leaves the place that was there.
  await change(page, "nowhere at all, zz");
  await expect(line(page).getByTestId("venue-loc-error")).toHaveText(
    "We couldn't find that. Try a fuller address, with the town or postcode, or paste a map link.",
  );
  expect((await activity()).venueConfidence).toBe("low");

  await change(page, "12 Whiston Road, London E2 8BN");
  const l = line(page);
  await expect(l).toHaveAttribute("data-state", "question", { timeout: 30_000 });
  await expect(l.getByTestId("venue-loc-address")).toHaveText(WHISTON_ADDRESS);
  expect(await activity()).toMatchObject({
    venue: "Powerleague",
    venueConfidence: "high",
    venueMatchSource: "address",
    venueConfirmedAt: null,
  });
  await expect(page.getByText(/at 20:30 · Powerleague( ·|$)/)).toBeVisible();
  const calls = geocodeCalls().slice(callsBefore);
  expect(calls.map((c) => c.address)).toEqual(["nowhere at all, zz", "12 Whiston Road, London E2 8BN"]);
  expect(calls.every((c) => c.region === "uk" && c.params!.join() === "address,key,region")).toBe(true);
});

test("Change by a pasted map link: coordinates are read from the link, a short link is expanded, others are refused", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  const l = line(page);
  // A fresh day for the club's cap: the tests above used most of today's ten.
  await testDb().run(`DELETE FROM "VenueLookup" WHERE "orgId" = $1`, [ORG_ID]);
  const callsBefore = geocodeCalls().length;
  const CANT_READ = "MatchTime can't read that link. Paste a link that shows the place's coordinates, or a Google Maps link, or type the address.";

  // Refused, each with its own words, and nothing is requested for any of them.
  await change(page, "https://what3words.com/filled.count.soap");
  await expect(l.getByTestId("venue-loc-error")).toHaveText(
    "MatchTime can't read what3words links yet. Paste a Google Maps link or type the address.",
  );
  for (const bad of [
    "https://evil.example/maps/@51.5,-0.1,17z",
    "http://169.254.169.254/latest/meta-data/",
    "https://maps.app.goo.gl@evil.example/x",
    // A Yandex short share link: it holds nothing, and Yandex is never requested.
    "https://yandex.com.tr/harita/-/CDqXfK5Y",
    "https://yandex.com.tr.evil.example/harita/?ll=28.9768,41.0054",
  ]) {
    await change(page, bad);
    await expect(l.getByTestId("venue-loc-error"), bad).toHaveText(CANT_READ);
  }
  expect(geocodeCalls().slice(callsBefore), "refused links make no request").toEqual([]);
  expect((await activity()).venueMatchSource).toBe("address");

  // A short link that redirects off the allow-list, or to a consent page:
  // one request to the short host each, then the same plain message.
  await change(page, "https://maps.app.goo.gl/E2eEvil");
  await expect(l.getByTestId("venue-loc-error")).toHaveText(CANT_READ);
  await change(page, "https://maps.app.goo.gl/E2eConsent");
  await expect(l.getByTestId("venue-loc-error")).toHaveText(CANT_READ);
  expect(geocodeCalls().slice(callsBefore)).toEqual([
    { kind: "short-link", url: "https://maps.app.goo.gl/E2eEvil" },
    { kind: "short-link", url: "https://maps.app.goo.gl/E2eConsent" },
  ]);
  expect((await activity()).venueMatchSource).toBe("address");

  // A Yandex link: LONGITUDE first. Sultanahmet Square, Istanbul.
  await change(page, "https://yandex.com.tr/harita/?ll=28.9768%2C41.0054&z=16");
  await expect(l).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });
  await expect(l.getByTestId("venue-loc-address")).toHaveText("Map pin at 41.00540, 28.97680");
  await expect(l.getByTestId("venue-loc-map")).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=41.0054%2C28.9768");
  const istanbul = await testDb().one<{ lat: number; lng: number }>(
    `SELECT v.lat, v.lng FROM "Venue" v JOIN "Activity" a ON a."venueId" = v.id WHERE a.id = $1`,
    [ACTIVITY_ID],
  );
  expect(istanbul).toEqual({ lat: 41.0054, lng: 28.9768 });

  // Coordinates in a Google link: no request at all, and the organiser's own pin is confirmed.
  await change(page, "https://www.google.com/maps/place/Our+Pitch/@51.52,-0.07,17z/data=!3d51.5229437!4d-0.0757291");
  await expect(l.getByTestId("venue-loc-address")).toHaveText("Map pin at 51.52294, -0.07573", { timeout: 30_000 });
  await expect(l).toHaveAttribute("data-state", "confirmed");
  await expect(l.getByTestId("venue-loc-map")).toHaveAttribute(
    "href",
    "https://www.google.com/maps/search/?api=1&query=51.5229437%2C-0.0757291",
  );
  expect(await activity()).toMatchObject({ venue: "Powerleague", venueMatchSource: "link", venueConfidence: "high", venueConfirmedById: U.admin });
  expect(geocodeCalls().slice(callsBefore), "pins make no request").toHaveLength(2);
  // The Istanbul pin it replaced is gone: private pins do not pile up.
  expect(await testDb().count(`SELECT count(*) FROM "Venue" WHERE source = 'map-link'`)).toBe(1);

  // A short link from the Google Maps app: the short host once, then the place it names.
  await change(page, "https://maps.app.goo.gl/E2eShort1");
  await expect(l.getByTestId("venue-loc-address")).toHaveText("Goals, North Cheam, Sutton SM3 9BY, UK", { timeout: 30_000 });
  await expect(l).toHaveAttribute("data-state", "question");
  expect(geocodeCalls().slice(callsBefore + 2)).toEqual([
    { kind: "short-link", url: "https://maps.app.goo.gl/E2eShort1" },
    { kind: "geocode", address: "Goals North Cheam, Sutton", placeId: null, region: "uk", params: ["address", "key", "region"] },
  ]);
  expect(await testDb().count(`SELECT count(*) FROM "Venue" WHERE source = 'map-link'`)).toBe(0);
  // A place named in a pasted link never enters the shared query cache.
  expect(await testDb().count(`SELECT count(*) FROM "VenueQuery" WHERE key LIKE '%cheam%'`)).toBe(0);
});

test("Turkish: the line speaks the club's language, in every state it has words for", async ({ page }) => {
  await testDb().run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/activities");
  await open(page);
  const l = line(page);
  await expect(l).toContainText("Doğru yer burası mı?");
  await expect(l.getByRole("button", { name: "Evet" })).toBeVisible();
  await expect(l.getByTestId("venue-loc-map")).toContainText("Haritada aç");
  await l.getByRole("button", { name: "Değiştir" }).click();
  await expect(l.getByLabel("Adres veya harita bağlantısı")).toBeVisible();
  await expect(l).toContainText("Yandex Haritalar");
  await expect(l.getByRole("button", { name: "Yeri bul" })).toBeVisible();
  await l.getByRole("button", { name: "Vazgeç" }).click();
  await l.getByRole("button", { name: "Evet" }).click();
  await expect(l).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });

  // The two neutral states, by putting the row in each.
  const put = (status: string) =>
    testDb().run(
      `UPDATE "Activity" SET "venueLookupStatus" = $1, "venueResolvedAt" = now() - interval '1 day' WHERE id = 'e2e-venue-tr-activity'`,
      [status],
    );
  await testDb().run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"isActive","createdAt","updatedAt")
     VALUES ('e2e-venue-tr-activity',$1,$2,'Perşembe 5',4,'20:00','Kadıköy Halı Saha',true,now() - interval '1 day',now() - interval '1 day')`,
    [ORG_ID, SPORT_ID],
  );
  const tr = page.getByTestId("venue-loc-e2e-venue-tr-activity");
  await page.reload();
  await expect(tr).toHaveAttribute("data-state", "never", { timeout: 30_000 });
  await expect(tr).toContainText("MatchTime konumu bilsin diye nerede oynadığınızı ekleyin.");
  await expect(tr.getByRole("button", { name: "Yeri ekle" })).toBeVisible();
  await put("failed");
  await page.reload();
  await expect(tr).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  await expect(tr).toContainText("Bu yeri şu anda kontrol edemedik. Daha sonra tekrar deneyin.");
  await expect(tr.getByRole("button", { name: "Tekrar dene" })).toBeVisible();
  await put("capped");
  await page.reload();
  await expect(tr).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  await put("none");
  await page.reload();
  await expect(tr).toHaveAttribute("data-state", "none", { timeout: 30_000 });
  await expect(tr).toContainText("Bu yeri bulamadık.");

  await testDb().run(`DELETE FROM "Activity" WHERE id = 'e2e-venue-tr-activity'`);
  await testDb().run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a player of the club: no admin page, and the API gives no location and none of its bookkeeping", async ({ page }) => {
  await signInAs(page, U.player, "/");
  await page.goto("/admin/activities");
  await page.waitForURL((url) => !url.pathname.startsWith("/admin"), { timeout: 30_000 });
  await expect(page.getByTestId(`venue-loc-${ACTIVITY_ID}`)).toHaveCount(0);

  const res = await page.request.get("/api/activities");
  expect(res.status()).toBe(200);
  const text = await res.text();
  const rows = JSON.parse(text) as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  expect(rows[0].venue).toBe("Powerleague");
  for (const key of ["venueLocation", "venueRef", "venueId", "venueQueryKey", "venueLookupStatus", "venueConfidence", "venueMatchSource", "venueResolvedAt", "venueConfirmedAt", "venueConfirmedById"]) {
    expect(rows[0], key).not.toHaveProperty(key);
  }
  expect(text).not.toMatch(/North Cheam|SM3 9BY|ChIJ_e2e|51\.37|-0\.21/);

  // A match of the club, which any member may read: the venue text, and nothing of the place.
  const matchRes = await page.request.get(`/api/matches/${MATCH.upcoming}`);
  expect(matchRes.status()).toBe(200);
  const matchText = await matchRes.text();
  expect((JSON.parse(matchText) as { activity: { venue: string } }).activity.venue).toBe("Powerleague");
  expect(matchText).not.toMatch(/venueId|venueQueryKey|venueLookupStatus|venueConfidence|venueMatchSource|venueConfirmed|venueResolvedAt|venueRef/);
  expect(matchText).not.toMatch(/North Cheam|SM3 9BY|ChIJ_e2e|51\.37/);
  for (const p of ["/api/org/settings", "/api/sports", "/api/players", "/api/memberships"]) {
    expect(await (await page.request.get(p)).text(), p).not.toMatch(/North Cheam|SM3 9BY|ChIJ_e2e|51\.37|venueLookupStatus/);
  }

  // The owner, for contrast, does get it.
  const admin = await page.context().browser()!.newContext({ baseURL: E2E_BASE_URL });
  const adminPage = await admin.newPage();
  await signInAs(adminPage, U.admin, "/");
  const own = (await (await adminPage.request.get("/api/activities")).json()) as Array<{ venueLocation?: { state: string; address: string } }>;
  expect(own[0].venueLocation).toMatchObject({ state: "found", address: "Goals, North Cheam, Sutton SM3 9BY, UK" });
  await admin.close();
});

test("a member of another club, even its owner, sees nothing of this club's venue", async ({ page }) => {
  const db = testDb();
  const OTHER_ORG = "e2e-venue-other-org";
  const OTHER_USER = "e2e-venue-other-user";
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","createdAt","updatedAt") VALUES ($1,'Elsewhere FC',$1,$2,now(),now())`,
    [OTHER_ORG, `${OTHER_ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Otto Other',$2,'+447700900978',true,true,now())`,
    [OTHER_USER, `${OTHER_USER}@e2e-test.invalid`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${OTHER_USER}-mem`, OTHER_USER, OTHER_ORG]);
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"isActive","createdAt","updatedAt")
     VALUES ('e2e-venue-other-activity',$1,$2,'Elsewhere 5s',3,'20:00','Elsewhere Arena',true,now(),now())`,
    [OTHER_ORG, SPORT_ID],
  );

  await signInAs(page, OTHER_USER, "/admin/activities");
  await page.goto("/admin/activities");
  // A row saved this very second, and still "never": nothing is inferred from its timestamps.
  await expect(page.getByTestId("venue-loc-e2e-venue-other-activity")).toHaveAttribute("data-state", "never", { timeout: 30_000 });
  await expect(page.getByTestId(`venue-loc-${ACTIVITY_ID}`)).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toMatch(/North Cheam|SM3 9BY|ChIJ_e2e|Powerleague/);

  const text = await (await page.request.get("/api/activities")).text();
  const rows = JSON.parse(text) as Array<{ id: string }>;
  expect(rows.map((r) => r.id)).toEqual(["e2e-venue-other-activity"]);
  expect(text).not.toMatch(/North Cheam|SM3 9BY|ChIJ_e2e|Powerleague|51\.37/);
  expect((await (await page.request.get("/api/org/settings")).text())).not.toMatch(/North Cheam|SM3 9BY|ChIJ_e2e|51\.37/);
});
