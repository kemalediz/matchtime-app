/**
 * SELF-JOIN SLICE 4: the organiser web, end to end in a browser.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 5.1 to
 * 5.3 and caps 4 and 5 of section 7.
 *
 * FLAG ON (the `mt-test-self-join=1` cookie, honoured only because the
 * suite boots the server with MT_TEST_MODE=1): an organiser signs up with
 * a WhatsApp code, sets up the club WITH its weekly game, picks Turkish,
 * lands on the club's admin home, taps "Add MatchTime to WhatsApp", and
 * the card walks through every state as the test moves the rows the
 * later slices will write (the connect DM, the group add, the decision).
 *
 * FLAG OFF (cookie `0`, and the suite's env leaves SELF_JOIN_ENABLED
 * unset): /create-org is today's form and makes today's approved club.
 *
 * THE NUMBER (Kemal's hard rule): MatchTime's WhatsApp number is never
 * in a signed-out page, the sitemap, robots.txt, a JS bundle, the setup
 * form, or anybody else's admin page. It appears only on the signed-in
 * organiser's own club page, after the club exists.
 *
 * Deterministic: no model is involved anywhere in this flow.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E, E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const NUMBER = E2E.MATCHTIME_WA_NUMBER; // "447700900555"
/** The number in any shape a page might print it: +44 7700 900555,
 *  447700900555, 07700 900555, 7700-900-555 ... (the last ten digits,
 *  with any separators between them). */
const NUMBER_ANYWHERE = new RegExp(NUMBER.slice(-10).split("").join("[\\s\\-().+]*"));

const ORGANISER_PHONE = "+447700900961";
const SHOTS = path.join(REPO_ROOT, ".e2e", "test-results", "self-join-shots");

async function flag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-self-join", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** A user with a phone verified by a used WhatsApp code, and no club. */
async function verifiedUser(id: string, phone: string, name: string) {
  const db = testDb();
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
     VALUES ($1,$2,$3,$4,true,true,now())`,
    [id, name, `${id}@e2e.local`, phone],
  );
  await db.run(
    `INSERT INTO "PhoneOtp" (id, phone, code, "expiresAt", "usedAt", attempts, "createdAt")
     VALUES ($1,$2,'123456',now(),now(),0,now())`,
    [`${id}-otp`, phone.replace(/\D/g, "")],
  );
}

/** Every same-origin script a page loads, fetched: the number must not
 *  be in any bundle. */
async function assertNoNumberInPageAndBundles(page: Page, where: string) {
  const html = await page.content();
  expect(html, `${where}: HTML`).not.toMatch(NUMBER_ANYWHERE);
  const srcs = await page.$$eval("script[src]", (els) => els.map((e) => (e as HTMLScriptElement).src));
  for (const src of srcs.filter((s) => s.startsWith(E2E_BASE_URL))) {
    const body = await (await page.request.get(src)).text();
    expect(body, `${where}: ${src}`).not.toMatch(NUMBER_ANYWHERE);
  }
}

test.beforeAll(() => {
  resetDb();
});

test("signed out, flag ON: the number is in no public page, bundle, sitemap or redirect", async ({ page, context }) => {
  await flag(context, true);
  for (const p of ["/", "/signup", "/login", "/help", "/help/player", "/help/admin"]) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(200);
    await page.waitForLoadState("networkidle");
    await assertNoNumberInPageAndBundles(page, p);
  }
  for (const p of ["/sitemap.xml", "/robots.txt"]) {
    const res = await page.request.get(p);
    expect(res.status(), p).toBe(200);
    expect(await res.text(), p).not.toMatch(NUMBER_ANYWHERE);
  }
  // /create-org before sign-in: the redirect itself, then where it lands.
  const raw = await page.request.get("/create-org", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(raw.status());
  expect(await raw.text()).not.toMatch(NUMBER_ANYWHERE);
  await page.goto("/create-org");
  await page.waitForURL("**/login**");
  await assertNoNumberInPageAndBundles(page, "/create-org (signed out)");
});

test("flag ON: sign up, set up the club and its weekly game, connect, and the card follows every state", async ({
  page,
  context,
}) => {
  const db = testDb();
  await flag(context, true);
  await page.setViewportSize({ width: 430, height: 932 });

  // ── 1. Sign up with a WhatsApp code (read from the test DB) ──
  await page.goto("/signup");
  await page.getByPlaceholder("Kemal Ediz").fill("Ali Demir");
  await page.getByPlaceholder("+44 7xxx xxxxxx").fill(ORGANISER_PHONE);
  await page.getByRole("button", { name: /send code/i }).click();
  await expect(page.getByPlaceholder("123456")).toBeVisible();
  const otp = await db.one<{ code: string }>(
    `SELECT code FROM "PhoneOtp" WHERE phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORGANISER_PHONE.slice(1)],
  );
  await page.getByPlaceholder("123456").fill(otp!.code);
  await page.getByRole("button", { name: /verify/i }).click();

  // A new signup is sent to /onboarding, which with self-join on is the setup form.
  await page.waitForURL("**/create-org", { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Set up your club" })).toBeVisible();
  await assertNoNumberInPageAndBundles(page, "/create-org (signed in, no club yet)");
  await shot(page, "01-setup-form-en");

  // ── 2. Pick Turkish: the form follows ──
  await page.getByLabel("Language MatchTime speaks in your group").selectOption("tr");
  await expect(page.getByRole("heading", { name: "Kulübünüzü kurun" })).toBeVisible();
  await page.getByLabel("Kulüp adı").fill("Riverside FC");
  await page.getByLabel("Gün", { exact: true }).selectOption({ label: "Salı" });
  await page.getByLabel("Başlama saati").fill("21:30");
  await page.getByLabel("Saha", { exact: true }).fill("Goals Wembley");
  await page.getByLabel("Takım başına oyuncu").selectOption({ label: "7'ye 7" });
  await shot(page, "02-setup-form-tr-filled");
  await page.getByRole("button", { name: "Kulübü kur" }).click();

  // ── 3. The club's admin home, draft ──
  await page.waitForURL("**/admin", { timeout: 30_000 });
  const card = page.getByTestId("club-connect-card");
  await expect(card).toHaveAttribute("data-state", "draft");
  await expect(card).toContainText("MatchTime'ı WhatsApp'a bağlayın");
  // Draft: the number is not on the page yet; the button's action returns it.
  expect(await page.content()).not.toMatch(NUMBER_ANYWHERE);
  await shot(page, "03-admin-draft");

  const org = await db.one<{
    id: string;
    approvalStatus: string;
    language: string;
    whatsappBotEnabled: boolean;
    whatsappGroupId: string | null;
  }>(`SELECT id, "approvalStatus", language, "whatsappBotEnabled", "whatsappGroupId" FROM "Organisation" WHERE name = 'Riverside FC'`);
  expect(org).toMatchObject({ approvalStatus: "draft", language: "tr", whatsappBotEnabled: false, whatsappGroupId: null });
  const game = await db.one<{ dayOfWeek: number; time: string; venue: string; name: string; playersPerTeam: number }>(
    `SELECT a."dayOfWeek", a.time, a.venue, a.name, s."playersPerTeam"
       FROM "Activity" a JOIN "Sport" s ON s.id = a."sportId" WHERE a."orgId" = $1`,
    [org!.id],
  );
  expect(game).toEqual({ dayOfWeek: 2, time: "21:30", venue: "Goals Wembley", name: "7'ye 7 futbol", playersPerTeam: 7 });
  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
    [org!.id, ORGANISER_PHONE],
  );
  expect(owner?.role).toBe("OWNER");

  // ── 4. The button: a code, and WhatsApp opens with the prefilled message ──
  await context.route("https://wa.me/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>whatsapp</body></html>" }),
  );
  await page.getByTestId("club-connect-button").click();
  await page.waitForURL(/^https:\/\/wa\.me\//, { timeout: 30_000 });
  const wa = new URL(page.url());
  expect(wa.pathname).toBe(`/${NUMBER}`);
  const text = wa.searchParams.get("text")!;
  const code = /kod ([A-Z2-9]{4})$/.exec(text)?.[1];
  expect(text).toBe(`Riverside FC kulübünü bağla, kod ${code}`);
  const connect = await db.one<{ status: string; phone: string; expiresAt: Date; issuedAt: Date }>(
    `SELECT status, phone, "expiresAt", "issuedAt" FROM "ClubConnect" WHERE "orgId" = $1`,
    [org!.id],
  );
  expect(connect).toMatchObject({ status: "issued", phone: ORGANISER_PHONE.slice(1) });
  expect(new Date(connect!.expiresAt).getTime() - new Date(connect!.issuedAt).getTime()).toBe(60 * 60 * 1000);

  // ── 5. Back on the page: waiting for your DM, same code, the link again ──
  await page.goto("/admin");
  await expect(card).toHaveAttribute("data-state", "issued");
  await expect(page.getByTestId("club-connect-code")).toHaveText(`Kodunuz: ${code}`);
  const href = await page.getByTestId("club-connect-link").getAttribute("href");
  expect(href).toBe(`https://wa.me/${NUMBER}?text=${encodeURIComponent(text)}`);
  await shot(page, "04-admin-waiting-for-dm");

  // Slice 5 will record a DM with this code from another number: the card says so.
  await db.run(
    `UPDATE "ClubConnect" SET "lastMismatchAt" = now(), "lastMismatchPhoneMasked" = '+44 77** ***321' WHERE "orgId" = $1`,
    [org!.id],
  );
  await page.reload();
  await expect(card).toContainText("Kodunuz +44 77** ***321 numarasından geldi");
  await expect(card).toContainText("+44 7700 900961");

  // ── 6. The DM arrived (slice 5): add me to your group, with the number to save ──
  await db.run(
    `UPDATE "ClubConnect" SET status = 'dm_verified', "dmAt" = now(), "addWindowEndsAt" = now() + interval '24 hours',
       "lastMismatchAt" = NULL, "lastMismatchPhoneMasked" = NULL WHERE "orgId" = $1`,
    [org!.id],
  );
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "dm_verified");
  await expect(page.getByTestId("club-connect-number")).toHaveText("+44 7700 900555");
  // The positive control: the same pattern that finds nothing on every
  // other page finds the number here, so those checks are not vacuous.
  expect(await page.content()).toMatch(NUMBER_ANYWHERE);
  await expect(card).toContainText("2. adım");
  await shot(page, "05-admin-add-me-to-your-group");

  // ── 7. Added to the group (slice 6): pending approval ──
  await db.run(
    `UPDATE "ClubConnect" SET status = 'group_linked', "groupId" = '120363900000000961@g.us',
       "groupSubject" = 'Riverside Salı 7''ler', "adderMatch" = 'phone', "linkedAt" = now() WHERE "orgId" = $1`,
    [org!.id],
  );
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'pending' WHERE id = $1`, [org!.id]);
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "pending");
  await expect(card).toContainText("3. adım: grubunuzu kontrol ediyoruz");
  await shot(page, "06-admin-pending");
  await db.run(`UPDATE "ClubConnect" SET "adderMatch" = 'unknown' WHERE "orgId" = $1`, [org!.id]);
  await page.reload();
  await expect(card).toContainText(`MatchTime "Riverside Salı 7'ler" grubuna başka biri tarafından eklendi`);

  // ── 8. Decided (slice 7) ──
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now() WHERE id = $1`, [org!.id]);
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "approved");
  await expect(card).toContainText(`Aktifsiniz. MatchTime "Riverside Salı 7'ler" grubunda herkese merhaba dedi.`);
  await shot(page, "07-admin-approved");

  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'rejected', "approvedAt" = NULL WHERE id = $1`, [org!.id]);
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "rejected");
  await expect(card).toContainText("Bu grubu şu an alamıyoruz.");
  await shot(page, "08-admin-rejected");

  // ── 9. One club per verified phone ──
  await page.goto("/create-org");
  await expect(page.getByTestId("sj-refusal")).toContainText("You already have a club on MatchTime.");
  await shot(page, "09-second-club-refused");
});

test("flag ON: 3 codes a day per club, then 'try again tomorrow'; an expired code offers the button again", async ({
  page,
  context,
}) => {
  const db = testDb();
  await flag(context, true);
  const org = await db.one<{ id: string }>(`SELECT id FROM "Organisation" WHERE name = 'Riverside FC'`);
  const user = await db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [ORGANISER_PHONE]);
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'draft', "approvedAt" = NULL WHERE id = $1`, [org!.id]);
  await db.run(`DELETE FROM "ClubConnect" WHERE "orgId" = $1`, [org!.id]);
  // Three codes issued in the last few minutes, all already expired.
  // (UTC ISO strings: the columns are timestamps without a zone that the
  // app reads as UTC, and the embedded Postgres's now() is local time.)
  const now = Date.now();
  for (const [i, code] of ["AAA2", "AAA3", "AAA4"].entries()) {
    await db.run(
      `INSERT INTO "ClubConnect" (id, "orgId", "userId", phone, code, status, "issuedAt", "expiresAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,'issued',$6,$7,now())`,
      [`e2e-cc-${i}`, org!.id, user!.id, ORGANISER_PHONE.slice(1), code, new Date(now - (3 - i) * 60_000).toISOString(), new Date(now - 30_000).toISOString()],
    );
  }
  await signInAs(page, user!.id, "/admin");
  const card = page.getByTestId("club-connect-card");
  await expect(card).toHaveAttribute("data-state", "expired");
  await expect(card).toContainText("Bu kodun süresi doldu.");
  await page.getByTestId("club-connect-button").click();
  await expect(card).toContainText("Bugünkü kodlarınızı kullandınız. Lütfen yarın tekrar deneyin.");
  expect(await db.count(`SELECT COUNT(*) FROM "ClubConnect" WHERE "orgId" = $1`, [org!.id])).toBe(3);
  expect(await db.count(`SELECT COUNT(*) FROM "ClubConnect" WHERE "orgId" = $1 AND status = 'issued'`, [org!.id])).toBe(0);
  await shot(page, "10-code-cap");
});

test("flag ON: a phone never verified by a WhatsApp code cannot set up a club", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, U.player);
  await page.goto("/create-org");
  await expect(page.getByTestId("sj-refusal")).toContainText("Please confirm your WhatsApp number first");
  await expect(page.getByRole("link", { name: "Confirm my number" })).toHaveAttribute("href", "/signup");
});

test("flag ON: 10 new clubs a day across the site, then 'try again tomorrow'", async ({ page, context }) => {
  const db = testDb();
  await flag(context, true);
  for (let i = 0; i < 10; i++) {
    await db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "approvalStatus", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$2,'draft',now(),now())`,
      [`e2e-sj-cap-${i}`, `e2e-sj-cap-${i}-invite`],
    );
  }
  await verifiedUser("e2e-sj-late", "+447700900962", "Late Organiser");
  await signInAs(page, "e2e-sj-late");
  await page.goto("/create-org");
  await expect(page.getByTestId("sj-refusal")).toContainText("We're taking on a few new clubs each day.");
  await db.run(`DELETE FROM "Organisation" WHERE id LIKE 'e2e-sj-cap-%'`);
});

test("flag ON: the /onboarding wizard is closed and sends the organiser to the setup form", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, "e2e-sj-late");
  await page.goto("/onboarding");
  await page.waitForURL("**/create-org");
  await expect(page.getByRole("heading", { name: "Set up your club" })).toBeVisible();
});

test("signed in, not the organiser: another club's admin never sees the number or the card", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  await expect(page.getByTestId("club-connect-card")).toHaveCount(0);
  expect(await page.content()).not.toMatch(NUMBER_ANYWHERE);
});

test("flag OFF: /create-org is today's form and makes today's club", async ({ page, context }) => {
  const db = testDb();
  await flag(context, false);
  await verifiedUser("e2e-sj-off", "+447700900963", "Offline Organiser");
  await signInAs(page, "e2e-sj-off");

  // The wizard is open as before.
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.goto("/create-org");
  await expect(page.getByRole("heading", { name: "Create your organisation" })).toBeVisible();
  await expect(page.getByText("Already running a WhatsApp group?")).toBeVisible();
  await page.getByPlaceholder("e.g. Sunday League FC").fill("Flag Off FC");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/admin/activities", { timeout: 30_000 });

  const org = await db.one<{ approvalStatus: string; approvedAt: Date | null; activities: number }>(
    `SELECT o."approvalStatus", o."approvedAt", (SELECT COUNT(*)::int FROM "Activity" a WHERE a."orgId" = o.id) AS activities
       FROM "Organisation" o WHERE o.name = 'Flag Off FC'`,
  );
  expect(org).toEqual({ approvalStatus: "approved", approvedAt: null, activities: 0 });

  await page.goto("/admin");
  await expect(page.getByTestId("club-connect-card")).toHaveCount(0);
  expect(await page.content()).not.toMatch(NUMBER_ANYWHERE);
});
