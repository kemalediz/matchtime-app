/**
 * Club setup offers only live sports (Kemal, 2026-10-25), in a real browser:
 * the web onboarding wizard's sport picker and the admin activities picker
 * list only what `LIVE_SPORTS` (src/lib/pool/sports.ts) switches on, which
 * today is football and its formats (futsal is football). A club that
 * already plays a sport that is not live keeps it in its picker.
 *
 * The expected lists come from the same switch, so turning basketball on
 * needs nothing here. The wizard's chat analysis is skipped: no model, $0.
 */
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ORG_ID, SPORT_ID } from "../helpers/constants";
import { liveSportPresets } from "@/lib/pool/sports";
import { SPORT_PRESETS } from "@/lib/sport-presets";

const LIVE = liveSportPresets().map((p) => p.name);
const NOT_LIVE = SPORT_PRESETS.map((p) => p.name).filter((n) => !LIVE.includes(n));

const CHAT = [
  "12/10/2026, 20:01 - Sam Striker: in for tuesday",
  "12/10/2026, 20:02 - Kim Keeper: in",
  "12/10/2026, 20:05 - Lee Left: out this week",
].join("\n");

/** Extra sports on the e2e club: two not live and unplayed, one not live but played. */
const EXTRA = [
  { id: "e2e-sport-netball", name: "Netball", preset: "netball", per: 7 },
  { id: "e2e-sport-bball", name: "Basketball 5-on-5", preset: "basketball-5v5", per: 5 },
  { id: "e2e-sport-cricket", name: "Cricket", preset: "cricket", per: 11 },
  { id: "e2e-sport-futsal", name: "Futsal", preset: "futsal", per: 5 },
];
const CRICKET_GAME = "e2e-activity-cricket";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.use({ locale: "en-GB" });

test("the expected lists are the switch's: football formats live, the rest not", () => {
  expect(LIVE).toEqual(expect.arrayContaining(["Football 5-a-side", "Football 7-a-side", "Football 11-a-side", "Futsal"]));
  expect(NOT_LIVE).toEqual(expect.arrayContaining(["Basketball 5-on-5", "Basketball 3-on-3", "Netball", "Volleyball", "Cricket"]));
});

for (const width of [390, 1280]) {
  test(`onboarding wizard at ${width}: the sport picker offers football only`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signInAs(page, U.admin, "/onboarding");
    await page.goto("/onboarding");
    await page.locator('input[type="file"]').setInputFiles({ name: "WhatsApp Chat with Sim FC.txt", mimeType: "text/plain", buffer: Buffer.from(CHAT) });
    await expect(page.getByRole("heading", { name: "Players" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Skip", exact: true }).click();

    const picker = page.locator("select").first();
    await expect(picker).toBeVisible();
    const options = (await picker.locator("option").allInnerTexts()).map((o) => o.replace(/ \(\d+ players\)$/, ""));
    expect(options).toEqual(LIVE);
    for (const n of NOT_LIVE) expect(options).not.toContain(n);
    await expect(picker).toHaveValue("football-7aside");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test.describe("admin activities", () => {
  test.beforeAll(async ({ db }) => {
    for (const s of EXTRA) {
      await db.run(
        `INSERT INTO "Sport" (id, "orgId", name, preset, "playersPerTeam", positions, "teamLabels", "mvpLabel", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, ARRAY['A','B'], ARRAY['Home','Away'], 'MVP', now(), now())`,
        [s.id, ORG_ID, s.name, s.preset, s.per],
      );
    }
    // The club already plays cricket: it keeps it.
    await db.run(
      `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "isActive", "createdAt", "updatedAt")
       VALUES ($1, $2, 'e2e-sport-cricket', 'Sunday cricket', 0, '10:00', 'The Oval Park', false, now(), now())`,
      [CRICKET_GAME, ORG_ID],
    );
  });

  test.afterAll(async ({ db }) => {
    await db.run(`DELETE FROM "Activity" WHERE id = $1`, [CRICKET_GAME]);
    await db.run(`DELETE FROM "Sport" WHERE id = ANY($1)`, [EXTRA.map((s) => s.id)]);
  });

  for (const width of [390, 1280]) {
    test(`at ${width}: a new activity offers the club's football sports, and the sport it already plays`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, U.admin, "/admin/activities");
      await page.waitForURL("**/admin/activities");
      await page.getByRole("button", { name: "Create activity" }).click();
      const picker = page.locator("form").getByRole("combobox").first();
      await expect(picker.locator("option")).not.toHaveCount(0);
      const options = await picker.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      expect(options.sort()).toEqual([SPORT_ID, "e2e-sport-cricket", "e2e-sport-futsal"].sort());
      const text = (await picker.locator("option").allInnerTexts()).join("\n");
      expect(text).not.toMatch(/Netball|Basketball/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
