/**
 * GO-LIVE SLICE S4: the organiser says GO, against a real Postgres and
 * the real dm-reply route (go-live plan 2.4 and 2.5; owner decisions 4,
 * 5 and 8).
 *
 * Clubs are put into "setting up" by hand here (the approval that does it
 * is slice S3). Every outcome of GO is walked through the route the Pi
 * calls: went live, already live, still reading, removed from the group,
 * more than one club; plus who may NOT say it, a replay of the same
 * WhatsApp message, two GOs at once, the queue purge, the "not
 * recognised" reply and help on the platform channel.
 *
 * The seeded club stands in for Sutton FC: with no club setting up, a DM
 * saying "go" from its admin must do exactly what it did before.
 *
 * Deterministic end to end: no real model is called by anything here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { clearPipelineStubs, helpOn } from "../helpers/stub";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };

let n = 0;
const msgId = () => `e2e-go-live-${Date.now()}-${++n}`;
const bare = (phone: string) => phone.replace(/^\+/, "");
/** A UTC instant `offsetMs` from now, for a plain-timestamp column: the
 *  app reads those as UTC, whatever the database session's time zone. */
const utc = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function dm(
  request: APIRequestContext,
  phone: string,
  body: string,
  opts: { waMessageId?: string; headers?: Record<string, string> } = {},
) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { ...HEADERS, ...(opts.headers ?? {}) },
    data: { phone: bare(phone), body, waMessageId: opts.waMessageId ?? msgId(), authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function duePosts(request: APIRequestContext, groupId: string) {
  // Preview mode: nothing is claimed, so the same poll can be read twice.
  return request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...HEADERS, "x-no-claim": "1" },
  });
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
async function heldClub(
  db: TestDb,
  c: { id: string; name: string; group: string; subject: string; ownerId: string; ownerPhone: string; language?: string; approvedMinsAgo?: number },
) {
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
const replies = (db: TestDb, phone: string) =>
  db.all<{ text: string; purpose: string; status: string; sendAfter: Date | null }>(
    `SELECT text, purpose, status, "sendAfter" FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt" ASC, id ASC`,
    [bare(phone)],
  );
const lastReply = async (db: TestDb, phone: string) => (await replies(db, phone)).at(-1);
const botJobs = (db: TestDb, orgId: string) =>
  db.all<{ id: string; kind: string; text: string; sentAt: Date | null }>(
    `SELECT id, kind, text, "sentAt" FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt" ASC`,
    [orgId],
  );
/**
 * "Done", as the organiser of a BILLED club gets it (the e2e server runs
 * with BILLING_ENABLED=1 and these clubs are on Standard): going live
 * starts the free period, so the same message goes on with the free period
 * sentence and the club fee tip (owner decision, 2026-10-12).
 */
const doneWithFreePeriod = (group: string) =>
  new RegExp(`^Done: I'm introducing myself in "${group}" now\\. It can take a few minutes to appear\\.\\n\\nYour first three months are free\\.\\n\\n💷 \\*Club fee tip:\\* after that MatchTime only charges for the games you play, up to £4\\.99 a month`);
const billing = (db: TestDb, orgId: string) =>
  db.one<{ status: string; rows: number }>(
    `SELECT o."billingStatus" AS status, (SELECT COUNT(*)::int FROM "ClubBilling" cb WHERE cb."orgId" = o.id) AS rows FROM "Organisation" o WHERE o.id = $1`,
    [orgId],
  );
const goClaims = (db: TestDb) => db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE 'setup-go-msg:%' OR key LIKE 'setup-dm-msg:%'`);

// ── The cast ────────────────────────────────────────────────────────────
const HARBOUR = { id: "e2e-go-harb", name: "Harbour FC", group: "120363900000000201@g.us", subject: "Harbour Tuesday 6s", ownerId: "e2e-go-hana", ownerPhone: "+447700901101" };
const HANA = HARBOUR.ownerPhone;
/** ADMIN of Harbour, and a PLAYER of the seeded live club. */
const BO = { id: "e2e-go-bo", phone: "+447700901102" };
const PIA = { id: "e2e-go-pia", phone: "+447700901103" }; // a plain member of Harbour
const STRANGER = "+447700901199"; // nobody MatchTime knows

const KIYI = { id: "e2e-go-kiyi", name: "Kıyı SK", group: "120363900000000202@g.us", subject: "Kıyı Salı Maçı", ownerId: "e2e-go-kaan", ownerPhone: "+447700901104", language: "tr" };
const READING = { id: "e2e-go-read", name: "Reading Rovers", group: "120363900000000203@g.us", subject: "Rovers 5s", ownerId: "e2e-go-rae", ownerPhone: "+447700901105", approvedMinsAgo: 20 };
const GONE = { id: "e2e-go-gone", name: "Gone Athletic", group: "120363900000000204@g.us", subject: "Gone Thursday 7s", ownerId: "e2e-go-gil", ownerPhone: "+447700901106" };
const TWIN_A = { id: "e2e-go-twna", name: "Twin A", group: "120363900000000205@g.us", subject: "Twin A 5s", ownerId: "e2e-go-tess", ownerPhone: "+447700901107" };
const TWIN_B = { ...TWIN_A, id: "e2e-go-twnb", name: "Twin B", group: "120363900000000206@g.us", subject: "Twin B 5s" };
const RACE = { id: "e2e-go-race", name: "Race United", group: "120363900000000207@g.us", subject: "Race Sunday 5s", ownerId: "e2e-go-rob", ownerPhone: "+447700901108" };
const RACE_ADMIN = { id: "e2e-go-ria", phone: "+447700901109" };
const PAUSED = { id: "e2e-go-paus", name: "Pause Park", group: "120363900000000208@g.us", subject: "Pause Park 5s", ownerId: "e2e-go-paz", ownerPhone: "+447700901110" };
const LEFTOUT = { id: "e2e-go-left", name: "Leftout FC", group: "120363900000000209@g.us", subject: "Leftout 5s", ownerId: "e2e-go-lou", ownerPhone: "+447700901111" };
const CHATTY = { id: "e2e-go-chat", name: "Chatty FC", group: "120363900000000220@g.us", subject: "Chatty 5s", ownerId: "e2e-go-cat", ownerPhone: "+447700901112" };
const DAILY = { id: "e2e-go-dail", name: "Daily FC", group: "120363900000000221@g.us", subject: "Daily 5s", ownerId: "e2e-go-dee", ownerPhone: "+447700901113" };

const STALE_GROUP = "STALE: Pat is in for Tuesday (tapped on the website)";
const STALE_DM = "STALE: the help answer nobody received";
const STALE_LATER = "STALE: a reminder dated for next week";

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test.describe("before any club is setting up", () => {
  test("a DM saying 'go' from the live club's admin does exactly what it did: no go-live handler, no claim, no platform reply", async ({ request, db }) => {
    const before = await db.count(`SELECT COUNT(*) FROM "PlatformJob"`);
    const res = await dm(request, PHONE.admin, "go");
    expect(res.handled).not.toBe("setup-go");
    expect(res.handled).not.toBe("setup-not-recognised");
    expect(res.ignored).not.toBe("club-setting-up");
    // The very same DM path as any other word from him.
    const other = await dm(request, PHONE.admin, "gosh");
    expect({ handled: res.handled, ignored: res.ignored }).toEqual({ handled: other.handled, ignored: other.ignored });
    expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob"`)).toBe(before);
    expect(await goClaims(db)).toBe(0);
    expect(await club(db, ORG_ID)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true, liveAt: null, liveBy: null });
  });
});

test.describe("GO", () => {
  test.beforeAll(async () => {
    const db = testDb();
    await user(db, HARBOUR.ownerId, "Hana Organiser", HANA);
    await user(db, BO.id, "Bo Both", BO.phone);
    await user(db, PIA.id, "Pia Player", PIA.phone);
    await heldClub(db, HARBOUR);
    await member(db, BO.id, HARBOUR.id, "ADMIN");
    await member(db, BO.id, ORG_ID, "PLAYER");
    await member(db, PIA.id, HARBOUR.id, "PLAYER");
    await db.run(
      `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
       VALUES ($1,$2,'Football 6-a-side',6,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
      [`${HARBOUR.id}-sport`, HARBOUR.id],
    );
    await db.run(
      `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
       VALUES ($1,$2,$3,'Weekly game',2,'21:00','Harbour Pitches',true,5,now(),now())`,
      [`${HARBOUR.id}-activity`, HARBOUR.id, `${HARBOUR.id}-sport`],
    );
    // Fixtures the crons made while it waited: one already played and
    // completed (its post-match flow still owed), one for next week.
    await db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt")
       VALUES ($1,$2,now() - interval '8 hours',12,'COMPLETED',now() - interval '8 hours',now()),
              ($3,$2,now() + interval '6 days',12,'UPCOMING',now() + interval '6 days',now())`,
      [`${HARBOUR.id}-played`, `${HARBOUR.id}-activity`, `${HARBOUR.id}-next`],
    );
    await db.run(
      `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"updatedAt") VALUES ($1,$2,$3,'CONFIRMED',1,now()), ($4,$2,$5,'CONFIRMED',2,now())`,
      [`${HARBOUR.id}-att1`, `${HARBOUR.id}-played`, HARBOUR.ownerId, `${HARBOUR.id}-att2`, PIA.id],
    );
  });

  test("somebody in a live club AND an admin of the setting-up one: an ordinary DM still goes to the LIVE club", async ({ request, db }) => {
    helpOn({ help: {} }); // the question extractor reads it as help (stubbed)
    const res = await dm(request, BO.phone, "help");
    clearPipelineStubs();
    expect(res).toMatchObject({ handled: "dm-help", orgId: ORG_ID, audience: "player" });
    expect(await botJobs(db, HARBOUR.id)).toEqual([]);
    expect(await replies(db, BO.phone)).toEqual([]);
  });

  test("from somebody MatchTime does not know: nothing", async ({ request, db }) => {
    const res = await dm(request, STRANGER, "GO");
    expect(res.ignored).toBe("unknown-sender");
    expect(await club(db, HARBOUR.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
    expect(await goClaims(db)).toBe(0);
  });

  test("from a member of another, live club: not handled here, and nothing goes live", async ({ request, db }) => {
    const res = await dm(request, PHONE.player, "GO");
    expect(res.handled).not.toBe("setup-go");
    expect(await club(db, HARBOUR.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
    expect(await replies(db, PHONE.player)).toEqual([]);
  });

  test("from a PLAIN MEMBER of the club (owner decision 5): silence, and the club stays as it is", async ({ request, db }) => {
    const res = await dm(request, PIA.phone, "GO");
    expect(res.ignored).toBe("club-setting-up");
    expect(await club(db, HARBOUR.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await replies(db, PIA.phone)).toEqual([]);
    expect(await botJobs(db, HARBOUR.id)).toEqual([]);
  });

  test("with trailing words it is NOT GO: the organiser is told it was not recognised, with the settings link", async ({ request, db }) => {
    const res = await dm(request, HANA, "go on then");
    expect(res).toMatchObject({ handled: "setup-not-recognised", orgIds: [HARBOUR.id] });
    expect(await club(db, HARBOUR.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
    const sent = await replies(db, HANA);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ purpose: "setup-reply", status: "queued", sendAfter: null });
    expect(sent[0].text).toMatch(
      /^I didn't recognise that message\. To go live with Harbour FC, reply \*GO\* here, or press \*Go live\* on the settings page:\nhttps?:\/\/\S+$/,
    );
    // The club's own channel is off: nothing was put on it.
    expect(await botJobs(db, HARBOUR.id)).toEqual([]);
  });

  test("not recognised is said EVERY time (owner decision 8), once per WhatsApp message, and never asks a model", async ({ request, db }) => {
    const id = msgId();
    expect((await dm(request, HANA, "when do we start?", { waMessageId: id })).handled).toBe("setup-not-recognised");
    expect((await dm(request, HANA, "cancel this week's game")).handled).toBe("setup-not-recognised");
    expect(await replies(db, HANA)).toHaveLength(3);
    // The Pi replays the first one.
    expect(await dm(request, HANA, "when do we start?", { waMessageId: id })).toMatchObject({ handled: "setup-dm-duplicate" });
    expect(await replies(db, HANA)).toHaveLength(3);
    expect(await db.count(`SELECT COUNT(*) FROM "OrgAiUsage" WHERE "orgId" = $1`, [HARBOUR.id])).toBe(0);
    expect(await botJobs(db, HARBOUR.id)).toEqual([]);
  });

  test("a plain member who says something else still gets silence", async ({ request, db }) => {
    expect((await dm(request, PIA.phone, "am I playing on Tuesday?")).ignored).toBe("club-setting-up");
    expect((await dm(request, PIA.phone, "help")).ignored).toBe("club-setting-up");
    expect(await replies(db, PIA.phone)).toEqual([]);
    expect(await botJobs(db, HARBOUR.id)).toEqual([]);
  });

  test("help reaches the organiser: the same help, on the platform channel", async ({ request, db }) => {
    const before = (await replies(db, HANA)).length;
    helpOn({ help: {} }); // the question extractor reads it as help (stubbed)
    const res = await dm(request, HANA, "help");
    clearPipelineStubs();
    expect(res).toMatchObject({ handled: "dm-help", orgId: HARBOUR.id, audience: "admin" });
    const sent = await replies(db, HANA);
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)).toMatchObject({ purpose: "setup-reply", status: "queued", sendAfter: null });
    expect(sent.at(-1)!.text).not.toMatch(/didn't recognise/);
    // The help talks about tagging MatchTime and saying In or Out in a
    // group it is not listening to yet, so it opens by saying so.
    const notStarted =
      "MatchTime hasn't started in your group yet. Nothing below works there until you reply *GO* here or press *Go live* on your settings page.\n\n";
    expect(sent.at(-1)!.text.startsWith(notStarted)).toBe(true);
    expect(sent.at(-1)!.text.length).toBeGreaterThan(notStarted.length + 80);
    // Not on the club's channel, where it would sit undelivered.
    expect(await botJobs(db, HARBOUR.id)).toEqual([]);
    // And the platform endpoint hands it to the Pi whatever the clubs' switches say.
    const poll = await request.get("/api/whatsapp/platform-jobs", { headers: HEADERS });
    expect(poll.status(), await poll.text()).toBe(200);
    const handed = ((await poll.json()).jobs ?? []) as Array<{ phone: string; text: string }>;
    expect(handed.some((j) => j.phone === bare(HANA))).toBe(true);
  });

  test("GO takes the club live: bot on, stamped, the stale queue DELETED, the hello queued, the organiser told", async ({ request, db }) => {
    await db.run(
      `INSERT INTO "BotJob" (id,"orgId",kind,phone,text,"sendAfter","createdAt") VALUES
         ($1,$4,'group',NULL,$5,NULL,now() - interval '2 hours'),
         ($2,$4,'dm','447700901103',$6,NULL,now() - interval '1 hour'),
         ($3,$4,'dm','447700901103',$7,now() + interval '7 days',now() - interval '1 hour')`,
      [`${HARBOUR.id}-j1`, `${HARBOUR.id}-j2`, `${HARBOUR.id}-j3`, HARBOUR.id, STALE_GROUP, STALE_DM, STALE_LATER],
    );
    expect((await duePosts(request, HARBOUR.group)).status()).toBe(404);

    const id = msgId();
    const res = await dm(request, HANA, "GO", { waMessageId: id });
    expect(res).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: HARBOUR.id });

    const row = await club(db, HARBOUR.id);
    expect(row).toMatchObject({ setupStage: "live", whatsappBotEnabled: true, liveBy: HARBOUR.ownerId });
    expect(row!.liveAt).not.toBeNull();

    const jobs = await botJobs(db, HARBOUR.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "group", sentAt: null });
    expect(jobs[0].text).toMatch(/Hana/);
    expect(jobs.some((j) => j.text.startsWith("STALE"))).toBe(false);

    expect((await lastReply(db, HANA))).toMatchObject({
      text: expect.stringMatching(doneWithFreePeriod("Harbour Tuesday 6s")),
      purpose: "setup-reply",
      status: "queued",
      sendAfter: null,
    });

    // The Pi replays the GO: nothing more happens.
    const count = (await replies(db, HANA)).length;
    expect(await dm(request, HANA, "GO", { waMessageId: id })).toMatchObject({ handled: "setup-go-duplicate" });
    expect(await replies(db, HANA)).toHaveLength(count);
    expect(await botJobs(db, HARBOUR.id)).toHaveLength(1);
  });

  test("the first poll after go-live delivers the hello and NONE of what was queued or owed from before", async ({ request, db }) => {
    const res = await duePosts(request, HARBOUR.group);
    expect(res.status(), await res.text()).toBe(200);
    const instructions = ((await res.json()).instructions ?? []) as Array<{ kind: string; key: string; text?: string; matchId?: string }>;
    const hello = (await botJobs(db, HARBOUR.id))[0];
    expect(instructions.find((i) => i.key === `botjob-${hello.id}`)).toMatchObject({ kind: "group-message", text: hello.text });
    expect(instructions.filter((i) => (i.text ?? "").startsWith("STALE"))).toEqual([]);
    // The scheduler's older intro never follows the hello.
    expect(instructions.filter((i) => i.key.endsWith(":bot-intro"))).toEqual([]);
    // Nothing at all about the game played before go-live: no score ask,
    // payment poll, rating DM or Man of the Match.
    expect(instructions.filter((i) => i.key.startsWith(`${HARBOUR.id}-played:`) || i.matchId === `${HARBOUR.id}-played`)).toEqual([]);
    expect(
      await db.one(`SELECT status, "postMatchEndFlow" FROM "Match" WHERE id = $1`, [`${HARBOUR.id}-played`]),
    ).toEqual({ status: "COMPLETED", postMatchEndFlow: false });
    expect(
      await db.one(`SELECT status, "postMatchEndFlow" FROM "Match" WHERE id = $1`, [`${HARBOUR.id}-next`]),
    ).toEqual({ status: "UPCOMING", postMatchEndFlow: true });
  });

  test("the same game a day later, at rating time: still nothing about it", async ({ request }) => {
    const later = new Date(Date.now() + 26 * 3_600_000);
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(HARBOUR.group)}`, {
      headers: { ...HEADERS, "x-no-claim": "1", "x-test-now": later.toISOString() },
    });
    expect(res.status(), await res.text()).toBe(200);
    const instructions = ((await res.json()).instructions ?? []) as Array<{ key: string; matchId?: string }>;
    expect(instructions.filter((i) => i.key.startsWith(`${HARBOUR.id}-played:`) || i.matchId === `${HARBOUR.id}-played`)).toEqual([]);
  });

  test("the Pi now monitors the group, and it is no longer silent", async ({ request }) => {
    const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
    const body = (await res.json()) as { orgs: Array<{ id: string }>; silentGroups: string[] };
    expect(body.orgs.map((o) => o.id)).toContain(HARBOUR.id);
    expect(body.silentGroups).not.toContain(HARBOUR.group);
  });

  test("a second admin who says GO is told it is already live, and nothing is repeated", async ({ request, db }) => {
    const res = await dm(request, BO.phone, "go live");
    expect(res).toMatchObject({ handled: "setup-go", outcome: "already-live", orgId: HARBOUR.id });
    expect(await lastReply(db, BO.phone)).toMatchObject({ text: "Harbour FC is already live.", purpose: "setup-reply", sendAfter: null });
    expect(await botJobs(db, HARBOUR.id)).toHaveLength(1);
    expect((await club(db, HARBOUR.id))!.liveBy).toBe(HARBOUR.ownerId);
  });

  test("review fix 6: however long ago the club went live, GO from its admin is answered 'already live'", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "liveAt" = $2::timestamp WHERE id = $1`, [HARBOUR.id, utc(-90 * 24 * 3_600_000)]);
    const before = (await replies(db, BO.phone)).length;
    const res = await dm(request, BO.phone, "*GO*");
    expect(res).toMatchObject({ handled: "setup-go", outcome: "already-live", orgId: HARBOUR.id });
    const sent = await replies(db, BO.phone);
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)!.text).toBe("Harbour FC is already live.");
    expect(await botJobs(db, HARBOUR.id)).toHaveLength(1);
  });

  test("a club that went through the hold and is now PAUSED for the club fee: GO gets the paused wording, never 'already live'", async ({ request, db }) => {
    await db.run(
      `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","pausedAt","pausedReason","updatedAt")
       VALUES ($1, $2::timestamp, $3::timestamp, $4::timestamp, 'no-card', now())
       ON CONFLICT ("orgId") DO UPDATE SET "pausedAt" = EXCLUDED."pausedAt", "pausedReason" = 'no-card'`,
      [HARBOUR.id, utc(-70 * 24 * 3_600_000), utc(-9 * 24 * 3_600_000), utc(-3_600_000)],
    );
    const was = await db.one<{ billingStatus: string }>(`SELECT "billingStatus" FROM "Organisation" WHERE id = $1`, [HARBOUR.id]);
    await db.run(`UPDATE "Organisation" SET "billingStatus" = 'paused' WHERE id = $1`, [HARBOUR.id]);
    try {
      const res = await dm(request, BO.phone, "GO", { headers: { "x-mt-test-billing": "1" } });
      // It IS live: "can't go live yet" is the answer for a club still setting up.
      expect(res).toMatchObject({ handled: "setup-go", outcome: "already-live-paused", orgId: HARBOUR.id });
      expect((await lastReply(db, BO.phone))!.text).toMatch(
        /^Harbour FC is already live, but it is paused at the moment\. Your settings page shows what's needed:\nhttps?:\/\/\S+\/admin\/settings$/,
      );
      // Nothing was written for the club.
      expect(await botJobs(db, HARBOUR.id)).toHaveLength(1);
    } finally {
      await db.run(`UPDATE "Organisation" SET "billingStatus" = $2 WHERE id = $1`, [HARBOUR.id, was!.billingStatus]);
    }
  });

  test("once live, the organiser's DMs are no longer stopped by the setting-up rail", async ({ request }) => {
    helpOn({ help: {} }); // the question extractor reads it as help (stubbed)
    const res = await dm(request, HANA, "help");
    clearPipelineStubs();
    expect(res).toMatchObject({ handled: "dm-help", orgId: HARBOUR.id, audience: "admin" });
  });
});

test.describe("GO in Turkish", () => {
  test("BAŞLA from the organiser of a Turkish club: live, a Turkish hello, a Turkish reply", async ({ request, db }) => {
    await user(db, KIYI.ownerId, "Kaan Kaptan", KIYI.ownerPhone);
    await heldClub(db, KIYI);
    const res = await dm(request, KIYI.ownerPhone, "başla!");
    expect(res).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: KIYI.id });
    expect(await club(db, KIYI.id)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true });
    expect(await lastReply(db, KIYI.ownerPhone)).toMatchObject({
      text: expect.stringMatching(/^Tamam: şimdi "Kıyı Salı Maçı" grubunda kendimi tanıtıyorum\. Mesajın görünmesi birkaç dakika sürebilir\.\n\nİlk üç ayınız ücretsiz\.\n\n💷 \*Kulüp ücreti ipucu:\* /),
    });
    const jobs = await botJobs(db, KIYI.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].text).toMatch(/VARIM/);
    expect(jobs[0].text).toMatch(/Kaan/);
  });

  test("the capital form and the form without the cedilla are read too", async ({ request, db }) => {
    for (const [i, word] of ["BAŞLA", "basla"].entries()) {
      const c = { ...KIYI, id: `e2e-go-tr${i}`, group: `12036390000000021${i}@g.us`, ownerId: `e2e-go-tr${i}-u`, ownerPhone: `+44770090112${i}` };
      await user(db, c.ownerId, "Ece Eren", c.ownerPhone);
      await heldClub(db, c);
      expect(await dm(request, c.ownerPhone, word)).toMatchObject({ handled: "setup-go", outcome: "went-live" });
    }
  });
});

test.describe("GO that is refused", () => {
  test("still reading (owner decision 4): the reading has not finished, so the club stays quiet and the organiser is told to wait", async ({ request, db }) => {
    await user(db, READING.ownerId, "Rae Reader", READING.ownerPhone);
    await heldClub(db, READING);
    await db.run(`INSERT INTO "ClubSetupLearning" (id,"orgId",status,attempts,"updatedAt") VALUES ($1,$2,'running',1,now())`, [
      `${READING.id}-learning`,
      READING.id,
    ]);
    const res = await dm(request, READING.ownerPhone, "GO", { headers: { "x-mt-test-setup-learning": "1" } });
    expect(res).toMatchObject({ handled: "setup-go", outcome: "still-reading", orgId: READING.id });
    expect(await club(db, READING.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await botJobs(db, READING.id)).toEqual([]);
    expect(await lastReply(db, READING.ownerPhone)).toMatchObject({
      text: "I'm still reading your group's messages, which can take a while. When I've finished I'll send the setup message to the organiser who connected Reading Rovers. Try *GO* again after that.",
      purpose: "setup-reply",
    });
    expect(await db.one(`SELECT status FROM "ClubSetupLearning" WHERE "orgId" = $1`, [READING.id])).toEqual({ status: "running" });
  });

  test("once the reading has finished the same GO goes through", async ({ request, db }) => {
    await db.run(`UPDATE "ClubSetupLearning" SET status = 'nothing' WHERE "orgId" = $1`, [READING.id]);
    const res = await dm(request, READING.ownerPhone, "GO", { headers: { "x-mt-test-setup-learning": "1" } });
    expect(res).toMatchObject({ handled: "setup-go", outcome: "went-live" });
    expect(await db.one(`SELECT status FROM "ClubSetupLearning" WHERE "orgId" = $1`, [READING.id])).toEqual({ status: "nothing" });
  });

  test("removed from the group while setting up: refused, with what to do", async ({ request, db }) => {
    await user(db, GONE.ownerId, "Gil Gone", GONE.ownerPhone);
    await heldClub(db, GONE);
    await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() - interval '1 hour' WHERE id = $1`, [GONE.id]);
    const res = await dm(request, GONE.ownerPhone, "GO.");
    expect(res).toMatchObject({ handled: "setup-go", outcome: "removed-from-group", orgId: GONE.id });
    expect(await club(db, GONE.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await botJobs(db, GONE.id)).toEqual([]);
    expect(await lastReply(db, GONE.ownerPhone)).toMatchObject({
      text: `I'm not in "Gone Thursday 7s" any more. Add me back, then reply GO.`,
    });
  });

  test("more than one club setting up: none goes live, and the organiser is sent to each club's button", async ({ request, db }) => {
    await user(db, TWIN_A.ownerId, "Tess Twin", TWIN_A.ownerPhone);
    await heldClub(db, TWIN_A);
    await heldClub(db, TWIN_B);
    const res = await dm(request, TWIN_A.ownerPhone, "GO");
    expect(res).toMatchObject({ handled: "setup-go", outcome: "more-than-one", orgId: null });
    for (const id of [TWIN_A.id, TWIN_B.id]) {
      expect(await club(db, id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
      expect(await botJobs(db, id)).toEqual([]);
    }
    expect(await lastReply(db, TWIN_A.ownerPhone)).toMatchObject({
      text: "You have more than one club being set up. Use the Go live button in each club's settings.",
    });
    // Anything else from her lists each club's own settings link.
    expect((await dm(request, TWIN_A.ownerPhone, "ok so how?")).handled).toBe("setup-not-recognised");
    expect((await lastReply(db, TWIN_A.ownerPhone))!.text).toMatch(
      /^I didn't recognise that message\. You have more than one club being set up, so press \*Go live\* in each club's settings:\nhttps?:\/\/\S+\/admin\/settings$/,
    );
  });

  test("review fix 2: a club paused for the club fee cannot go live, so its hello is never queued only to be lost", async ({ request, db }) => {
    await user(db, PAUSED.ownerId, "Paz Paused", PAUSED.ownerPhone);
    await heldClub(db, PAUSED);
    await db.run(
      `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","pausedAt","pausedReason","updatedAt")
       VALUES ($1, $2::timestamp, $3::timestamp, $4::timestamp, 'no-card', now())`,
      [PAUSED.id, utc(-70 * 24 * 3_600_000), utc(-9 * 24 * 3_600_000), utc(-3_600_000)],
    );
    await db.run(`UPDATE "Organisation" SET "billingStatus" = 'paused' WHERE id = $1`, [PAUSED.id]);
    const res = await dm(request, PAUSED.ownerPhone, "GO", { headers: { "x-mt-test-billing": "1" } });
    expect(res).toMatchObject({ handled: "setup-go", outcome: "billing-paused", orgId: PAUSED.id });
    expect(await club(db, PAUSED.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await botJobs(db, PAUSED.id)).toEqual([]);
    expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`org-${PAUSED.id}:bot-intro`])).toBe(0);
    expect((await lastReply(db, PAUSED.ownerPhone))!.text).toMatch(
      /^Pause Park is paused, so I can't go live yet\. Your settings page shows what's needed:\nhttps?:\/\/\S+\/admin\/settings$/,
    );
  });

  test("REMOVED WHILE SETTING UP: the removal is stamped and the organiser told once; GO is refused and NO FREE PERIOD starts; a member adds MatchTime back; GO then goes live and the free period starts at that go-live", async ({ request, db }) => {
    await user(db, LEFTOUT.ownerId, "Lou Leftout", LEFTOUT.ownerPhone);
    await heldClub(db, LEFTOUT);
    const removedAt = () => db.one<{ at: Date | null }>(`SELECT "setupRemovedAt" AS at FROM "Organisation" WHERE id = $1`, [LEFTOUT.id]);
    const removalDms = () =>
      db.all<{ text: string; status: string; refId: string }>(
        `SELECT text, status, "refId" FROM "PlatformJob" WHERE purpose = 'setup-removed' AND phone = $1 ORDER BY "createdAt"`,
        [bare(LEFTOUT.ownerPhone)],
      );
    const remove = async () => {
      const res = await request.post("/api/whatsapp/bot-removed", { headers: HEADERS, data: { groupId: LEFTOUT.group } });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };
    const add = async (data: Record<string, unknown>) => {
      const res = await request.post("/api/whatsapp/bot-added", { headers: HEADERS, data });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };

    // ── Removed ────────────────────────────────────────────────────────
    expect(await remove()).toMatchObject({ ok: true, billing: "setting-up", setup: "removed", orgId: LEFTOUT.id });
    expect((await removedAt())!.at).not.toBeNull();
    // Still approved and setting up; nothing for the group, nothing billed.
    expect(await club(db, LEFTOUT.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await db.one(`SELECT "approvalStatus" AS s FROM "Organisation" WHERE id = $1`, [LEFTOUT.id])).toEqual({ s: "approved" });
    expect(await botJobs(db, LEFTOUT.id)).toEqual([]);
    expect(await billing(db, LEFTOUT.id)).toEqual({ status: "exempt", rows: 0 });
    // The organiser is told, once, on the platform channel.
    let dms = await removalDms();
    expect(dms).toHaveLength(1);
    expect(dms[0].refId).toBe(`${LEFTOUT.id}:setup-removed`);
    expect(dms[0].text).toMatch(
      /^I was removed from "Leftout 5s" before Leftout FC went live, so nothing has started there\. Add me back to the group, then reply \*GO\* here or press \*Go live\* on your settings page:\nhttp\S+\/admin\/settings\nAnyone in Leftout FC can add me back\.$/,
    );
    // The platform owner sees it on /admin/health, once.
    const alerts = () => db.count(`SELECT COUNT(*) FROM "OpsAlert" WHERE "orgId" = $1 AND kind = 'club-setup' AND "dedupeKey" LIKE 'setup-removed:%'`, [LEFTOUT.id]);
    expect(await alerts()).toBe(1);
    // The Pi reports the same removal again: nothing more.
    expect(await remove()).toMatchObject({ billing: "setting-up", setup: "already-removed" });
    expect(await removalDms()).toHaveLength(1);
    expect(await alerts()).toBe(1);

    // ── GO while removed: refused, and no free period starts ───────────
    expect(await dm(request, LEFTOUT.ownerPhone, "GO")).toMatchObject({ handled: "setup-go", outcome: "removed-from-group", orgId: LEFTOUT.id });
    expect((await lastReply(db, LEFTOUT.ownerPhone))!.text).toBe(`I'm not in "Leftout 5s" any more. Add me back, then reply GO.`);
    expect(await club(db, LEFTOUT.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await botJobs(db, LEFTOUT.id)).toEqual([]);
    expect(await billing(db, LEFTOUT.id)).toEqual({ status: "exempt", rows: 0 });

    // ── Added back, but not so as to count ─────────────────────────────
    // By somebody who is not a member of the club: still removed.
    await add({ groupId: LEFTOUT.group, groupSubject: LEFTOUT.subject, addedByPhone: bare(STRANGER) });
    expect((await removedAt())!.at).not.toBeNull();
    // By the organiser, to a DIFFERENT group: still removed.
    await add({ groupId: "120363900000000299@g.us", groupSubject: "Some other group", addedByPhone: bare(LEFTOUT.ownerPhone) });
    expect((await removedAt())!.at).not.toBeNull();
    // The reconnect sweep finding MatchTime in some OTHER group: still removed.
    await add({ groupId: "120363900000000298@g.us", groupSubject: "Another group", discovered: true });
    expect((await removedAt())!.at).not.toBeNull();
    expect((await dm(request, LEFTOUT.ownerPhone, "GO")).outcome).toBe("removed-from-group");

    // ── Added back by the organiser, to the same group ─────────────────
    const setupDms = () =>
      db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'setup-ask' AND "refId" = $1`, [`${LEFTOUT.id}:setup-ask`]);
    expect(await setupDms()).toBe(0);
    const back = await add({ groupId: LEFTOUT.group, groupSubject: LEFTOUT.subject, addedByPhone: bare(LEFTOUT.ownerPhone) });
    expect(back.introText ?? null).toBeNull();
    expect(await removedAt()).toEqual({ at: null });
    // Nothing is said in the group.
    expect(await botJobs(db, LEFTOUT.id)).toEqual([]);
    // The setup DM that never went is sent AT ONCE, by the route itself
    // (after the response), with no cron run: exactly one.
    await expect.poll(setupDms, { timeout: 20_000 }).toBe(1);
    expect(await db.one(`SELECT "setupAskedAt" IS NOT NULL AS asked FROM "Organisation" WHERE id = $1`, [LEFTOUT.id])).toEqual({ asked: true });
    // A second add of the same group sends no second one.
    await add({ groupId: LEFTOUT.group, groupSubject: LEFTOUT.subject, addedByPhone: bare(LEFTOUT.ownerPhone) });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await setupDms()).toBe(1);
    expect(await club(db, LEFTOUT.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
    expect(await billing(db, LEFTOUT.id)).toEqual({ status: "exempt", rows: 0 });

    // ── GO now goes live, and the free period starts at THAT go-live ───
    expect(await dm(request, LEFTOUT.ownerPhone, "GO")).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: LEFTOUT.id });
    expect((await lastReply(db, LEFTOUT.ownerPhone))!.text).toMatch(doneWithFreePeriod("Leftout 5s"));
    expect(await billing(db, LEFTOUT.id)).toEqual({ status: "trial", rows: 1 });
    const period = await db.one<{ same: boolean }>(
      `SELECT cb."trialStartedAt" = o."liveAt" AS same FROM "ClubBilling" cb JOIN "Organisation" o ON o.id = cb."orgId" WHERE o.id = $1`,
      [LEFTOUT.id],
    );
    expect(period).toEqual({ same: true });
    dms = await removalDms();
    expect(dms).toHaveLength(1);
  });

  test("the reconnect sweep finds MatchTime back in a removed club's OWN group: the removal is cleared with no adder named", async ({ request, db }) => {
    const SWEPT = { id: "e2e-go-swpt", name: "Swept FC", group: "120363900000000230@g.us", subject: "Swept 5s", ownerId: "e2e-go-sue", ownerPhone: "+447700901177" };
    await user(db, SWEPT.ownerId, "Sue Swept", SWEPT.ownerPhone);
    await heldClub(db, SWEPT);
    const removedAt = () => db.one<{ at: Date | null }>(`SELECT "setupRemovedAt" AS at FROM "Organisation" WHERE id = $1`, [SWEPT.id]);
    const post = async (url: string, data: Record<string, unknown>) => {
      const res = await request.post(url, { headers: HEADERS, data });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };
    // Not removed: a sweep report changes nothing.
    await post("/api/whatsapp/bot-added", { groupId: SWEPT.group, groupSubject: SWEPT.subject, discovered: true });
    expect(await removedAt()).toEqual({ at: null });

    expect(await post("/api/whatsapp/bot-removed", { groupId: SWEPT.group })).toMatchObject({ setup: "removed" });
    expect((await dm(request, SWEPT.ownerPhone, "GO")).outcome).toBe("removed-from-group");
    // The Pi, after a reconnect, reports the group it is in. No adder.
    const found = await post("/api/whatsapp/bot-added", { groupId: SWEPT.group, groupSubject: SWEPT.subject, discovered: true });
    expect(found.introText ?? null).toBeNull();
    expect(await removedAt()).toEqual({ at: null });
    expect(await botJobs(db, SWEPT.id)).toEqual([]);
    expect(await dm(request, SWEPT.ownerPhone, "GO")).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: SWEPT.id });
  });

  test("removed-while-setting-up against a real Postgres: the setup DM in each state, the owner's Go live now, re-adds (tsx)", async () => {
    test.setTimeout(180_000);
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/setup-removal-lib-tests.ts"], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 170_000,
    }).catch((err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`setup removal lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    });
    expect(stdout, stderr).toMatch(/OK: \d+ setup-removal checks against Postgres/);
  });
});

test.describe("the reply cap (review fix 1a)", () => {
  test("a flood of messages from one organiser queues 5 replies in the hour, then silence; GO still works and still says Done", async ({ request, db }) => {
    await user(db, CHATTY.ownerId, "Cat Chatty", CHATTY.ownerPhone);
    await heldClub(db, CHATTY);
    const out: Array<{ handled?: string; ignored?: string }> = [];
    helpOn({ help: {} }); // the question extractor reads "help" as help (stubbed)
    for (let i = 0; i < 9; i++) out.push(await dm(request, CHATTY.ownerPhone, i === 3 ? "help" : `are you there ${i}?`));
    expect(out.slice(0, 5).map((o) => o.handled)).toEqual([
      "setup-not-recognised",
      "setup-not-recognised",
      "setup-not-recognised",
      "dm-help",
      "setup-not-recognised",
    ]);
    expect(out.slice(5).map((o) => o.ignored)).toEqual(Array(4).fill("setup-reply-capped"));
    expect(await replies(db, CHATTY.ownerPhone)).toHaveLength(5);
    // Help is capped too.
    expect((await dm(request, CHATTY.ownerPhone, "help")).ignored).toBe("setup-reply-capped");
    expect(await replies(db, CHATTY.ownerPhone)).toHaveLength(5);
    clearPipelineStubs();
    // No signed-in link was minted for any of it (review fix 1b).
    const texts = (await replies(db, CHATTY.ownerPhone)).filter((r) => r.text.includes("didn't recognise")).map((r) => r.text);
    expect(texts).toHaveLength(4);
    for (const text of texts) expect(text).toMatch(/\nhttps?:\/\/[^\s/]+\/admin\/settings$/);
    // The cap never stops the club going live, or the one reply that matters.
    expect(await dm(request, CHATTY.ownerPhone, "GO!! 👍")).toMatchObject({ handled: "setup-go", outcome: "went-live" });
    expect((await lastReply(db, CHATTY.ownerPhone))!.text).toMatch(doneWithFreePeriod("Chatty 5s"));
    expect(await replies(db, CHATTY.ownerPhone)).toHaveLength(6);
  });

  test("a reply older than an hour no longer counts towards the hour; 15 in a day is the day's limit", async ({ request, db }) => {
    await user(db, DAILY.ownerId, "Dee Daily", DAILY.ownerPhone);
    await heldClub(db, DAILY);
    // 14 replies sent earlier today, all more than an hour ago.
    for (let i = 0; i < 14; i++) {
      await db.run(
        `INSERT INTO "PlatformJob" (id, kind, phone, text, purpose, status, "createdAt", "updatedAt")
         VALUES ($1, 'dm', $2, 'earlier', 'setup-reply', 'sent', $3::timestamp, now())`,
        [`e2e-go-daily-${i}`, bare(DAILY.ownerPhone), utc(-(2 + i * 0.5) * 3_600_000)],
      );
    }
    expect((await dm(request, DAILY.ownerPhone, "hello?")).handled).toBe("setup-not-recognised");
    expect((await dm(request, DAILY.ownerPhone, "anyone?")).ignored).toBe("setup-reply-capped");
    expect(await replies(db, DAILY.ownerPhone)).toHaveLength(15);
  });
});

test.describe("GO as people really type it (review fix 6)", () => {
  for (const [i, word] of ["*GO*", "GO!!", "Go 👍", "*GO LIVE*"].entries()) {
    test(`${JSON.stringify(word)} takes the club live`, async ({ request, db }) => {
      const c = { ...RACE, id: `e2e-go-say${i}`, name: `Say ${i}`, group: `12036390000000023${i}@g.us`, subject: `Say ${i} 5s`, ownerId: `e2e-go-say${i}-u`, ownerPhone: `+44770090113${i}` };
      await user(db, c.ownerId, "Sam Sayer", c.ownerPhone);
      await heldClub(db, c);
      expect(await dm(request, c.ownerPhone, word)).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: c.id });
      expect((await club(db, c.id))!.liveBy).toBe(c.ownerId);
    });
  }

  test("but a sentence with go in it is still not GO", async ({ request, db }) => {
    const c = { ...RACE, id: "e2e-go-sayno", name: "Say No", group: "120363900000000239@g.us", subject: "Say No 5s", ownerId: "e2e-go-sayno-u", ownerPhone: "+447700901139" };
    await user(db, c.ownerId, "Sal Sayer", c.ownerPhone);
    await heldClub(db, c);
    for (const text of ["*go* on then", "let's go 👍", "go?"]) {
      expect((await dm(request, c.ownerPhone, text)).handled).toBe("setup-not-recognised");
    }
    expect(await club(db, c.id)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false });
  });
});

test.describe("two GOs at once", () => {
  test("two admins say GO in the same instant: one goes live, the other is told already live, and the group gets ONE hello", async ({ request, db }) => {
    await user(db, RACE.ownerId, "Rob Racer", RACE.ownerPhone);
    await user(db, RACE_ADMIN.id, "Ria Racer", RACE_ADMIN.phone);
    await heldClub(db, RACE);
    await member(db, RACE_ADMIN.id, RACE.id, "ADMIN");
    const [a, b] = await Promise.all([dm(request, RACE.ownerPhone, "GO"), dm(request, RACE_ADMIN.phone, "GO")]);
    expect([a.outcome, b.outcome].sort()).toEqual(["already-live", "went-live"]);
    expect((await botJobs(db, RACE.id)).filter((j) => j.kind === "group")).toHaveLength(1);
    const winner = a.outcome === "went-live" ? RACE.ownerPhone : RACE_ADMIN.phone;
    const loser = a.outcome === "went-live" ? RACE_ADMIN.phone : RACE.ownerPhone;
    expect((await club(db, RACE.id))!.liveBy).toBe(winner === RACE.ownerPhone ? RACE.ownerId : RACE_ADMIN.id);
    expect((await lastReply(db, winner))!.text).toMatch(doneWithFreePeriod("Race Sunday 5s"));
    expect((await lastReply(db, loser))!.text).toBe("Race United is already live.");
  });

  test("goLiveClub against a real Postgres: the transaction, the race, every refusal (tsx)", async () => {
    test.setTimeout(180_000);
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/go-live-lib-tests.ts"], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 170_000,
    }).catch((err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`go-live lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    });
    expect(stdout, stderr).toContain("OK");
  });
});

// Setup-hold switch-on fixes (2026-10-13), item 11. A platform job leaves
// "claimed" only when the Pi reports on it; there is no claim timeout. A
// setup DM lost between the claim and the report left the organiser
// untold, the reminder waiting for it for ever, and nothing on any page.
test.describe("a setup message the Pi took and never reported on", () => {
  const STALE = { id: "e2e-go-stal", name: "Stale Town", group: "120363900000000240@g.us", subject: "Stale 5s", ownerId: "e2e-go-stu", ownerPhone: "+447700901140" };
  const alerts = (db: TestDb) =>
    db.all<{ detail: string; dedupeKey: string }>(
      `SELECT detail, "dedupeKey" FROM "OpsAlert" WHERE "orgId" = $1 AND kind = 'club-setup' AND "dedupeKey" LIKE 'setup-dm-claim-stale:%'`,
      [STALE.id],
    );
  const sweep = async (request: APIRequestContext) => {
    const res = await request.get("/api/cron/learn-setup", { headers: { authorization: `Bearer ${E2E.CRON_SECRET}` } });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  };

  test("claimed 20 minutes ago with no outcome: the owner gets ONE event, and the message is NOT sent again", async ({ request, db }) => {
    await user(db, STALE.ownerId, "Stu Stale", STALE.ownerPhone);
    await heldClub(db, STALE);
    // As it is once the setup DM has been queued: the club is stamped as
    // asked, so no sweep sends another.
    await db.run(`UPDATE "Organisation" SET "setupAskedAt" = $2::timestamp WHERE id = $1`, [STALE.id, utc(-20 * 60_000)]);
    await db.run(
      `INSERT INTO "PlatformJob" (id, kind, phone, text, purpose, "refId", status, "claimedAt", "createdAt", "updatedAt")
       VALUES ('e2e-go-stale-job', 'dm', $1, 'Good news: Stale Town is approved.', 'setup-ask', $2, 'claimed', $3::timestamp, $3::timestamp, now()),
              ('e2e-go-fresh-job', 'dm', $1, 'a reminder', 'setup-reminder', $4, 'claimed', $5::timestamp, $5::timestamp, now())`,
      [bare(STALE.ownerPhone), `${STALE.id}:setup-ask`, utc(-20 * 60_000), `${STALE.id}:setup-reminder`, utc(-5 * 60_000)],
    );
    const report = await sweep(request);
    expect(report.staleSetupClaims).toEqual({ considered: 1, recorded: 1 });
    const seen = await alerts(db);
    expect(seen).toHaveLength(1);
    expect(seen[0].dedupeKey).toBe("setup-dm-claim-stale:e2e-go-stale-job");
    expect(seen[0].detail).toContain("setup-dm-claim-stale");
    expect(seen[0].detail).toContain("NOT sent again");
    // No name, number or text of the message in what is recorded.
    expect(seen[0].detail).not.toMatch(/Stale Town|7700901140|Good news/);

    // The next run, 15 minutes later in real life: nothing more.
    await sweep(request);
    expect(await alerts(db)).toHaveLength(1);
    // Never re-queued, never copied: the one job is exactly as the Pi left it.
    expect(
      await db.all(`SELECT id, status FROM "PlatformJob" WHERE "refId" = $1 ORDER BY id`, [`${STALE.id}:setup-ask`]),
    ).toEqual([{ id: "e2e-go-stale-job", status: "claimed" }]);
    await db.run(`DELETE FROM "PlatformJob" WHERE id IN ('e2e-go-stale-job','e2e-go-fresh-job')`);
  });
});
