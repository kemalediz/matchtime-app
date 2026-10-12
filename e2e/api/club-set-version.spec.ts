/**
 * THE CLUB SET VERSION, against a real Postgres and the real routes
 * (src/lib/club-set-version.ts, 2026-10-13).
 *
 * The Pi polls GET /api/whatsapp/platform-jobs every tick. Its response
 * now carries a stamp that changes whenever the clubs the Pi should serve,
 * monitor or silence change; /orgs carries the stamp its snapshot was read
 * at. When the two differ the Pi refreshes at once, instead of up to five
 * minutes later.
 *
 * This walks EVERY transition that must change the stamp, and shows after
 * each that the poll's stamp is the one a fresh /orgs gives (so one
 * refresh settles it), and that /orgs then lists the group where it
 * belongs. It also shows what must NOT change it, and both directions of
 * compatibility on the server's side: the old fields are all still there.
 *
 * Deterministic: no model is called by anything here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E, REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const bare = (phone: string) => phone.replace(/^\+/, "");
const utc = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface OrgsBody {
  orgs: Array<{ id: string; whatsappGroupId: string; liveAt?: string | null }>;
  silentGroups: string[];
  adminGroups: Array<{ groupId: string; orgId: string }>;
  onboardingGroups: string[];
  legacySetupTrigger: boolean;
  clubSetVersion?: string;
}

async function orgs(request: APIRequestContext): Promise<OrgsBody> {
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** What the Pi sees on its every-tick poll. */
async function polled(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/whatsapp/platform-jobs", { headers: HEADERS });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { jobs: unknown[]; clubSetVersion?: string };
  expect(Array.isArray(body.jobs)).toBe(true);
  expect(body.clubSetVersion).toMatch(/^[0-9a-f]{16}$/);
  return body.clubSetVersion!;
}

/**
 * The stamp CHANGED from `before`, and it is the stamp a fresh /orgs
 * carries: the Pi's one refresh brings the two back level.
 */
async function changed(request: APIRequestContext, before: string, label: string): Promise<string> {
  const now = await polled(request);
  expect(now, `${label}: the stamp must change`).not.toBe(before);
  expect((await orgs(request)).clubSetVersion, `${label}: /orgs agrees with the poll`).toBe(now);
  // And it is stable: a second poll is the same, so the Pi does not refresh again.
  expect(await polled(request), `${label}: stable`).toBe(now);
  return now;
}

const HELD = { id: "e2e-csv-held", name: "Stamp FC", group: "120363900000000301@g.us", subject: "Stamp Tuesday 5s", ownerId: "e2e-csv-owner", ownerPhone: "+447700901301" };
const ADMIN_GROUP = "120363900000000302@g.us";
const PENDING = { id: "e2e-csv-pend", name: "Pending Park", group: "120363900000000303@g.us" };

const club = (db: TestDb, id: string) =>
  db.one<{ setupStage: string; whatsappBotEnabled: boolean; approvalStatus: string }>(
    `SELECT "setupStage","whatsappBotEnabled","approvalStatus" FROM "Organisation" WHERE id = $1`,
    [id],
  );

let stamp = "";

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test.describe("the stamp", () => {
  test("is on the every-tick poll and on /orgs, they agree, and it does not move while nothing changes", async ({ request }) => {
    stamp = await polled(request);
    const body = await orgs(request);
    expect(body.clubSetVersion).toBe(stamp);
    for (let i = 0; i < 3; i++) expect(await polled(request)).toBe(stamp);
  });

  test("BACKWARD COMPATIBLE: both responses still carry everything an older Pi reads, unchanged in shape", async ({ request }) => {
    const body = await orgs(request);
    expect(Array.isArray(body.orgs)).toBe(true);
    expect(Array.isArray(body.silentGroups)).toBe(true);
    expect(Array.isArray(body.adminGroups)).toBe(true);
    expect(Array.isArray(body.onboardingGroups)).toBe(true);
    expect(typeof body.legacySetupTrigger).toBe("boolean");
    const seeded = body.orgs.find((o) => o.id === ORG_ID)!;
    expect(seeded).toMatchObject({ id: ORG_ID, whatsappGroupId: E2E.GROUP_ID });
    // A club that was never held has no go-live time: the Pi catches up on nothing for it.
    expect(seeded.liveAt).toBeNull();
    const poll = await (await request.get("/api/whatsapp/platform-jobs", { headers: HEADERS })).json();
    expect(Object.keys(poll).sort()).toEqual(["clubSetVersion", "jobs"]);
  });

  test("does NOT change for things that leave the Pi's sets alone: a rename, a setting, a queued post, a game", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET name = name || ' (renamed)', "rollingSquadEnabled" = NOT "rollingSquadEnabled" WHERE id = $1`, [ORG_ID]);
    await db.run(`INSERT INTO "BotJob" (id,"orgId",kind,text,"sentAt","createdAt") VALUES ('e2e-csv-job',$1,'group','x',now(),now())`, [ORG_ID]);
    expect(await polled(request)).toBe(stamp);
    await db.run(`UPDATE "Organisation" SET name = replace(name, ' (renamed)', ''), "rollingSquadEnabled" = NOT "rollingSquadEnabled" WHERE id = $1`, [ORG_ID]);
    await db.run(`DELETE FROM "BotJob" WHERE id = 'e2e-csv-job'`);
    // A club with no group yet (waiting for approval) is not in the Pi's club sets at all.
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt") VALUES ($1,$2,$1,$3,'pending','en',now(),now())`,
      [PENDING.id, PENDING.name, `${PENDING.id}-invite`],
    );
    expect(await polled(request)).toBe(stamp);
  });
});

test.describe("every transition that changes the Pi's sets changes the stamp", () => {
  test("a club becomes SETTING UP (approved and held): its group joins the silent set", async ({ request, db }) => {
    await db.run(
      `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Sam Stamp',$2,$3,true,true,now())`,
      [HELD.ownerId, `${HELD.ownerId}@e2e-test.invalid`, HELD.ownerPhone],
    );
    await db.run(
      `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
         "whatsappBotEnabled","setupStage","language","createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'approved',$5::timestamp,$4,false,'setting-up','en',now(),now())`,
      [HELD.id, HELD.name, `${HELD.id}-invite`, HELD.group, utc(-3 * 3_600_000)],
    );
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${HELD.ownerId}-m`, HELD.ownerId, HELD.id]);
    await db.run(
      `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
       VALUES ($1,$2,$3,$4,'CSV1','closed',now() + interval '1 hour',$5,$6,now() - interval '4 hours',now())`,
      [`${HELD.id}-cc`, HELD.id, HELD.ownerId, bare(HELD.ownerPhone), HELD.group, HELD.subject],
    );
    stamp = await changed(request, stamp, "setting up");
    const body = await orgs(request);
    expect(body.silentGroups).toContain(HELD.group);
    expect(body.orgs.map((o) => o.id)).not.toContain(HELD.id);
  });

  test("MatchTime is REMOVED from the setting-up club's group, and ADDED BACK (the real routes)", async ({ request, db }) => {
    const removed = await request.post("/api/whatsapp/bot-removed", { headers: HEADERS, data: { groupId: HELD.group } });
    expect(removed.status(), await removed.text()).toBe(200);
    expect(await db.count(`SELECT COUNT(*) FROM "Organisation" WHERE id = $1 AND "setupRemovedAt" IS NOT NULL`, [HELD.id])).toBe(1);
    const whileRemoved = await changed(request, stamp, "removed");
    const back = await request.post("/api/whatsapp/bot-added", {
      headers: HEADERS,
      data: { groupId: HELD.group, groupSubject: HELD.subject, discovered: true },
    });
    expect(back.status(), await back.text()).toBe(200);
    expect(await db.count(`SELECT COUNT(*) FROM "Organisation" WHERE id = $1 AND "setupRemovedAt" IS NULL`, [HELD.id])).toBe(1);
    const afterReAdd = await changed(request, whileRemoved, "re-added");
    // Back to exactly what it was before the removal: nothing else moved.
    expect(afterReAdd).toBe(stamp);
  });

  test("GO-LIVE (the organiser's GO, the real route): the group leaves the silent set and is served, with its go-live time", async ({ request, db }) => {
    const before = Date.now();
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: HEADERS,
      data: { phone: bare(HELD.ownerPhone), body: "GO", waMessageId: `e2e-csv-go-${Date.now()}`, authorName: null },
    });
    expect(await res.json()).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: HELD.id });
    expect(await club(db, HELD.id)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true });
    stamp = await changed(request, stamp, "go-live");
    const body = await orgs(request);
    const live = body.orgs.find((o) => o.id === HELD.id)!;
    expect(live.whatsappGroupId).toBe(HELD.group);
    expect(body.silentGroups).not.toContain(HELD.group);
    // The floor of the Pi's catch-up: nothing said before this is ever fed.
    const liveAt = Date.parse(live.liveAt!);
    expect(liveAt).toBeGreaterThanOrEqual(before - 5_000);
    expect(liveAt).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  test("an ADMIN GROUP is linked, and unlinked", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2 WHERE id = $1`, [HELD.id, ADMIN_GROUP]);
    const linked = await changed(request, stamp, "admin group linked");
    expect((await orgs(request)).adminGroups).toContainEqual({ groupId: ADMIN_GROUP, orgId: HELD.id });
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = NULL WHERE id = $1`, [HELD.id]);
    expect(await changed(request, linked, "admin group unlinked")).toBe(stamp);
    expect((await orgs(request)).adminGroups.map((a) => a.groupId)).not.toContain(ADMIN_GROUP);
  });

  test("a live club is MUTED, and unmuted", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false WHERE id = $1`, [HELD.id]);
    const muted = await changed(request, stamp, "muted");
    expect((await orgs(request)).orgs.map((o) => o.id)).not.toContain(HELD.id);
    await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, [HELD.id]);
    expect(await changed(request, muted, "unmuted")).toBe(stamp);
  });

  test("a club is PAUSED for the club fee, and RESUMED", async ({ request, db }) => {
    const was = (await db.one<{ billingStatus: string }>(`SELECT "billingStatus" FROM "Organisation" WHERE id = $1`, [HELD.id]))!.billingStatus;
    await db.run(`UPDATE "Organisation" SET "billingStatus" = 'paused' WHERE id = $1`, [HELD.id]);
    const paused = await changed(request, stamp, "paused");
    await db.run(`UPDATE "Organisation" SET "billingStatus" = $2 WHERE id = $1`, [HELD.id, was]);
    expect(await changed(request, paused, "resumed")).toBe(stamp);
  });

  test("an approval under the OLD FLOW: a pending club gets its group and its bot in one write", async ({ request, db }) => {
    await db.run(
      `UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now(), "whatsappGroupId" = $2, "whatsappBotEnabled" = true WHERE id = $1`,
      [PENDING.id, PENDING.group],
    );
    stamp = await changed(request, stamp, "old-flow approval");
    const body = await orgs(request);
    const approved = body.orgs.find((o) => o.id === PENDING.id)!;
    expect(approved.whatsappGroupId).toBe(PENDING.group);
    // Never held: no go-live time, so the Pi re-reads nothing for it (as today).
    expect(approved.liveAt).toBeNull();
  });

  test("THE OTHER DIRECTION: a club is SUSPENDED, and the very next /orgs has its group silent and no longer served", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'suspended', "whatsappBotEnabled" = false WHERE id = $1`, [HELD.id]);
    stamp = await changed(request, stamp, "suspended");
    const body = await orgs(request);
    expect(body.orgs.map((o) => o.id)).not.toContain(HELD.id);
    expect(body.silentGroups).toContain(HELD.group);
  });

  test("a club with a group is deleted", async ({ request, db }) => {
    await db.run(`DELETE FROM "Organisation" WHERE id = $1`, [PENDING.id]);
    stamp = await changed(request, stamp, "deleted");
    expect((await orgs(request)).orgs.map((o) => o.id)).not.toContain(PENDING.id);
  });

  test("the live clubs were never touched by any of it", async ({ request, db }) => {
    const body = await orgs(request);
    expect(body.orgs.map((o) => o.id)).toContain(ORG_ID);
    expect(body.silentGroups).not.toContain(E2E.GROUP_ID);
    expect(await club(db, ORG_ID)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true, approvalStatus: "approved" });
  });
});

test.describe("its cost", () => {
  test("one small query per poll: measured against Postgres (tsx)", async () => {
    test.setTimeout(120_000);
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/club-set-version-lib-tests.ts"], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 110_000,
    }).catch((err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`club-set-version lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    });
    console.log(stdout);
    expect(stdout, stderr).toContain("OK");
  });
});
