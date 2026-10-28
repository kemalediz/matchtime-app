/**
 * GO-LIVE SLICE S5: the pages for a club that is approved but still
 * setting up (go-live plan 2.4 and 2.5; owner decisions 4, 5 and 7).
 *
 *   ORGANISER, /admin/settings: a banner above everything else with what
 *     is going on, the Go live button and the exact hello MatchTime will
 *     post; the preview follows the settings; every outcome is worded.
 *   ORGANISER, the admin home: the card says "approved, waiting for you",
 *     never "You're live", and links to the banner.
 *   MATCHTIME OWNER, /admin/clubs: the club is listed as setting up, and
 *     "Go live now" works even while the chat is still being read.
 *
 * Clubs are put into "setting up" by hand (the approval that does it is
 * another slice). The seeded club stands in for Sutton FC: its pages must
 * be exactly as they were.
 *
 * Deterministic end to end: nothing here calls a model.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { countRequestsOf } from "../helpers/action-requests";
import { E2E, E2E_BASE_URL } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { openSettingsCard } from "../helpers/settings-nav";

test.describe.configure({ mode: "serial" });

/** Not committed (/test-results/ is gitignored): the finished pages, for review. */
const SHOTS = path.join(process.cwd(), "test-results", "setup-go-live");

async function shot(page: Page, name: string, fullPage = false) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

/** SETUP_LEARNING_ENABLED for this browser (honoured only under MT_TEST_MODE=1). */
async function readingFlag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-setup-learning", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

/** A UTC instant `offsetMs` from now, for a plain-timestamp column. */
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
  language?: string;
  approvedMinsAgo?: number;
}

async function user(db: TestDb, id: string, name: string, phone: string) {
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
    [id, name, `${id}@e2e-test.invalid`, phone],
  );
}
const member = (db: TestDb, userId: string, orgId: string, role: string) =>
  db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,$4)`, [`${userId}-${orgId}`, userId, orgId, role]);

/** An approved club that is setting up: bot off, group linked, connect closed. */
async function heldClub(db: TestDb, c: Club) {
  await user(db, c.ownerId, c.ownerName, c.ownerPhone);
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","setupStage","language","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',$6::timestamp,$4,false,'setting-up',$5,now(),now())`,
    [c.id, c.name, `${c.id}-invite`, c.group, c.language ?? "en", utc(-(c.approvedMinsAgo ?? 180) * 60_000)],
  );
  await member(db, c.ownerId, c.id, "OWNER");
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'closed',now() + interval '1 hour',$6,$7,now() - interval '4 hours',now())`,
    [`${c.id}-cc`, c.id, c.ownerId, bare(c.ownerPhone), c.id.slice(-4).toUpperCase(), c.group, c.subject],
  );
}

const club = (db: TestDb, id: string) =>
  db.one<{ setupStage: string; whatsappBotEnabled: boolean; liveAt: Date | null; liveBy: string | null }>(
    `SELECT "setupStage","whatsappBotEnabled","liveAt","liveBy" FROM "Organisation" WHERE id = $1`,
    [id],
  );
const groupPosts = (db: TestDb, orgId: string) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' ORDER BY "createdAt" ASC`, [orgId]);

/** Nothing on the page, and nothing in the banner, is wider than its box. */
async function expectNoHorizontalOverflow(page: Page, testId: string): Promise<void> {
  const wide = await page.evaluate((id) => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`page ${doc.scrollWidth} > ${doc.clientWidth}`);
    const box = document.querySelector(`[data-testid="${id}"]`);
    if (!box) return [`no ${id}`];
    const right = box.getBoundingClientRect().right;
    for (const el of Array.from(box.querySelectorAll("*"))) {
      if (el.getBoundingClientRect().right > right + 0.5) out.push(`${el.tagName} ${el.getAttribute("data-testid") ?? ""}`);
    }
    return out;
  }, testId);
  expect(wide).toEqual([]);
}

/** Counts the go-live requests a page sends (their answer carries an outcome). */
function countGoLiveRequests(page: Page): { count: () => number } {
  let n = 0;
  page.on("response", async (res) => {
    const req = res.request();
    if (req.method() !== "POST" || !req.headers()["next-action"]) return;
    const body = await res.text().catch(() => "");
    if (body.includes('"outcome"')) n++;
  });
  return { count: () => n };
}

// ── The cast ────────────────────────────────────────────────────────────
const HARBOUR: Club = { id: "e2e-s5-harb", name: "Harbour FC", group: "120363900000000301@g.us", subject: "Harbour Tuesday 6s", ownerId: "e2e-s5-hana", ownerName: "Hana Harbour", ownerPhone: "+447700902101" };
const BO = { id: "e2e-s5-bo", name: "Bo Bosun", phone: "+447700902102" }; // ADMIN of Harbour
const PIA = { id: "e2e-s5-pia", name: "Pia Player", phone: "+447700902103" }; // a plain member of Harbour
const KIYI: Club = { id: "e2e-s5-kiyi", name: "Kıyı SK", group: "120363900000000302@g.us", subject: "Kıyı Salı Maçı", ownerId: "e2e-s5-kaan", ownerName: "Kaan Kıyı", ownerPhone: "+447700902104", language: "tr" };
const READING: Club = { id: "e2e-s5-read", name: "Reading Rovers", group: "120363900000000303@g.us", subject: "Rovers 5s", ownerId: "e2e-s5-rae", ownerName: "Rae Reader", ownerPhone: "+447700902105", approvedMinsAgo: 20 };
const GONE: Club = { id: "e2e-s5-gone", name: "Gone Athletic", group: "120363900000000304@g.us", subject: "Gone Thursday 7s", ownerId: "e2e-s5-gil", ownerName: "Gil Gone", ownerPhone: "+447700902106" };
const RACE: Club = { id: "e2e-s5-race", name: "Race United", group: "120363900000000305@g.us", subject: "Race Sunday 5s", ownerId: "e2e-s5-rob", ownerName: "Rob Race", ownerPhone: "+447700902107" };
const RIA = { id: "e2e-s5-ria", name: "Ria Race", phone: "+447700902108" }; // ADMIN of Race

/** Turned off by the MatchTime owner while its organiser has the page open. */
const NOPE: Club = { id: "e2e-s5-nope", name: "Nope Rangers", group: "120363900000000306@g.us", subject: "Nope 5s", ownerId: "e2e-s5-ned", ownerName: "Ned Nope", ownerPhone: "+447700902109" };
/** Its organiser's own first press worked; the answer was lost. */
const SELF: Club = { id: "e2e-s5-self", name: "Self United", group: "120363900000000307@g.us", subject: "Self 5s", ownerId: "e2e-s5-sam", ownerName: "Sam Self", ownerPhone: "+447700902110" };
/** The settings refresh fails after it goes live. */
const STALE: Club = { id: "e2e-s5-stal", name: "Stale Town", group: "120363900000000308@g.us", subject: "Stale 5s", ownerId: "e2e-s5-stu", ownerName: "Stu Stale", ownerPhone: "+447700902111" };
/** A 60-character group name with no space in it; removed from its group. */
const LONG_NAME = "Wednesdaynightfootballatthepowerleaguepitchesseasonseventeen";
const LONG: Club = { id: "e2e-s5-long", name: "Long Lane", group: "120363900000000309@g.us", subject: LONG_NAME, ownerId: "e2e-s5-lou", ownerName: "Lou Long", ownerPhone: "+447700902112" };
/** For the preview's refetch rules. */
const FOCUS: Club = { id: "e2e-s5-focu", name: "Focus FC", group: "120363900000000310@g.us", subject: "Focus 5s", ownerId: "e2e-s5-fay", ownerName: "Fay Focus", ownerPhone: "+447700902113" };

const TITLE = "Approved. MatchTime is waiting for you.";

/** A setup DM job as `club-setup-dm.ts` queues it. */
const setupJob = (db: TestDb, c: Club, status: string, sentAt: string | null) =>
  db.run(
    `INSERT INTO "PlatformJob" (id, kind, phone, text, purpose, "refId", status, "sentAt", "createdAt", "updatedAt")
     VALUES ($1,'dm',$2,'setup',$3,$4,$5,$6::timestamp,now(),now())`,
    [`${c.id}-setup-job`, bare(c.ownerPhone), "setup-ask", `${c.id}:setup-ask`, status, sentAt],
  );

/**
 * Counts the PREVIEW requests a page starts, and no other feature's on
 * the same page (helpers/action-requests.ts). The preview's answer is the
 * hello itself; a go-live answers with the hello too, beside an outcome.
 */
const countPreviewRequests = (page: Page) =>
  countRequestsOf(page, (body) => body.includes("has set me up") && !body.includes('"outcome"'));

/** What coming back to the tab does: BOTH events fire. */
const comeBack = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  for (const c of [HARBOUR, KIYI, READING, GONE, RACE, NOPE, SELF, STALE, LONG, FOCUS]) await heldClub(db, c);
  expect(LONG_NAME).toHaveLength(60);
  expect(LONG_NAME).not.toMatch(/\s/);
  await user(db, BO.id, BO.name, BO.phone);
  await member(db, BO.id, HARBOUR.id, "ADMIN");
  await user(db, PIA.id, PIA.name, PIA.phone);
  await member(db, PIA.id, HARBOUR.id, "PLAYER");
  await user(db, RIA.id, RIA.name, RIA.phone);
  await member(db, RIA.id, RACE.id, "ADMIN");
  // Reading Rovers: approved 20 minutes ago and its chat is still being read.
  await db.run(`INSERT INTO "ClubSetupLearning" (id,"orgId",status,attempts,"updatedAt") VALUES ($1,$2,'running',1,now())`, [
    `${READING.id}-learning`,
    READING.id,
  ]);
  // Gone Athletic: MatchTime was removed from its group while it was setting up.
  await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() - interval '1 hour' WHERE id = $1`, [GONE.id]);
  // Kıyı SK: the setup message was due two hours ago, and its job says it went.
  await db.run(`UPDATE "Organisation" SET "setupAskedAt" = $2::timestamp WHERE id = $1`, [KIYI.id, utc(-2 * 3_600_000)]);
  await setupJob(db, KIYI, "sent", utc(-2 * 3_600_000 + 60_000));
  // Long Lane: removed from its group, and its setup message is held until tomorrow.
  await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() - interval '1 hour', "setupAskedAt" = $2::timestamp WHERE id = $1`, [
    LONG.id,
    utc(14 * 3_600_000),
  ]);
  await setupJob(db, LONG, "queued", null);
});

test.beforeEach(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test.afterAll(() => resetDb());

test.describe("a club that is not setting up", () => {
  test("a live club's settings page is exactly as it was: no banner, the WhatsApp bot section unchanged", async ({ page }) => {
    await signInAs(page, U.admin, "/admin/settings");
    await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("go-live-banner")).toHaveCount(0);
    // A live club's WhatsApp bot card starts collapsed: open it to read it.
    await expect(page.getByTestId("settings-card-toggle-whatsapp")).toHaveAttribute("aria-expanded", "false");
    await openSettingsCard(page, "whatsapp");
    await expect(page.getByTestId("go-live-done")).toHaveCount(0);
    await expect(page.getByText(TITLE)).toHaveCount(0);
    await expect(page.getByTestId("wa-setting-up")).toHaveCount(0);
    await expect(page.getByTestId("wa-bot-state")).toHaveText(/^(Enabled|Disabled)$/);
    await expect(page.getByText("Bot configuration is managed server-side.")).toBeVisible();
    const api = await (await page.request.get("/api/org/settings")).json();
    expect(api.setup).toEqual({ settingUp: false, removedFromGroup: false, group: null });
  });
});

test.describe("the organiser of a club that is setting up", () => {
  test("a plain member gets no admin page and is told nothing about the setup", async ({ page }) => {
    await signInAs(page, PIA.id, "/admin/settings");
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).not.toMatch(/^\/admin/);
    await expect(page.getByTestId("go-live-banner")).toHaveCount(0);
    const api = await (await page.request.get("/api/org/settings")).json();
    expect(api.name).toBe("Harbour FC");
    expect(api).not.toHaveProperty("setup");
    expect(api).not.toHaveProperty("inviteCode");
  });

  test("the admin home says approved and waiting, never 'You're live', and links to the banner (owner and admin alike)", async ({ page, browser }) => {
    await signInAs(page, HARBOUR.ownerId, "/admin");
    const card = page.getByTestId("club-connect-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute("data-state", "setting_up");
    await expect(card.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(card).toContainText('MatchTime is in "Harbour Tuesday 6s" and is staying quiet until you go live.');
    await expect(card).not.toContainText("You're live");
    await expect(card).not.toContainText("Muted");
    const link = card.getByRole("link", { name: "Check your settings and go live" });
    await expect(link).toHaveAttribute("href", "/admin/settings#go-live");
    await shot(page, "admin-home-card");
    await link.click();
    await page.waitForURL("**/admin/settings#go-live");
    await expect(page.getByTestId("go-live-banner")).toBeVisible({ timeout: 30_000 });

    // An ADMIN may go live too, so the card is theirs as well.
    const ctx = await browser.newContext();
    const boPage = await ctx.newPage();
    await signInAs(boPage, BO.id, "/admin");
    await expect(boPage.getByTestId("club-connect-card")).toHaveAttribute("data-state", "setting_up", { timeout: 30_000 });
    await ctx.close();
  });

  test("banner and preview; a setting changes the preview; Go live, pressed twice at once, goes live once", async ({ page, db }) => {
    await signInAs(page, HARBOUR.ownerId, "/admin/settings");
    const banner = page.getByRole("region", { name: TITLE });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveAttribute("data-testid", "go-live-banner");
    await expect(banner).toContainText(
      'MatchTime is in "Harbour Tuesday 6s" and is staying quiet until you start it. Check the settings below first, then press Go live.',
    );

    // Above everything else on the page.
    const bannerBox = (await banner.boundingBox())!;
    const general = (await page.getByRole("heading", { name: "General" }).boundingBox())!;
    expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(general.y);

    // The exact hello: WhatsApp bold is bold, the stars are gone, the lines are kept.
    // WHICH CLUB: said beside the button, and in the button's own name.
    await expect(page.getByTestId("go-live-club")).toHaveText("This takes Harbour FC live.");
    await expect(page.getByRole("button", { name: "Go live: Harbour FC" })).toHaveAttribute("data-testid", "go-live-button");
    {
      const clubLine = (await page.getByTestId("go-live-club").boundingBox())!;
      const btn = (await page.getByTestId("go-live-button").boundingBox())!;
      // Straight above the button, nothing between them.
      expect(btn.y - (clubLine.y + clubLine.height)).toBeLessThan(16);
    }
    const preview = page.getByTestId("go-live-preview");
    await expect(preview).toContainText("Hi everyone, I'm MatchTime. Hana has set me up to run this group's games.");
    await expect(preview.locator("strong", { hasText: "Who's in:" })).toBeVisible();
    await expect(preview).not.toContainText("*");
    await expect(preview).toContainText("👋");
    expect(await preview.locator("p").count()).toBeGreaterThan(4);
    const previewText = await preview.innerText();

    // Not "Disabled", and not "contact your administrator".
    await expect(page.getByTestId("wa-setting-up")).toHaveText("Waiting for you to go live");
    await expect(page.getByTestId("wa-bot-state")).toHaveCount(0);
    await expect(page.getByTestId("wa-setting-up-body")).toContainText(
      "MatchTime is approved and in your group. It stays quiet until you press Go live at the top of this page.",
    );
    await expect(page.getByText("Bot configuration is managed server-side.")).toHaveCount(0);
    await shot(page, "banner-desktop");
    await shot(page, "settings-page-desktop-full", true);

    // Change a setting on the page: the preview follows it.
    await openSettingsCard(page, "weekly-routine");
    await page.getByTestId("wr-rolling").getByRole("switch").click();
    // This club has no game played with MatchTime yet, so the preview is
    // the FIRST-GAME form (2026-10-13): it asks for an In, and never says
    // "if you played last time, you're in next time too".
    await expect(preview).toContainText(
      "Same squad each week: this group keeps the same squad from one game to the next. For the first game with me, say In so I know who is playing.",
    );
    await expect(preview).not.toContainText("if you played last time");
    await expect(preview).not.toContainText("Who's in:");
    expect(await preview.innerText()).not.toBe(previewText);
    // ... and it is what a reload shows.
    await page.reload();
    await expect(page.getByTestId("go-live-preview")).toContainText("Same squad each week", { timeout: 30_000 });

    // A phone: nothing scrolls sideways, and the button comes before the message.
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(page.getByTestId("go-live-preview")).toBeVisible();
    await expectNoHorizontalOverflow(page, "go-live-banner");
    const button = page.getByTestId("go-live-button");
    await expect(button).toHaveText("Go live");
    const buttonBox = (await button.boundingBox())!;
    const previewBox = (await page.getByTestId("go-live-preview").boundingBox())!;
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(previewBox.y);
    expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "banner-360-top");
    await page.getByTestId("go-live-button").scrollIntoViewIfNeeded();
    await shot(page, "banner-360");
    await shot(page, "settings-page-360-full", true);
    await page.setViewportSize({ width: 1280, height: 720 });

    // The live region is in the page before anything has happened (review fix 2).
    const status = page.getByTestId("go-live-status");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toBeEmpty();
    await status.evaluate((el) => el.setAttribute("data-same-node", "yes"));

    // Two clicks before the page can redraw: one request.
    const sent = countGoLiveRequests(page);
    await button.evaluate((el: HTMLButtonElement) => {
      el.click();
      el.click();
    });
    const done = page.getByTestId("go-live-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toHaveAttribute("data-outcome", "live");
    await expect(done.getByRole("heading", { name: "You're live." })).toBeVisible();
    // The hello is queued, not yet in the group: the note says so.
    await expect(done.getByRole("status")).toContainText(
      'MatchTime is introducing itself in "Harbour Tuesday 6s" now. It can take a few minutes to appear.',
    );
    await expect(done).not.toContainText("has introduced itself");
    await expect(page.getByTestId("go-live-banner")).toHaveCount(0);
    await expect(page.getByTestId("go-live-button")).toHaveCount(0);
    // Review fix 2: the outcome was written into the SAME live region, and
    // the focus is on the result's heading, not lost with the button.
    await expect(status).toHaveAttribute("data-same-node", "yes");
    await expect(status).toContainText("You're live.");
    expect(
      await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, text: document.activeElement?.textContent })),
    ).toEqual({ id: "go-live-heading", tag: "H2", text: "You're live." });
    await expect(page.getByTestId("go-live-stale")).toHaveCount(0);
    // The page shows the live state without a reload.
    await expect(page.getByTestId("wa-bot-state")).toHaveText("Enabled");
    await expect(page.getByTestId("wa-setting-up")).toHaveCount(0);
    // AFTER GOING LIVE (PR #237): the club is billed (the e2e server runs
    // with BILLING_ENABLED=1), so its free period started with this
    // go-live, and the page says what the WhatsApp "Done" reply says: the
    // free period sentence and the club fee tip. Under the result, INSIDE
    // the one live region, with WhatsApp bold as bold.
    const note = page.getByTestId("go-live-free-period");
    await expect(note).toBeVisible();
    await expect(status.getByTestId("go-live-free-period")).toHaveCount(1);
    await expect(note).toContainText("Your first two months are free.");
    await expect(note).toContainText("after that MatchTime only charges for the games you play, up to £9.99 a month for the group");
    await expect(note.locator("strong", { hasText: "Club fee tip:" })).toBeVisible();
    await expect(note).not.toContainText("*Club fee tip");
    const doneText = (await page.getByTestId("go-live-done-text").boundingBox())!;
    const noteBox = (await note.boundingBox())!;
    expect(noteBox.y).toBeGreaterThanOrEqual(doneText.y + doneText.height);
    // It is the same text the organiser would have had by WhatsApp.
    const billing = await db.one<{ status: string; same: boolean }>(
      `SELECT o."billingStatus" AS status, cb."trialStartedAt" = o."liveAt" AS same
         FROM "Organisation" o JOIN "ClubBilling" cb ON cb."orgId" = o.id WHERE o.id = $1`,
      [HARBOUR.id],
    );
    expect(billing).toEqual({ status: "trial", same: true });
    await shot(page, "went-live-desktop");
    await done.screenshot({ path: path.join(SHOTS, "went-live-note-desktop.png") });
    // A phone: the note wraps inside the banner, nothing scrolls sideways.
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(note).toBeVisible();
    await expectNoHorizontalOverflow(page, "go-live-done");
    await done.scrollIntoViewIfNeeded();
    await shot(page, "went-live-360");
    await done.screenshot({ path: path.join(SHOTS, "went-live-note-360.png") });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForLoadState("networkidle");
    expect(sent.count()).toBe(1);

    // The hello is in the queue once, and it is the one the preview showed.
    expect(await club(db, HARBOUR.id)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true, liveBy: HARBOUR.ownerId });
    const posts = await groupPosts(db, HARBOUR.id);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("*Same squad each week:*");
    expect(posts[0].text).toContain("For the *first game* with me, say *In* so I know who is playing.");
    expect(posts[0].text).not.toContain("if you played last time");
    expect(posts[0].text).toContain("Hana has set me up");
    await done.getByText("The message it is posting").click();
    await expect(page.getByTestId("go-live-posted")).toContainText("Same squad each week");

    // After a reload the club is simply live: the page is as any live club's.
    await page.reload();
    await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("go-live-banner")).toHaveCount(0);
    await expect(page.getByTestId("go-live-done")).toHaveCount(0);
    await expect(page.getByTestId("wa-bot-state")).toHaveText("Enabled");
  });

  test("a Turkish club reads the banner in Turkish, and its hello is the Turkish one", async ({ page }) => {
    await signInAs(page, KIYI.ownerId, "/admin/settings");
    const banner = page.getByRole("region", { name: "Onaylandı. MatchTime sizi bekliyor." });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('MatchTime "Kıyı Salı Maçı" grubunda ve siz başlatana kadar sessiz kalacak.');
    await expect(page.getByTestId("go-live-button")).toHaveText("Yayına al");
    await expect(page.getByRole("button", { name: "Yayına al: Kıyı SK" })).toBeVisible();
    await expect(page.getByTestId("go-live-club")).toHaveText("Bu düğme Kıyı SK kulübünü yayına alır.");
    await expect(banner.getByRole("heading", { name: "MatchTime'ın grubunuza yazacağı mesaj" })).toBeVisible();
    await expect(page.getByTestId("go-live-preview")).toContainText("Herkese merhaba, ben MatchTime.");
    await expect(page.getByTestId("wa-setting-up")).toHaveText("Yayına almanızı bekliyor");
    await shot(page, "banner-desktop-tr");
  });

  test("still reading (owner decision 4): told to try again in a few minutes, nothing goes out, the button comes back", async ({ page, context, db }) => {
    await readingFlag(context, true);
    await signInAs(page, READING.ownerId, "/admin/settings");
    const button = page.getByTestId("go-live-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("go-live-notice")).toHaveCount(0);
    await button.click();
    await expect(page.getByTestId("go-live-notice")).toHaveText(
      "MatchTime is still reading your group's messages, which can take a while. It will send the setup message to the organiser who connected the club when it has finished. Try again after that.",
    );
    // A refusal is announced through the same live region as a final outcome.
    await expect(page.getByTestId("go-live-status").getByTestId("go-live-notice")).toHaveCount(1);
    await expect(button).toBeEnabled();
    await expect(button).toHaveText("Go live");
    await expect(page.getByTestId("go-live-done")).toHaveCount(0);
    expect(await club(db, READING.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await groupPosts(db, READING.id)).toEqual([]);
    await shot(page, "still-reading");
  });

  test("removed from the group: said before anything is pressed, and again on a press; nothing goes out", async ({ page, db }) => {
    // From the REAL removal: start with no stamp, then have the Pi report it.
    await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = NULL WHERE id = $1`, [GONE.id]);
    await signInAs(page, GONE.ownerId, "/admin/settings");
    await expect(page.getByTestId("go-live-lead")).toContainText('MatchTime is in "Gone Thursday 7s"', { timeout: 30_000 });
    await expect(page.getByTestId("go-live-notice")).toHaveCount(0);
    await expect(page.locator("#go-live-heading")).toHaveText("Approved. MatchTime is waiting for you.");
    const removed = await page.request.post("/api/whatsapp/bot-removed", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { groupId: GONE.group },
    });
    expect(await removed.json()).toMatchObject({ ok: true, billing: "setting-up", setup: "removed", orgId: GONE.id });
    await page.reload();
    const notice = page.getByTestId("go-live-notice");
    const text = 'MatchTime is not in "Gone Thursday 7s" any more. Add it back to the group, then press Go live.';
    await expect(notice).toHaveText(text, { timeout: 30_000 });
    // The lead ("MatchTime is in <group> ...") would contradict the notice: it is gone.
    await expect(page.getByTestId("go-live-lead")).toHaveCount(0);
    await expect(page.getByTestId("go-live-banner")).not.toContainText('MatchTime is in "Gone Thursday 7s"');
    // Its own heading: "Approved. MatchTime is waiting for you." above
    // "MatchTime is not in X any more" said two things at once.
    await expect(page.locator("#go-live-heading")).toHaveText("MatchTime was removed from your group");
    await expect(page.getByTestId("go-live-banner")).not.toContainText("MatchTime is waiting for you");
    await shot(page, "removed-desktop");

    // THE WHATSAPP BOT SECTION of the same page agrees with the banner:
    // not "approved and in your group", and no "Nothing is wrong".
    const badge = page.getByTestId("wa-setting-up");
    await expect(badge).toHaveText("Not in your group");
    await expect(badge).toHaveAttribute("data-removed", "true");
    const body = page.getByTestId("wa-setting-up-body");
    await expect(body).toContainText(
      "MatchTime was removed from your group before going live, so nothing has started there. Add it back to the group, then press Go live at the top of this page.",
    );
    await expect(body).not.toContainText("approved and in your group");
    await expect(body.getByRole("link", { name: "Go to Go live" })).toHaveAttribute("href", "#go-live");
    await expect(page.getByTestId("info-st_whatsapp_setup")).toHaveCount(0);
    await page.getByTestId("info-st_whatsapp_removed").click();
    const popup = page.getByRole("dialog");
    await expect(popup).toContainText("it was removed from your WhatsApp group before going live, so it cannot start there.");
    await expect(popup).toContainText("Add MatchTime back to the group.");
    await expect(popup).not.toContainText("Nothing is wrong");
    await page.keyboard.press("Escape");
    await badge.scrollIntoViewIfNeeded();
    await shot(page, "removed-whatsapp-section-desktop");
    await page.setViewportSize({ width: 360, height: 740 });
    await badge.scrollIntoViewIfNeeded();
    await shot(page, "removed-whatsapp-section-360");
    await expectNoHorizontalOverflow(page, "go-live-banner");
    await page.setViewportSize({ width: 1280, height: 720 });

    // THE ADMIN HOME CARD says it too, and still links to the banner.
    await page.goto("/admin");
    const card = page.getByTestId("club-connect-card");
    await expect(card).toHaveAttribute("data-state", "setting_up", { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-removed", "true");
    await expect(card.getByRole("heading", { name: "MatchTime was removed from your group" })).toBeVisible();
    await expect(card).toContainText(
      'MatchTime was removed from "Gone Thursday 7s" before going live. Add it back to the group, then go live.',
    );
    await expect(card).not.toContainText("MatchTime is in");
    await expect(card).not.toContainText("staying quiet");
    await expect(card.getByRole("link", { name: "Go to Go live" })).toHaveAttribute("href", "/admin/settings#go-live");
    await shot(page, "removed-admin-home-card-desktop");
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(card).toBeVisible();
    await expectNoHorizontalOverflow(page, "club-connect-card");
    await shot(page, "removed-admin-home-card-360");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/admin/settings");
    await expect(notice).toHaveText(text, { timeout: 30_000 });
    await page.getByTestId("go-live-button").click();
    await expect(page.getByTestId("go-live-button")).toBeEnabled();
    await expect(notice).toHaveText(text);
    await expect(page.getByTestId("go-live-done")).toHaveCount(0);
    expect(await club(db, GONE.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await groupPosts(db, GONE.id)).toEqual([]);
  });

  test("somebody else got there first: the banner says who, by name and never by number, and nothing is sent twice", async ({ page, db }) => {
    await signInAs(page, RIA.id, "/admin/settings");
    const button = page.getByTestId("go-live-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    // Rob, the owner, goes live while Ria's page is open.
    await db.run(
      `UPDATE "Organisation" SET "setupStage" = 'live', "whatsappBotEnabled" = true, "liveAt" = $2::timestamp, "liveBy" = $3 WHERE id = $1`,
      [RACE.id, utc(0), RACE.ownerId],
    );
    // The go-live action's answer is kept, to be searched. (Two older
    // parts of this page send an admin the club's own admins and members
    // by id and name, for its pickers: /api/org/settings and the "Admin
    // messages go to" loader. They are not this slice's, and not searched.)
    const bodies: string[] = [];
    let settingsSetup: unknown = null;
    page.on("response", async (res) => {
      if (res.request().method() === "POST") {
        const body = await res.text().catch(() => "");
        if (body.includes('"outcome"')) bodies.push(body);
      } else if (res.url().includes("/api/org/settings")) settingsSetup = (await res.json().catch(() => null))?.setup ?? null;
    });
    await button.click();
    const done = page.getByTestId("go-live-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toHaveAttribute("data-outcome", "already");
    await expect(done.getByRole("heading", { name: "Race United is already live." })).toBeVisible();
    // Review fix 5: the organiser who did it is named, and their user id
    // is in nothing the browser was sent.
    await page.waitForLoadState("networkidle");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"outcome":"already-live"');
    expect(bodies[0]).toContain("Rob Race");
    expect(bodies[0]).not.toContain(RACE.ownerId);
    expect(bodies[0]).not.toContain("liveBy");
    // The settings API's setup block names nobody at all.
    expect(settingsSetup).toEqual({ settingUp: false, removedFromGroup: false, group: null });
    await expect(page.getByTestId("go-live-done-text")).toHaveText("Rob Race has already taken Race United live.");
    expect(await done.innerText()).not.toMatch(/\d{6,}/);
    await expect(page.getByTestId("go-live-button")).toHaveCount(0);
    await expect(page.getByTestId("wa-bot-state")).toHaveText("Enabled");
    expect(await groupPosts(db, RACE.id)).toEqual([]);
  });
});

test.describe("review of PR #236: the banner's other outcomes and rules", () => {
  test("fix 1: a club that was turned off is told Go live is not available, in a neutral note, never 'already live'", async ({ page, db }) => {
    await signInAs(page, NOPE.ownerId, "/admin/settings");
    const button = page.getByTestId("go-live-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("go-live-preview")).toBeVisible();
    await page.getByTestId("go-live-status").evaluate((el) => el.setAttribute("data-same-node", "yes"));
    // The MatchTime owner turns the club off while the page is open.
    await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'suspended' WHERE id = $1`, [NOPE.id]);
    await button.click();
    const done = page.getByTestId("go-live-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toHaveAttribute("data-outcome", "closed");
    await expect(done.getByRole("heading", { name: "Go live is not available" })).toBeVisible();
    await expect(page.getByTestId("go-live-done-text")).toHaveText(
      "This club is not waiting to go live any more. Reload the page to see where it stands.",
    );
    await expect(done).not.toContainText("already live");
    await expect(done).not.toContainText("You're live");
    await expect(done).toHaveClass(/bg-slate-50/);
    await expect(done).not.toHaveClass(/bg-emerald-50/);
    await expect(done.locator("svg.text-emerald-700")).toHaveCount(0);
    // Same live region, focus on the heading (fix 2).
    await expect(page.getByTestId("go-live-status")).toHaveAttribute("data-same-node", "yes");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Go live is not available");
    expect(await groupPosts(db, NOPE.id)).toEqual([]);
    expect(await club(db, NOPE.id)).toMatchObject({ whatsappBotEnabled: false, liveAt: null });
    await shot(page, "not-setting-up");
  });

  test("fix 4: their own earlier press worked and its answer was lost: the retry says '<club> is live', in the success style", async ({ page, db }) => {
    await signInAs(page, SELF.ownerId, "/admin/settings");
    const button = page.getByTestId("go-live-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await db.run(
      `UPDATE "Organisation" SET "setupStage" = 'live', "whatsappBotEnabled" = true, "liveAt" = $2::timestamp, "liveBy" = $3 WHERE id = $1`,
      [SELF.id, utc(0), SELF.ownerId],
    );
    await button.click();
    const done = page.getByTestId("go-live-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toHaveAttribute("data-outcome", "live");
    await expect(done.getByRole("heading", { name: "Self United is live." })).toBeVisible();
    await expect(done).not.toContainText("already");
    await expect(done).not.toContainText("Sam Self");
    await expect(done).toHaveClass(/bg-emerald-50/);
    await expect(page.getByTestId("wa-bot-state")).toHaveText("Enabled");
  });

  test("fix 4: the settings refresh fails after going live: the page still agrees with the banner, offers a reload, and nothing is thrown", async ({ page, db }) => {
    const thrown: string[] = [];
    page.on("pageerror", (err) => thrown.push(String(err)));
    await signInAs(page, STALE.ownerId, "/admin/settings");
    const button = page.getByTestId("go-live-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wa-setting-up")).toBeVisible();
    // From here the settings API is unreachable.
    await page.route("**/api/org/settings", (route) => route.abort());
    await button.click();
    const done = page.getByTestId("go-live-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done.getByRole("heading", { name: "You're live." })).toBeVisible();
    // The WhatsApp section does not go on saying "Waiting for you to go live".
    await expect(page.getByTestId("wa-bot-state")).toHaveText("Enabled");
    await expect(page.getByTestId("wa-setting-up")).toHaveCount(0);
    const stale = page.getByTestId("go-live-stale");
    await expect(stale).toContainText("The rest of this page could not be refreshed, so parts of it may be out of date.");
    await expect(stale.getByRole("button", { name: "Reload the page" })).toBeVisible();
    expect(thrown).toEqual([]);
    expect(await club(db, STALE.id)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true });
    // The offered reload brings the whole page up to date.
    await page.unroute("**/api/org/settings");
    await stale.getByRole("button", { name: "Reload the page" }).click();
    await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("go-live-done")).toHaveCount(0);
    await expect(page.getByTestId("wa-bot-state")).toHaveText("Enabled");
  });

  test("fix 8: a 60-character group name with no space wraps inside the banner and its notice at 360px", async ({ page, db }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await signInAs(page, LONG.ownerId, "/admin/settings");
    await expect(page.getByTestId("go-live-preview")).toBeVisible({ timeout: 30_000 });
    // Removed from its group: the notice names the group, and the lead
    // (which would say MatchTime is in it) is not shown.
    await expect(page.getByTestId("go-live-notice")).toContainText(LONG_NAME);
    await expect(page.getByTestId("go-live-lead")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "go-live-banner");
    await shot(page, "long-group-name-360");
    // Back in its group: the lead names the group, and wraps too.
    await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = NULL WHERE id = $1`, [LONG.id]);
    await page.reload();
    await expect(page.getByTestId("go-live-lead")).toContainText(LONG_NAME, { timeout: 30_000 });
    await expect(page.getByTestId("go-live-notice")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "go-live-banner");
    await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() - interval '1 hour' WHERE id = $1`, [LONG.id]);
  });

  test("fix 3: coming back to the tab refetches the preview once per five seconds at most, never beside a go-live, never after the outcome", async ({ page }) => {
    await page.clock.install();
    // The banner's own requests only: the page has other server actions.
    const sent = countPreviewRequests(page);
    const goLives = countGoLiveRequests(page);
    await signInAs(page, FOCUS.ownerId, "/admin/settings");
    await expect(page.getByTestId("go-live-preview")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sent.known()).toBe(true);
    await page.waitForLoadState("networkidle");
    sent.reset();

    // Straight after a fetch: coming back five times asks for nothing.
    for (let i = 0; i < 5; i++) await comeBack(page);
    await page.waitForTimeout(400);
    expect(sent.count()).toBe(0);

    // Six seconds on: focus AND visibilitychange fire, ONE request goes.
    await page.clock.fastForward(6_000);
    await comeBack(page);
    await expect.poll(() => sent.count()).toBe(1);
    for (let i = 0; i < 4; i++) await comeBack(page);
    await page.waitForTimeout(400);
    expect(sent.count()).toBe(1);

    // And again after another gap.
    await page.clock.fastForward(6_000);
    await comeBack(page);
    await expect.poll(() => sent.count()).toBe(2);
    await page.waitForLoadState("networkidle");

    // While the go-live request is in flight (held here for a moment),
    // coming back sends nothing to queue beside it.
    await page.route("**/admin/settings", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await new Promise((r) => setTimeout(r, 1_500));
      }
      await route.continue();
    });
    await page.getByTestId("go-live-button").click();
    await expect(page.getByTestId("go-live-button")).toBeDisabled();
    await page.clock.fastForward(6_000);
    for (let i = 0; i < 3; i++) await comeBack(page);
    await expect(page.getByTestId("go-live-done")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => goLives.count()).toBe(1);
    expect(sent.count()).toBe(2);

    // The outcome is final: the listeners are gone.
    await page.unroute("**/admin/settings");
    await page.waitForLoadState("networkidle");
    const after = sent.count();
    await page.clock.fastForward(60_000);
    for (let i = 0; i < 5; i++) await comeBack(page);
    await page.waitForTimeout(400);
    expect(sent.count()).toBe(after);
  });
});

test.describe("the MatchTime owner, /admin/clubs", () => {
  test("setting-up clubs are listed as setting up, not as live and muted", async ({ page, db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
    await signInAs(page, U.admin, "/admin/clubs");
    const section = page.getByTestId("section-setting-up");
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.getByRole("heading", { name: "Setting up" })).toBeVisible();
    await expect(section.getByTestId("setting-up-club")).toHaveCount(4);
    // A club that was turned off is not "setting up".
    await expect(section.getByTestId("setting-up-club").filter({ hasText: "Nope Rangers" })).toHaveCount(0);

    const reading = section.getByTestId("setting-up-club").filter({ hasText: "Reading Rovers" });
    await expect(reading.getByTestId("setting-up-since")).toHaveText(/^Setting up since \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\.$/);
    await expect(reading.getByTestId("setting-up-message")).toHaveText("Setup message not queued yet.");
    // The removal stamp is written now (the removal slice), so its absence means something.
    await expect(reading.getByTestId("setting-up-group")).toHaveText("MatchTime is still in the group.");
    await expect(reading).not.toContainText("Muted");
    await expect(reading.getByRole("button", { name: "Go live now" })).toBeEnabled();

    const kiyi = section.getByTestId("setting-up-club").filter({ hasText: "Kıyı SK" });
    await expect(kiyi.getByTestId("setting-up-message")).toHaveText(/^Setup message sent \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\.$/);
    // Review fix 6: the stamp is when the DM is DUE. Held until tomorrow is "queued for", never "sent".
    const long = section.getByTestId("setting-up-club").filter({ hasText: "Long Lane" });
    await expect(long.getByTestId("setting-up-message")).toHaveText(/^Setup message queued for \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\.$/);
    await expect(long).not.toContainText("Setup message sent");

    const gone = section.getByTestId("setting-up-club").filter({ hasText: "Gone Athletic" });
    await expect(gone.getByTestId("setting-up-group")).toHaveText(
      /^MatchTime was removed from the group on \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\. It cannot go live until a member of the club adds it back\.$/,
    );
    // Disabled from the stamp the removal wrote, with the reason.
    const goNow = gone.getByRole("button", { name: "Go live now" });
    await expect(goNow).toBeDisabled();
    await expect(goNow).toHaveAttribute("title", "MatchTime is not in this club's group");

    // The live list holds the clubs that ARE live (Harbour and Race went
    // live above), and none that is setting up.
    const live = page.getByTestId("section-live");
    await expect(live.getByTestId("live-club").filter({ hasText: "Harbour FC" })).toHaveCount(1);
    for (const name of ["Reading Rovers", "Kıyı SK", "Gone Athletic", "Long Lane"]) {
      await expect(live.getByTestId("live-club").filter({ hasText: name })).toHaveCount(0);
    }
    await reading.scrollIntoViewIfNeeded();
    await reading.screenshot({ path: (mkdirSync(SHOTS, { recursive: true }), path.join(SHOTS, "owner-row.png")) });
    await shot(page, "owner-clubs-page-full", true);
  });

  test("Go live now: a confirm with the hello, and it works while the chat is still being read; recorded as the owner", async ({ page, context, db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
    // The reading is switched on for this browser and unfinished: the
    // organiser's own button was refused "still reading" above.
    await readingFlag(context, true);
    expect(await db.one(`SELECT status FROM "ClubSetupLearning" WHERE "orgId" = $1`, [READING.id])).toEqual({ status: "running" });

    await signInAs(page, U.admin, "/admin/clubs");
    const reading = page.getByTestId("setting-up-club").filter({ hasText: "Reading Rovers" });
    await expect(reading).toBeVisible({ timeout: 30_000 });
    await reading.getByRole("button", { name: "Go live now" }).click();

    // Nothing has happened yet: it asks first, and shows what will be posted.
    const confirm = reading.getByTestId("go-live-now-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("MatchTime will post this in Reading Rovers's group");
    await expect(confirm.getByTestId("go-live-now-preview")).toContainText("Hi everyone, I'm MatchTime. Rae has set me up");
    await expect(confirm.getByTestId("go-live-now-preview").locator("strong", { hasText: "Who's in:" })).toBeVisible();
    expect(await club(db, READING.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
    await reading.scrollIntoViewIfNeeded();
    await reading.screenshot({ path: path.join(SHOTS, "owner-row-confirm.png") });

    // Cancel changes nothing.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(reading.getByTestId("go-live-now-confirm")).toHaveCount(0);
    expect(await club(db, READING.id)).toMatchObject({ setupStage: "setting-up" });

    await reading.getByRole("button", { name: "Go live now" }).click();
    // The confirm button waits for the message to be on the page.
    const take = reading.getByTestId("go-live-now-confirm").getByRole("button", { name: "Take Reading Rovers live" });
    await expect(reading.getByTestId("go-live-now-preview")).toBeVisible();
    await expect(take).toBeEnabled();
    // Two clicks before the page can redraw: one request.
    let requests = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.headers()["next-action"]) requests++;
    });
    await take.evaluate((el: HTMLButtonElement) => {
      el.click();
      el.click();
    });
    await expect(page.getByText('Reading Rovers is live. The hello is on its way to "Rovers 5s".')).toBeVisible({ timeout: 30_000 });
    expect(requests).toBe(1);

    expect(await club(db, READING.id)).toMatchObject({
      setupStage: "live",
      whatsappBotEnabled: true,
      liveBy: `owner:${U.admin}`,
    });
    const posts = await groupPosts(db, READING.id);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("Rae has set me up");
    // The unfinished reading is closed for good.
    expect(await db.one(`SELECT status, reason FROM "ClubSetupLearning" WHERE "orgId" = $1`, [READING.id])).toEqual({
      status: "skipped",
      reason: "went-live",
    });

    // THE ORGANISER IS TOLD (they did not say GO, so nothing else would
    // tell them): one DM on the platform channel, and the owner sees that.
    await expect(page.getByText("The organiser is being told by WhatsApp.")).toBeVisible();
    const told = await db.all<{ text: string; status: string }>(
      `SELECT text, status FROM "PlatformJob" WHERE purpose = 'setup-owner-live' AND "refId" = $1`,
      [`${READING.id}:setup-owner-live`],
    );
    expect(told).toHaveLength(1);
    expect(told[0].status).toBe("queued");
    expect(told[0].text).toMatch(
      /^The MatchTime team has started MatchTime in "Rovers 5s" for you, so you don't need to reply GO\. It introduces itself in the group, which can take a few minutes to appear\.\n\n/,
    );
    expect(told[0].text).toMatch(/\n\n⚙️ \*Check or change how your group runs:\*\nhttps?:\/\/\S+$/);

    // The page moves the club to the live list.
    await expect(page.getByTestId("setting-up-club").filter({ hasText: "Reading Rovers" })).toHaveCount(0);
    await expect(page.getByTestId("live-club").filter({ hasText: "Reading Rovers" })).toHaveCount(1);
  });

  test("a club's own owner cannot open the owner's page", async ({ page }) => {
    await signInAs(page, KIYI.ownerId, "/admin");
    const res = await page.goto("/admin/clubs");
    expect(res?.status()).toBe(404);
    await expect(page.getByTestId("section-setting-up")).toHaveCount(0);
  });
});
