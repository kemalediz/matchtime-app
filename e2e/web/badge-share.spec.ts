/**
 * Badge share cards (Kemal, 2026-10-01): "a share card button for the
 * badges a player has, to share on WhatsApp as an image".
 *
 * Riley Rater has played one rated match in the fixture world, so he has
 * earned "On the board" (first-game) and not "Regular" (ten-games).
 *
 *   - the share button appears on earned badges only;
 *   - the card route serves image/png for an earned badge, WITHOUT a
 *     session (it is public by cuid, like Wrapped), and 404s for an
 *     unearned badge, an unknown badge or a club he is not in;
 *   - tapping share hands the PNG to the share sheet as a file where the
 *     browser can share files, and downloads it with a hint where not.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.beforeAll(async () => {
  resetDb();
});

test("the share button appears on earned badges only", async ({ page }) => {
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  await expect(page.getByRole("button", { name: "Share On the board" })).toBeVisible();
  // Unearned, greyed out: no share button.
  await expect(page.getByText("Regular", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share Regular" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share MoM Machine" })).toHaveCount(0);
  // The season card is a share button now, not a link.
  await expect(page.getByRole("button", { name: "Share card" })).toBeVisible();
});

test("the card route returns a PNG for an earned badge, without a session", async ({ request }) => {
  const res = await request.get(`/api/badge-card/${U.rater}/first-game?org=${ORG_ID}`, {
    maxRedirects: 0,
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
  const body = await res.body();
  expect(body.subarray(0, 4).toString("hex")).toBe("89504e47");
});

test("the card route 404s for an unearned badge, an unknown badge or a missing club", async ({ request }) => {
  for (const path of [
    `/api/badge-card/${U.rater}/ten-games?org=${ORG_ID}`,
    `/api/badge-card/${U.rater}/not-a-badge?org=${ORG_ID}`,
    `/api/badge-card/${U.rater}/first-game?org=not-a-club`,
    `/api/badge-card/${U.rater}/first-game`,
  ]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(404);
  }
});

test("tapping share hands the PNG to the share sheet as a file", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown[] };
    w.__shared = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { files?: File[]; text?: string }) => {
        w.__shared.push({
          text: data.text,
          files: (data.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size })),
        });
      },
    });
  });
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  await page.getByRole("button", { name: "Share On the board" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length))
    .toBe(1);
  const [shared] = (await page.evaluate(
    () => (window as unknown as { __shared: unknown[] }).__shared,
  )) as { text: string; files: { name: string; type: string; size: number }[] }[];
  expect(shared.text).toMatch(/^I just earned 👟 On the board at .+ on MatchTime$/);
  expect(shared.files).toHaveLength(1);
  expect(shared.files[0]).toMatchObject({ name: "matchtime-first-game.png", type: "image/png" });
  expect(shared.files[0].size).toBeGreaterThan(1000);
  // A successful share shows no hint.
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("without file sharing the PNG downloads and the page says how to send it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Share On the board" }).click();
  expect((await download).suggestedFilename()).toBe("matchtime-first-game.png");
  await expect(page.getByRole("status")).toHaveText("Image saved. Send it in WhatsApp.");
});

test("the season card shares as an image too", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Share card" }).click();
  expect((await download).suggestedFilename()).toBe("matchtime-season.png");
});
