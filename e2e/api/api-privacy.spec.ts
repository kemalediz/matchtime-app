/**
 * Member-facing API routes never hand a plain member admin-only data,
 * and never cross clubs (PR #148 review).
 *
 * Drives the REAL routes over HTTP with a real NextAuth session (the
 * magic-link sign-in), against the isolated e2e database:
 *
 *   - GET /api/players: a PLAYER gets names and ids, no phone, email,
 *     seed or aliases; the OWNER gets them all;
 *   - GET /api/players/:id: a PLAYER sees a club-mate with no phone or
 *     email, and another club's player is a 404; the OWNER sees contact;
 *   - GET /api/matches/:id: attendance rows carry no payment fields,
 *     and another club's match is a 404;
 *   - GET /api/org/settings: a PLAYER gets no invite code, group id,
 *     Stripe status or member list; the OWNER does.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { testDb } from "../helpers/test-db";
import { PHONE, SPORT_ID, MATCH } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const OTHER_ORG = "e2e-privacy-other-org";
const OTHER_USER = "e2e-privacy-other-user";
const OTHER_PHONE = "+447700900977";
const OTHER_ACTIVITY = "e2e-privacy-other-activity";
const OTHER_MATCH = "e2e-privacy-other-match";

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","createdAt","updatedAt")
     VALUES ($1,'Elsewhere FC',$1,$2,now(),now())`,
    [OTHER_ORG, `${OTHER_ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ($1,'Otto Other',$2,$3,true,true,now())`,
    [OTHER_USER, `${OTHER_USER}@e2e-test.invalid`, OTHER_PHONE],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [
    `${OTHER_USER}-mem`,
    OTHER_USER,
    OTHER_ORG,
  ]);
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"isActive","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Elsewhere 5s',3,'20:00','Elsewhere Arena',true,now(),now())`,
    [OTHER_ACTIVITY, OTHER_ORG, SPORT_ID],
  );
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers","attendanceDeadline","createdAt","updatedAt")
     VALUES ($1,$2,now() + interval '2 days',10,now() + interval '1 day',now(),now())`,
    [OTHER_MATCH, OTHER_ACTIVITY],
  );
  // A seed rating so the member view has something to leak.
  await db.run(`UPDATE "Membership" SET "seedRating" = 7 WHERE "userId" = $1`, [U.rater]);
});

test.beforeEach(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id IN ($1,$2)`, [U.admin, U.player]);
});

test("a plain member gets names only from /api/players; the owner gets contact and seeds", async ({ page }) => {
  await signInAs(page, U.player, "/profile");
  const res = await page.request.get("/api/players?includeFormer=1");
  expect(res.status()).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text) as { players: Array<Record<string, unknown>> };
  expect(body.players.length).toBeGreaterThan(3);
  expect(body.players.find((p) => p.id === U.rater)).toMatchObject({ name: "Riley Rater" });
  for (const p of body.players) {
    for (const f of ["phoneNumber", "email", "seedRating", "clubRating", "aliases"]) {
      expect(p, f).not.toHaveProperty(f);
    }
  }
  for (const phone of Object.values(PHONE)) expect(text).not.toContain(phone);
  expect(text).not.toContain(OTHER_USER);

  await page.context().clearCookies();
  await signInAs(page, U.admin, "/admin/players");
  const adminBody = (await (await page.request.get("/api/players")).json()) as {
    players: Array<Record<string, unknown>>;
  };
  const rater = adminBody.players.find((p) => p.id === U.rater)!;
  expect(rater.phoneNumber).toBe(PHONE.rater);
  expect(rater.seedRating).toBe(7);
  expect(adminBody.players.some((p) => p.id === OTHER_USER)).toBe(false);
});

test("/api/players/:id hides a club-mate's contact from a member and 404s another club", async ({ page }) => {
  await signInAs(page, U.player, "/profile");
  const mate = await page.request.get(`/api/players/${U.rater}`);
  expect(mate.status()).toBe(200);
  const mateBody = (await mate.json()) as { player: Record<string, unknown> };
  expect(mateBody.player).toMatchObject({ id: U.rater, name: "Riley Rater" });
  expect(mateBody.player).not.toHaveProperty("phoneNumber");
  expect(mateBody.player).not.toHaveProperty("email");

  // Their own profile still carries their own contact details.
  const self = (await (await page.request.get(`/api/players/${U.player}`)).json()) as {
    player: Record<string, unknown>;
  };
  expect(self.player.phoneNumber).toBe(PHONE.player);

  const other = await page.request.get(`/api/players/${OTHER_USER}`);
  expect(other.status()).toBe(404);
  expect(await other.text()).not.toContain(OTHER_PHONE);

  await page.context().clearCookies();
  await signInAs(page, U.admin, "/admin/players");
  const asOwner = (await (await page.request.get(`/api/players/${U.rater}`)).json()) as {
    player: Record<string, unknown>;
  };
  expect(asOwner.player.phoneNumber).toBe(PHONE.rater);
  expect((await page.request.get(`/api/players/${OTHER_USER}`)).status()).toBe(404);
});

test("/api/matches/:id carries no payment fields and 404s another club's match", async ({ page }) => {
  await signInAs(page, U.player, "/profile");
  const res = await page.request.get(`/api/matches/${MATCH.pay}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { attendances: Array<Record<string, unknown>> };
  expect(body.attendances.length).toBeGreaterThan(0);
  for (const a of body.attendances) {
    for (const f of ["paidAt", "paymentMethod", "paymentAmount", "paymentQuantity", "stripeSessionId", "directPendingAt"]) {
      expect(a, f).not.toHaveProperty(f);
    }
  }
  expect((await page.request.get(`/api/matches/${OTHER_MATCH}`)).status()).toBe(404);
});

test("/api/org/settings gives a member no invite code or payment data; the owner gets them", async ({ page }) => {
  await signInAs(page, U.player, "/profile");
  const member = (await (await page.request.get("/api/org/settings")).json()) as Record<string, unknown>;
  expect(member.name).toBeTruthy();
  for (const f of ["inviteCode", "whatsappGroupId", "stripeConnected", "paymentHolderId", "members"]) {
    expect(member, f).not.toHaveProperty(f);
  }

  await page.context().clearCookies();
  await signInAs(page, U.admin, "/admin/settings");
  const owner = (await (await page.request.get("/api/org/settings")).json()) as Record<string, unknown>;
  expect(owner.inviteCode).toBeTruthy();
  expect(owner).toHaveProperty("members");
});
