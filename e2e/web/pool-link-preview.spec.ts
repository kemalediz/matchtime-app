/**
 * A shared /play link (2026-11-03), end to end on the real dev server:
 *   - what a link preview fetcher reads in the HTML head of /play and of a
 *     campaign link /play?src=CODE: the player's og and twitter tags, og:url
 *     the link itself, never the organisers' homepage card; the picture
 *     loads with no session (it used to 307 to /login);
 *   - a friend link (/play/f) shows the player card too, with no og:url;
 *   - a fetcher's GET, and a fetcher calling the beacon, count no visit;
 *   - a person's visit counts once per tab session, under the live code,
 *     and plain /play counts as direct;
 *   - the owner's source codes page shows visits next to sign-ups.
 * No model anywhere: $0.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { SITE_META } from "@/components/landing/landing-content";

const PREVIEW = poolLinkPreviewCopy("en");
const FACEBOOK = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CODE = "e2e-fb-sutton";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

/** The HTML head's meta and link tags, as a fetcher that reads only the head sees them. */
async function headTags(request: APIRequestContext, path: string, ua = FACEBOOK): Promise<Map<string, string>> {
  const res = await request.get(path, { headers: { "user-agent": ua } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  const head = html.slice(0, html.indexOf("</head>"));
  const tags = new Map<string, string>();
  for (const m of head.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)"/g)) tags.set(m[1], m[2].replace(/&#x27;/g, "'").replace(/&amp;/g, "&"));
  const canonical = head.match(/<link rel="canonical" href="([^"]+)"/);
  if (canonical) tags.set("canonical", canonical[1]);
  return tags;
}

const visits = async (db: TestDb, code: string) => Number((await db.one<{ n: string | null }>(`SELECT sum(count)::text AS n FROM "PoolCampaignVisit" WHERE code = $1`, [code]))?.n ?? 0);

test.describe("the preview a fetcher reads", () => {
  test("/play: the player's card in the head, og:url /play, canonical /play", async ({ request }) => {
    const t = await headTags(request, "/play");
    expect(t.get("og:title")).toBe(PREVIEW.title);
    expect(t.get("og:description")).toBe(PREVIEW.description);
    expect(t.get("og:type")).toBe("website");
    expect(t.get("og:url")).toMatch(/\/play$/);
    expect(t.get("canonical")).toMatch(/\/play$/);
    expect(t.get("twitter:card")).toBe("summary_large_image");
    expect(t.get("twitter:title")).toBe(PREVIEW.title);
    expect(t.get("og:image:width")).toBe("1200");
    expect(t.get("og:image:height")).toBe("630");
    expect(t.get("og:image:alt")).toBe(PREVIEW.imageAlt);
    for (const v of t.values()) {
      expect(v).not.toBe(SITE_META.title);
      expect(v).not.toBe(SITE_META.ogDescription);
    }
  });

  test("a campaign link: og:url is the campaign link itself", async ({ request }) => {
    const t = await headTags(request, `/play?src=${CODE}`);
    expect(t.get("og:url")).toMatch(new RegExp(`/play\\?src=${CODE}$`));
    expect(t.get("og:title")).toBe(PREVIEW.title);
    expect(t.get("canonical")).toMatch(/\/play$/);
  });

  test("the picture loads with no session, as a real PNG", async ({ request }) => {
    for (const key of ["og:image", "twitter:image"]) {
      const url = new URL((await headTags(request, "/play")).get(key)!);
      const img = await request.get(`${url.pathname}${url.search}`, { headers: { "user-agent": FACEBOOK }, maxRedirects: 0 });
      expect(img.status(), key).toBe(200);
      expect(img.headers()["content-type"]).toContain("image/png");
      expect((await img.body()).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  });

  test("a friend link shows the player's card, with no og:url of the homepage", async ({ request }) => {
    const t = await headTags(request, "/play/f/not-a-real-token");
    expect(t.get("og:title")).toBe(PREVIEW.title);
    expect(t.has("og:url")).toBe(false);
    expect(t.has("canonical")).toBe(false);
  });

  test("the homepage keeps its own organisers' card", async ({ request }) => {
    const t = await headTags(request, "/");
    expect(t.get("og:title")).toBe(SITE_META.title);
  });
});

test.describe("visits", () => {
  test.use({ userAgent: PERSON, locale: "en-GB" });

  test("a fetcher's GET and a fetcher calling the beacon count nothing", async ({ request, db }) => {
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Sutton Facebook group') ON CONFLICT DO NOTHING`, [CODE]);
    await db.run(`DELETE FROM "PoolCampaignVisit"`);
    await headTags(request, `/play?src=${CODE}`);
    const beacon = await request.post("/api/play/visit", { headers: { "user-agent": FACEBOOK }, data: JSON.stringify({ src: CODE }) });
    expect(beacon.status()).toBe(204);
    // Give the after-answer write its chance, then check it never came.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await db.one(`SELECT count(*)::int AS n FROM "PoolCampaignVisit"`)).toEqual({ n: 0 });
  });

  test("a person opening the campaign link counts once per tab session, under the code", async ({ page, db }) => {
    await page.goto(`/play?src=${CODE}`);
    await expect.poll(() => visits(db, CODE), { timeout: 15_000 }).toBe(1);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await new Promise((r) => setTimeout(r, 1000));
    expect(await visits(db, CODE)).toBe(1);
  });

  test("plain /play counts as direct, a switched-off code too", async ({ page, db }) => {
    await page.goto("/play");
    await expect.poll(() => visits(db, "_direct"), { timeout: 15_000 }).toBe(1);
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label, active) VALUES ('e2e-off', 'nextdoor', 'off', false) ON CONFLICT DO NOTHING`);
    await page.goto("/play?src=e2e-off");
    await expect.poll(() => visits(db, "_direct"), { timeout: 15_000 }).toBe(2);
    expect(await visits(db, "e2e-off")).toBe(0);
  });
});

test.describe("the owner's numbers", () => {
  test("visits next to sign-ups, per code and without a code; Facebook and Nextdoor to pick", async ({ page, db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
    await db.run(`DELETE FROM "PoolProfile" WHERE "sourceCode" = $1`, [CODE]);
    await db.run(
      `INSERT INTO "PoolProfile" (id, status, "adultConfirmedAt", "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "sourceCode", "createdAt", "updatedAt")
       VALUES ('e2e-preview-waiting', 'pending-verify', now(), 'Someone S', 'SM1', 51.36, -0.19, 3, 'campaign', $1, now(), now())`,
      [CODE],
    );
    await signInAs(page, U.admin, "/admin/pool/campaigns");
    const row = page.locator(`[data-testid="campaign-row"][data-code="${CODE}"]`);
    await expect(row.getByTestId("campaign-visits")).toHaveText("1", { timeout: 30_000 });
    await expect(row.getByTestId("campaign-started")).toHaveText("1");
    await expect(row.getByTestId("campaign-confirmed")).toHaveText("0");
    await expect(row.getByTestId("campaign-waiting")).toHaveText("1");
    await expect(page.getByTestId("way-in-direct").getByTestId("direct-visits")).toHaveText("2");
    await expect(page.getByTestId("way-in-referral").getByTestId("referral-visits")).toHaveText("0");
    await expect(page.getByLabel("Where it is shared").locator("option")).toHaveText(["LinkedIn", "Leaflet", "Facebook", "Nextdoor", "Other"]);

    await page.getByLabel("Code", { exact: true }).fill("fb-cheam-e2e");
    await page.getByLabel("Where it is shared").selectOption("facebook");
    await page.getByLabel("What it is for").fill("Cheam Facebook group");
    await page.getByRole("button", { name: "Make code" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Code fb-cheam-e2e is ready." })).toBeVisible();
    expect(await db.one(`SELECT source FROM "PoolCampaign" WHERE code = 'fb-cheam-e2e'`)).toEqual({ source: "facebook" });
    await db.run(`DELETE FROM "PoolProfile" WHERE id = 'e2e-preview-waiting'`);
  });
});
