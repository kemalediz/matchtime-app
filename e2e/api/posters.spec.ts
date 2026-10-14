/**
 * THE POSTERS CARD'S API (2026-10-14), against a real Postgres and the real
 * routes. No model anywhere on this path.
 *
 *   GET    /api/org/graphics              the gallery and what is in force
 *   GET    /api/org/graphics/preview      the club's poster or team sheet as a PNG
 *   POST   /api/org/graphics/design       pick a gallery option
 *   POST   /api/org/graphics/background   upload a background
 *   DELETE /api/org/graphics/background   remove it
 *
 * And what the choice does to the graphic MatchTime actually sends
 * (GET /api/graphics/<token>).
 *
 * The fixture club (E2E Test FC) has its upcoming match at 4 of 5: too few
 * names, so the previews are samples. Alex Admin is the OWNER, Pat Player
 * a plain member. Every picture here is an invented gradient or flat
 * colour made with sharp; "Other Club FC" is invented.
 */
import { createHmac } from "node:crypto";
import sharp from "sharp";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";

test.describe.configure({ mode: "serial" });

const OTHER = "e2e-posters-other";
const OTHER_NAME = "Other Club FC";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function token(p: { o: string; m: string; k: string }): string {
  const iat = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...p, iat, exp: iat + 900 })).toString("base64url");
  const sig = createHmac("sha256", E2E.AUTH_SECRET).update(`matchtime-graphic-v1.${body}`).digest("base64url");
  return `${body}.${sig}`;
}

/** A neutral portrait gradient, teal to purple. */
async function gradient(width = 900, height = 1400, format: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  );
  return sharp(svg)[format]().toBuffer();
}

async function pngSize(body: Buffer): Promise<[number, number]> {
  expect([...body.subarray(0, 4)]).toEqual(PNG_MAGIC);
  return [body.readUInt32BE(16), body.readUInt32BE(20)];
}

async function corner(body: Buffer): Promise<number[]> {
  const { data } = await sharp(body).removeAlpha().extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [...data];
}

const upload = (page: Page, buffer: Buffer, mimeType = "image/png", name = "bg.png") =>
  page.request.post("/api/org/graphics/background", { multipart: { file: { name, mimeType, buffer } } });

const state = async (page: Page) => {
  const res = await page.request.get("/api/org/graphics");
  expect(res.status()).toBe(200);
  return res.json() as Promise<{
    current: string;
    options: Array<{ id: string; source: string; kind: string | null; label: string | null }>;
    own: { kind: string } | null;
    removable: boolean;
    sample: { list: boolean; teams: boolean };
  }>;
};

const sent = async (request: APIRequestContext, kind: "list" | "teams") => {
  const res = await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: kind })}`);
  expect(res.status()).toBe(200);
  return pngSize(await res.body());
};

/** A measured layout at 400 x 700 whose top band carries "its club's" brand. */
const LAYOUT = {
  version: 1,
  width: 400,
  height: 700,
  rows: [300, 360],
  capHeight: 20,
  name: { colour: "#ffffff", maxFontSize: 30, minFontSize: 18 },
  columns: [
    { nameX: 60, maxWidth: 130, iconCentreX: 30, badgeColour: "#000000" },
    { nameX: 260, maxWidth: 130, iconCentreX: 230, badgeColour: "#ffffff" },
  ],
  date: { x: 250, centreY: 140, fontSize: 16, colour: "#ffffff", maxWidth: 140 },
  time: { x: 250, centreY: 170, fontSize: 16, colour: "#ffffff", maxWidth: 140 },
  squadHeader: { panel: { x: 20, y: 200, width: 360, height: 60 }, from: "#eeeeee", to: "#ff1493", titleColour: "#000000", titleFontSize: 30, title: "OTHER CLUB", keep: [] },
  reserves: { centreX: 200, centreY: 420, fontSize: 14, colour: "#ffffff", maxWidth: 360 },
  brandArea: { x: 0, y: 0, width: 400, height: 100, fill: "#111111", colour: "#ffffff", maxFontSize: 48 },
};

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "createdAt", "updatedAt") VALUES ($1, $2, 'e2e-posters-other', 'e2e-posters-other-inv', now(), now())`,
    [OTHER, OTHER_NAME],
  );
  const image = await sharp({ create: { width: 400, height: 700, channels: 3, background: { r: 30, g: 30, b: 90 } } }).png().toBuffer();
  await db.run(
    `INSERT INTO "ClubGraphicsTemplate" ("orgId", image, "mimeType", layout, kind, shared, "displayName", "updatedAt") VALUES ($1, $2, 'image/png', $3::jsonb, 'measured', false, null, now())`,
    [OTHER, image, JSON.stringify(LAYOUT)],
  );
});

test.afterAll(() => {
  resetDb();
});

test.describe("permissions", () => {
  test("a player: 403 on every route, nothing stored", async ({ page, db }) => {
    await signInAs(page, U.player, "/profile");
    expect((await page.request.get("/api/org/graphics")).status()).toBe(403);
    expect((await page.request.get("/api/org/graphics/preview?kind=list")).status()).toBe(403);
    expect((await page.request.post("/api/org/graphics/design", { data: { design: "matchtime" } })).status()).toBe(403);
    expect((await upload(page, await gradient())).status()).toBe(403);
    expect((await page.request.delete("/api/org/graphics/background")).status()).toBe(403);
    expect(await db.all(`SELECT 1 FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toHaveLength(0);
    expect(await db.all(`SELECT 1 FROM "ClubGraphicsChoice" WHERE "orgId" = $1`, [ORG_ID])).toHaveLength(0);
  });

  test("nobody signed in: never a picture", async ({ request }) => {
    const res = await request.get("/api/org/graphics/preview?kind=list", { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
  });
});

test.describe("an owner", () => {
  test("the start: MatchTime only, in use; another club's PRIVATE template not offered; sample previews", async ({ page }) => {
    await signInAs(page, U.admin, "/admin/settings");
    const s = await state(page);
    expect(s).toMatchObject({ current: "matchtime", own: null, removable: false, sample: { list: true, teams: true } });
    expect(s.options.map((o) => o.id)).toEqual(["matchtime"]);
  });

  test("the preview: the default design, 1080 x 1350, marked as a sample", async ({ page }) => {
    await signInAs(page, U.admin, "/admin/settings");
    for (const kind of ["list", "teams"]) {
      const res = await page.request.get(`/api/org/graphics/preview?kind=${kind}`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
      expect(res.headers()["cache-control"]).toContain("no-store");
      expect(res.headers()["x-graphic-sample"]).toBe("1");
      expect(await pngSize(await res.body())).toEqual([1080, 1350]);
    }
    expect((await page.request.get("/api/org/graphics/preview?kind=ratings")).status()).toBe(400);
  });

  test("bad uploads are refused, each with its reason, and nothing is stored", async ({ page, db }) => {
    await signInAs(page, U.admin, "/admin/settings");
    const cases: Array<[Buffer, string, string, number, string]> = [
      [Buffer.from("GIF89a" + "x".repeat(64)), "image/gif", "a.gif", 400, "bad-type"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", "a.svg", 400, "bad-type"],
      [Buffer.from("not really a png, just words"), "image/png", "a.png", 400, "bad-bytes"],
      [await gradient(1400, 900), "image/png", "wide.png", 400, "not-portrait"],
      [await gradient(300, 400), "image/png", "tiny.png", 400, "too-small"],
      [Buffer.alloc(4 * 1024 * 1024 + 10, 1), "image/png", "huge.png", 413, "too-large"],
    ];
    for (const [buffer, mimeType, name, status, problem] of cases) {
      const res = await upload(page, buffer, mimeType, name);
      expect(res.status(), name).toBe(status);
      expect(await res.json(), name).toEqual({ ok: false, problem });
    }
    expect(await db.all(`SELECT 1 FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toHaveLength(0);
  });

  test("a portrait gradient: stored as a 1080 x 1350 JPEG, picked, and what MatchTime sends is drawn on it", async ({ page, db, request }) => {
    await signInAs(page, U.admin, "/admin/settings");
    const res = await upload(page, await gradient(900, 1400, "webp"), "image/webp", "bg.webp");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await db.one<{ kind: string; mimeType: string; shared: boolean; layout: { width: number; height: number } }>(
      `SELECT kind, "mimeType", shared, layout FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`,
      [ORG_ID],
    );
    expect(row).toMatchObject({ kind: "background", mimeType: "image/jpeg", shared: false, layout: { width: 1080, height: 1350 } });

    const s = await state(page);
    expect(s).toMatchObject({ current: "own", own: { kind: "background" }, removable: true });
    expect(s.options.map((o) => o.id)).toEqual(["matchtime", "own"]);

    const preview = await page.request.get("/api/org/graphics/preview?kind=list");
    const body = await preview.body();
    expect(await pngSize(body)).toEqual([1080, 1350]);
    // The corner is the teal of the gradient's top, not the default navy.
    const [r, g, b] = await corner(body);
    expect(g).toBeGreaterThan(r + 40);
    expect(g).toBeGreaterThan(80);
    expect(b).toBeGreaterThan(60);

    // The graphic MatchTime posts in the admin group: the same design.
    expect(await sent(request, "list")).toEqual([1080, 1350]);
    const posted = await (await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`)).body();
    expect((await corner(posted))[1]).toBeGreaterThan(80);
  });

  test("picking: 'matchtime' and back to 'own' are stored; another club's private template cannot be picked by id", async ({ page, db }) => {
    await signInAs(page, U.admin, "/admin/settings");
    const pick = (design: unknown) => page.request.post("/api/org/graphics/design", { data: { design } });

    expect((await pick("matchtime")).status()).toBe(200);
    expect((await state(page)).current).toBe("matchtime");
    expect(await db.one(`SELECT design, "updatedById" FROM "ClubGraphicsChoice" WHERE "orgId" = $1`, [ORG_ID])).toEqual({ design: "matchtime", updatedById: U.admin });

    for (const bad of [`shared:${OTHER}`, `shared:${ORG_ID}`, "nonsense", 42, null]) {
      const res = await pick(bad);
      expect(res.status(), String(bad)).toBe(400);
    }
    expect((await page.request.get(`/api/org/graphics/preview?kind=list&design=shared:${OTHER}`)).status()).toBe(404);
    expect((await state(page)).current).toBe("matchtime");

    expect((await pick("own")).status()).toBe(200);
    expect((await state(page)).current).toBe("own");
  });

  test("a SHARED template: offered by its display name only, drawn for this club, falls back when withdrawn", async ({ page, db, request }) => {
    await db.run(`UPDATE "ClubGraphicsTemplate" SET shared = true, "displayName" = 'Night stadium' WHERE "orgId" = $1`, [OTHER]);
    await signInAs(page, U.admin, "/admin/settings");

    const raw = await (await page.request.get("/api/org/graphics")).text();
    expect(raw).not.toContain(OTHER_NAME);
    const s = JSON.parse(raw) as Awaited<ReturnType<typeof state>>;
    expect(s.options).toContainEqual({ id: `shared:${OTHER}`, source: "shared", kind: "measured", label: "Night stadium" });

    // The gallery thumbnail: drawn on the template at its size.
    const thumb = await page.request.get(`/api/org/graphics/preview?kind=list&design=shared:${OTHER}`);
    expect(thumb.status()).toBe(200);
    expect(await pngSize(await thumb.body())).toEqual([400, 700]);

    expect((await page.request.post("/api/org/graphics/design", { data: { design: `shared:${OTHER}` } })).status()).toBe(200);
    expect((await state(page)).current).toBe(`shared:${OTHER}`);
    expect(await sent(request, "list")).toEqual([400, 700]);
    // Its brand area is covered with its fill: the top-left is #111111, not the template's navy.
    const posted = await (await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`)).body();
    const [r, g, b] = await corner(posted);
    expect(Math.max(r, g, b)).toBeLessThan(40);

    // With a shared VARIANT (FNF's "Floodlights" kind): other clubs get the
    // variant, not the branded original. Bottom-left: the variant's red,
    // not the original's navy.
    const variant = await sharp({ create: { width: 400, height: 700, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer();
    await db.run(`UPDATE "ClubGraphicsTemplate" SET "sharedImage" = $2, "sharedMimeType" = 'image/png', "sharedLayout" = $3::jsonb WHERE "orgId" = $1`, [
      OTHER,
      variant,
      JSON.stringify(LAYOUT),
    ]);
    const viaVariant = await (await request.get(`/api/graphics/${token({ o: ORG_ID, m: MATCH.upcoming, k: "list" })}`)).body();
    const { data: px } = await sharp(viaVariant).removeAlpha().extract({ left: 4, top: 690, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect(px[0]).toBeGreaterThan(150);
    expect(px[2]).toBeLessThan(60);

    // Withdrawn by the platform owner: this club is back on its own upload.
    await db.run(`UPDATE "ClubGraphicsTemplate" SET shared = false WHERE "orgId" = $1`, [OTHER]);
    expect(await sent(request, "list")).toEqual([1080, 1350]);
    expect((await state(page)).current).toBe("own");
    // Deleted: the choice's reference is cleared, not left dangling.
    await db.run(`UPDATE "ClubGraphicsTemplate" SET shared = true WHERE "orgId" = $1`, [OTHER]);
    await db.run(`DELETE FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [OTHER]);
    expect(await db.one(`SELECT design, "sharedFromOrgId" FROM "ClubGraphicsChoice" WHERE "orgId" = $1`, [ORG_ID])).toEqual({
      design: "shared",
      sharedFromOrgId: null,
    });
    expect(await sent(request, "list")).toEqual([1080, 1350]);
  });

  test("remove: the upload is gone and the club is back on the default; removing again is 404", async ({ page, db, request }) => {
    await signInAs(page, U.admin, "/admin/settings");
    await page.request.post("/api/org/graphics/design", { data: { design: "own" } });
    const res = await page.request.delete("/api/org/graphics/background");
    expect(res.status()).toBe(200);
    expect(await db.all(`SELECT 1 FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toHaveLength(0);
    expect(await state(page)).toMatchObject({ current: "matchtime", own: null, removable: false });
    expect(await sent(request, "list")).toEqual([1080, 1350]);
    const again = await page.request.delete("/api/org/graphics/background");
    expect(again.status()).toBe(404);
    expect(await again.json()).toEqual({ ok: false, problem: "none" });
  });

  test("a design MatchTime made for the club (measured): kept, never replaced or removed from the card", async ({ page, db }) => {
    const image = await sharp({ create: { width: 400, height: 700, channels: 3, background: { r: 30, g: 30, b: 90 } } }).png().toBuffer();
    await db.run(
      `INSERT INTO "ClubGraphicsTemplate" ("orgId", image, "mimeType", layout, "updatedAt") VALUES ($1, $2, 'image/png', $3::jsonb, now())`,
      [ORG_ID, image, JSON.stringify(LAYOUT)],
    );
    await db.run(`DELETE FROM "ClubGraphicsChoice" WHERE "orgId" = $1`, [ORG_ID]);
    await signInAs(page, U.admin, "/admin/settings");
    // No choice row (FNF today): its own template, drawn as before.
    expect(await state(page)).toMatchObject({ current: "own", own: { kind: "measured" }, removable: false });

    const up = await upload(page, await gradient());
    expect(up.status()).toBe(409);
    expect(await up.json()).toEqual({ ok: false, problem: "made-by-matchtime" });
    const del = await page.request.delete("/api/org/graphics/background");
    expect(del.status()).toBe(409);
    expect(await db.one(`SELECT kind FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toEqual({ kind: "measured" });
    await db.run(`DELETE FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID]);
  });
});
