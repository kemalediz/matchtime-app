/**
 * GO-LIVE SLICE S5: WHO MAY GO LIVE, PROVEN AT THE REAL BOUNDARY (review
 * of PR #236, fix 9). The unit tests mock `auth()` and the role checks;
 * this spec does not. Real users are signed in against the embedded
 * database, and the three server actions are called the way a browser
 * calls them: a POST to the page with the `next-action` header.
 *
 * HOW THE CALLS ARE FORGED. An action's id is not public API, so each one
 * is captured from a real press of the real button (the request is read
 * and dropped before it reaches the server), then replayed with a
 * different person's cookies and a different club's id. Every refusal is
 * paired with a CONTROL: the same forged request from the person who IS
 * allowed does the thing, so a refusal can never be the forgery failing.
 *
 *   goLiveClubAction      captured from the organiser's Go live button
 *   helloPreviewAction    captured from the owner page's "Go live now"
 *                         (opening the confirm fetches the preview)
 *   ownerGoLiveNowAction  captured from the confirm's button
 *
 * Refused, with nothing changed and no hello read:
 *   - a club's own admin calling the OWNER's go-live, on their own club;
 *   - the admin of club A going live for, or previewing, club B;
 *   - an admin who has LEFT the club;
 *   - nobody signed in.
 *
 * Deterministic: nothing here calls a model.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E_BASE_URL } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const utc = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const bare = (phone: string) => phone.replace(/^\+/, "");

interface Club {
  id: string;
  name: string;
  group: string;
  subject: string;
  ownerId: string;
  ownerName: string;
  ownerPhone: string;
}

const ALPHA: Club = { id: "e2e-az-alpha", name: "Alpha Athletic", group: "120363900000000401@g.us", subject: "Alpha 5s", ownerId: "e2e-az-ann", ownerName: "Ann Alpha", ownerPhone: "+447700903101" };
const BRAVO: Club = { id: "e2e-az-bravo", name: "Bravo Borough", group: "120363900000000402@g.us", subject: "Bravo 5s", ownerId: "e2e-az-ben", ownerName: "Ben Bravo", ownerPhone: "+447700903102" };
/** Was an ADMIN of Alpha; has left. */
const LEE = { id: "e2e-az-lee", name: "Lee Left", phone: "+447700903103" };

async function user(db: TestDb, id: string, name: string, phone: string) {
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
    [id, name, `${id}@e2e-test.invalid`, phone],
  );
}

async function heldClub(db: TestDb, c: Club) {
  await user(db, c.ownerId, c.ownerName, c.ownerPhone);
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","setupStage","language","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',$5::timestamp,$4,false,'setting-up','en',now(),now())`,
    [c.id, c.name, `${c.id}-invite`, c.group, utc(-180 * 60_000)],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${c.ownerId}-${c.id}`, c.ownerId, c.id]);
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'closed',now() + interval '1 hour',$6,$7,now() - interval '4 hours',now())`,
    [`${c.id}-cc`, c.id, c.ownerId, bare(c.ownerPhone), c.id.slice(-4).toUpperCase(), c.group, c.subject],
  );
}

const stage = async (db: TestDb, id: string) =>
  db.one<{ setupStage: string; whatsappBotEnabled: boolean; liveBy: string | null }>(
    `SELECT "setupStage","whatsappBotEnabled","liveBy" FROM "Organisation" WHERE id = $1`,
    [id],
  );
const posts = (db: TestDb, id: string) => db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [id]);
const UNTOUCHED = { setupStage: "setting-up", whatsappBotEnabled: false, liveBy: null };

/** A server action as the browser sent it. */
interface Captured {
  url: string;
  id: string;
  body: string;
  /** The club id inside `body`, to swap for another club's. */
  orgId: string;
}

/** Read the next server-action request the page sends, and drop it. */
async function capture(page: Page, orgId: string, press: () => Promise<void>): Promise<Captured> {
  let got: Captured | null = null;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const id = req.headers()["next-action"];
    if (req.method() === "POST" && id && !got) {
      got = { url: req.url(), id, body: req.postData() ?? "", orgId };
      await route.abort();
      return;
    }
    await route.continue();
  });
  await press();
  await expect.poll(() => got, { timeout: 15_000 }).not.toBeNull();
  await page.unroute("**/*");
  expect(got!.body).toContain(orgId);
  return got!;
}

/** Replay a captured action with somebody else's cookies, for any club. */
async function forge(as: APIRequestContext, action: Captured, orgId: string): Promise<{ status: number; text: string }> {
  const res = await as.post(action.url, {
    headers: {
      "next-action": action.id,
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      origin: E2E_BASE_URL,
    },
    data: action.body.split(action.orgId).join(orgId),
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  return { status: res.status(), text: await res.text().catch(() => "") };
}

/** Nothing a refused caller is sent may hold the hello or a success. */
function expectRefused(r: { status: number; text: string }, why: string) {
  expect(r.text, why).not.toContain("has set me up");
  expect(r.text, why).not.toContain("went-live");
  expect(r.text, why).not.toContain('"ok":true');
  expect(r.text, why).not.toContain("is live");
}

let goLive: Captured;
let preview: Captured;
let ownerGoLive: Captured;

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await heldClub(db, ALPHA);
  await heldClub(db, BRAVO);
  await user(db, LEE.id, LEE.name, LEE.phone);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "leftAt") VALUES ($1,$2,$3,'ADMIN',now() - interval '1 day')`, [
    `${LEE.id}-${ALPHA.id}`,
    LEE.id,
    ALPHA.id,
  ]);
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
});

test.afterAll(async () => {
  await testDb().run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  resetDb();
});

test("the three actions are captured from real presses, and nothing reached the server", async ({ browser, db }) => {
  const annCtx = await browser.newContext();
  const ann = await annCtx.newPage();
  await signInAs(ann, ALPHA.ownerId, "/admin/settings");
  await expect(ann.getByTestId("go-live-preview")).toBeVisible({ timeout: 30_000 });
  await ann.waitForLoadState("networkidle");
  goLive = await capture(ann, ALPHA.id, () => ann.getByTestId("go-live-button").click());
  await annCtx.close();

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signInAs(owner, U.admin, "/admin/clubs");
  const row = owner.getByTestId("setting-up-club").filter({ hasText: "Alpha Athletic" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await owner.waitForLoadState("networkidle");
  preview = await capture(owner, ALPHA.id, () => row.getByRole("button", { name: "Go live now" }).click());
  const take = row.getByRole("button", { name: "Take Alpha Athletic live" });
  await expect(take).toBeEnabled();
  ownerGoLive = await capture(owner, ALPHA.id, () => take.click());
  await ownerCtx.close();

  expect(new Set([goLive.id, preview.id, ownerGoLive.id]).size).toBe(3);
  expect(await stage(db, ALPHA.id)).toEqual(UNTOUCHED);
  expect(await stage(db, BRAVO.id)).toEqual(UNTOUCHED);
});

test("CONTROL: the forged preview works for the club's own owner, so the refusals below are real", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInAs(page, ALPHA.ownerId, "/admin");
  const r = await forge(ctx.request, preview, ALPHA.id);
  expect(r.status).toBe(200);
  expect(r.text).toContain("Ann has set me up");
  await ctx.close();
});

test("nobody signed in: no preview, no go-live, no owner go-live", async ({ browser, db }) => {
  const ctx = await browser.newContext();
  for (const [name, action] of [["preview", preview], ["go live", goLive], ["owner go live", ownerGoLive]] as const) {
    const r = await forge(ctx.request, action, ALPHA.id);
    expect(r.status, name).not.toBe(200);
    expectRefused(r, `signed out, ${name}`);
  }
  expect(await stage(db, ALPHA.id)).toEqual(UNTOUCHED);
  expect(await posts(db, ALPHA.id)).toBe(0);
  await ctx.close();
});

test("the admin of club A cannot go live for club B, or read its hello", async ({ browser, db }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInAs(page, ALPHA.ownerId, "/admin");
  const seen = await forge(ctx.request, preview, BRAVO.id);
  expect(seen.status).not.toBe(200);
  expectRefused(seen, "Ann previews Bravo");
  expect(seen.text).not.toContain("Ben");
  const went = await forge(ctx.request, goLive, BRAVO.id);
  expect(went.status).not.toBe(200);
  expectRefused(went, "Ann takes Bravo live");
  expect(await stage(db, BRAVO.id)).toEqual(UNTOUCHED);
  expect(await posts(db, BRAVO.id)).toBe(0);
  await ctx.close();
});

test("a club's own owner cannot use the MatchTime owner's go-live, not even on their own club", async ({ browser, db }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInAs(page, ALPHA.ownerId, "/admin");
  for (const orgId of [ALPHA.id, BRAVO.id]) {
    const r = await forge(ctx.request, ownerGoLive, orgId);
    expect(r.status, orgId).not.toBe(200);
    expectRefused(r, `Ann, owner go-live, ${orgId}`);
  }
  expect(await stage(db, ALPHA.id)).toEqual(UNTOUCHED);
  expect(await stage(db, BRAVO.id)).toEqual(UNTOUCHED);
  expect(await posts(db, ALPHA.id)).toBe(0);
  await ctx.close();
});

test("an admin who has left the club cannot go live for it or read its hello", async ({ browser, db }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInAs(page, LEE.id, "/");
  for (const [name, action] of [["preview", preview], ["go live", goLive], ["owner go live", ownerGoLive]] as const) {
    const r = await forge(ctx.request, action, ALPHA.id);
    expect(r.status, name).not.toBe(200);
    expectRefused(r, `Lee, ${name}`);
  }
  expect(await stage(db, ALPHA.id)).toEqual(UNTOUCHED);
  expect(await posts(db, ALPHA.id)).toBe(0);
  await ctx.close();
});

test("CONTROL: the same forged calls from the people who ARE allowed do the thing", async ({ browser, db }) => {
  // Ann, owner of Alpha, takes Alpha live through the organiser's action.
  const annCtx = await browser.newContext();
  const ann = await annCtx.newPage();
  await signInAs(ann, ALPHA.ownerId, "/admin");
  const a = await forge(annCtx.request, goLive, ALPHA.id);
  expect(a.status).toBe(200);
  expect(a.text).toContain("went-live");
  // What comes back holds no user id (review fix 5).
  expect(a.text).not.toContain(ALPHA.ownerId);
  expect(await stage(db, ALPHA.id)).toEqual({ setupStage: "live", whatsappBotEnabled: true, liveBy: ALPHA.ownerId });
  expect(await posts(db, ALPHA.id)).toBe(1);
  await annCtx.close();

  // The MatchTime owner takes Bravo live through the owner's action.
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signInAs(owner, U.admin, "/admin");
  const b = await forge(ownerCtx.request, ownerGoLive, BRAVO.id);
  expect(b.status).toBe(200);
  expect(b.text).toContain("Bravo Borough is live.");
  expect(await stage(db, BRAVO.id)).toEqual({ setupStage: "live", whatsappBotEnabled: true, liveBy: `owner:${U.admin}` });
  expect(await posts(db, BRAVO.id)).toBe(1);

  // And once Bravo is live by the MatchTime owner, Ben is told so with no id.
  const benCtx = await browser.newContext();
  const ben = await benCtx.newPage();
  await signInAs(ben, BRAVO.ownerId, "/admin");
  const again = await forge(benCtx.request, goLive, BRAVO.id);
  expect(again.status).toBe(200);
  expect(again.text).toContain("already-live");
  expect(again.text).toContain("matchtime");
  expect(again.text).not.toContain(U.admin);
  expect(again.text).not.toContain("owner:");
  await benCtx.close();
  await ownerCtx.close();
});
