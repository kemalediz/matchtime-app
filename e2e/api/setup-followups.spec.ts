/**
 * GO-LIVE SLICES S6 AND S7: WHAT FOLLOWS THE SETUP DM. Against a real
 * Postgres and the real routes (go-live plan 2.4 and 2.5; owner decisions
 * 6, 7, 9 and 10).
 *
 * A club approved while SETUP_HOLD_ENABLED is on stays silent in its group
 * until its organiser says GO. This file pins the three things that can
 * follow its one setup DM, each at most once per club:
 *
 *   A. ONE reminder, 24 hours after the setup DM was DUE, inside 09:00 to
 *      23:00 London, then nothing more: there is no automatic go-live;
 *   B. ONE note to the MatchTime owner (and one ops event) for a club
 *      still setting up 72 hours after its approval;
 *   C. the optional ADMIN GROUP step: a block in the setup DM, the link
 *      command as a second message with a code valid 7 days, and the
 *      whole link path for a club that is setting up, with not a word in
 *      the players' group.
 *
 * With the hold off none of it ever fires.
 *
 * The 15-minute cron is driven with a pinned clock (`x-test-now`, honoured
 * only under MT_TEST_MODE=1). Nothing here calls a model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E, E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { messageHoursSendAfter } from "@/lib/message-hours";
import { formatLondon } from "@/lib/london-time";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const PI = { ...KEY, "x-mt-platform-jobs": "1" };
const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };

const HOUR = 60 * 60 * 1000;
const today = new Date().toISOString().slice(0, 10);
/** 12:00 London in summer, 11:00 in winter: inside 09:00 to 23:00, the message hours and the owner's own. */
const DAY = new Date(`${today}T11:00:00.000Z`);
/** 00:30 or 23:30 London: outside message hours, and inside the owner's quiet hours. */
const NIGHT = new Date(`${today}T23:30:00.000Z`);
/**
 * The owner's quiet hours are the night of the shared message hours
 * (owner-dm.ts imports the database client, which Playwright's transpiler
 * cannot load, so the shared rule is called directly): a DM queued between
 * 23:00 and 09:00 London waits for 09:00; otherwise null.
 */
function ownerQuietUntil(now: Date): Date | null {
  return messageHoursSendAfter(now);
}
const ago = (from: Date, hours: number, extraMs = 0) => new Date(from.getTime() - hours * HOUR - extraMs);

interface Club {
  org: string;
  name: string;
  lang: "en" | "tr";
  user: string;
  phone: string;
  code: string;
  group: string;
  hq: string;
  subject: string;
}
let seq = 0;
function club(name: string, lang: "en" | "tr" = "en"): Club {
  const i = ++seq;
  return {
    org: `e2e-s6-org-${i}`,
    name,
    lang,
    user: `e2e-s6-user-${i}`,
    phone: `4477009008${String(i).padStart(2, "0")}`,
    code: `S6${String(i).padStart(2, "0")}`,
    group: `1203639200000000${String(i).padStart(2, "0")}@g.us`,
    hq: `1203639299000000${String(i).padStart(2, "0")}@g.us`,
    subject: `${name} group`,
  };
}

/** The club, its organiser (OWNER) and its connect request, waiting for the owner. */
async function seedPending(c: Club) {
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'pending',$4,now(),now())`,
    [c.org, c.name, `${c.org}-invite`, c.lang],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Ali Demir',$2,$3,true,true,now())`,
    [c.user, `${c.user}@e2e-test.invalid`, `+${c.phone}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${c.user}-mem`, c.user, c.org]);
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","groupId","groupSubject",
       "memberCount","addedByPhone","adderMatch",participants,"detectedLang","linkedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'group_linked',now() - interval '2 hours',now() + interval '1 hour',now() - interval '10 minutes',$4,$6,$7,
       1,$4,'phone',$8::jsonb,$9,now() - interval '5 minutes',now())`,
    [`${c.org}-cc`, c.org, c.user, c.phone, c.code, c.group, c.subject, JSON.stringify([{ phone: c.phone, pushname: "Ali" }]), c.lang],
  );
}

/**
 * A club held by hand: approved at `approvedAt`, setting up, its setup DM
 * due at `askedAt` with a job in state `dm` ("none": no job at all, as when
 * the platform channel refused the number).
 */
async function seedHeld(
  c: Club,
  o: { approvedAt: Date; askedAt: Date | null; dm?: "sent" | "queued" | "claimed" | "failed" | "none" },
) {
  await seedPending(c);
  const db = testDb();
  await db.run(
    `UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = $3, "setupStage" = 'setting-up',
            "whatsappGroupId" = $2, "setupAskedAt" = $4 WHERE id = $1`,
    [c.org, c.group, o.approvedAt.toISOString(), o.askedAt ? o.askedAt.toISOString() : null],
  );
  await db.run(`UPDATE "ClubConnect" SET status = 'closed' WHERE "orgId" = $1`, [c.org]);
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,applied,suggestions,noted,"updatedAt") VALUES ($1,$2,'nothing','[]','[]','[]',now())`,
    [`${c.org}-csl`, c.org],
  );
  const dm = o.dm ?? "sent";
  if (dm !== "none") {
    await db.run(
      `INSERT INTO "PlatformJob" (id,kind,phone,text,purpose,"refId",status,"createdAt","updatedAt")
       VALUES ($1,'dm',$2,'the setup DM','setup-ask',$3,$4,now(),now())`,
      [`${c.org}-ask`, c.phone, `${c.org}:setup-ask`, dm],
    );
  }
}

interface CronReport {
  setupDms?: { considered: number; sent: number };
  setupReminders?: { considered: number; sent: number };
  setupStuck?: { considered: number; noted: number };
}
/** The 15-minute cron at a pinned clock. */
async function cron(request: APIRequestContext, now: Date): Promise<CronReport> {
  const res = await request.get("/api/cron/learn-setup", {
    headers: { ...CRON, "x-mt-test-setup-learning": "0", "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

type Job = { id: string; text: string; refId: string; sendAfter: Date | null; status: string; failReason: string | null; createdAt: Date };
const jobs = (db: TestDb, phone: string, purpose: string) =>
  db.all<Job>(
    `SELECT id, text, "refId", "sendAfter" AT TIME ZONE 'UTC' AS "sendAfter", status, "failReason", "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
       FROM "PlatformJob" WHERE phone = $1 AND purpose = $2 ORDER BY "createdAt"`,
    [phone, purpose],
  );
const reminders = (db: TestDb, c: Club) => jobs(db, c.phone, "setup-reminder");
const ownerNotes = async (db: TestDb, c: Club) =>
  (await jobs(db, E2E.APPROVER_PHONE, "owner-setup-stuck")).filter((j) => j.refId === `${c.org}:setup-stuck`);
const alerts = (db: TestDb, orgId: string) =>
  db.all<{ kind: string; severity: string; title: string; detail: string; dedupeKey: string | null }>(
    `SELECT kind, severity, title, detail, "dedupeKey" FROM "OpsAlert" WHERE "orgId" = $1 ORDER BY "firstSeenAt"`,
    [orgId],
  );
const orgRow = (db: TestDb, id: string) =>
  db.one<{
    approvalStatus: string;
    setupStage: string;
    whatsappBotEnabled: boolean;
    liveAt: Date | null;
    adminGroupId: string | null;
    adminChannelMode: string;
    code: string | null;
    codeExpires: Date | null;
    asked: Date | null;
  }>(
    `SELECT "approvalStatus","setupStage","whatsappBotEnabled","liveAt","adminGroupId","adminChannelMode",
            "adminGroupLinkCode" AS code, "adminGroupLinkCodeExpiresAt" AT TIME ZONE 'UTC' AS "codeExpires",
            "setupAskedAt" AT TIME ZONE 'UTC' AS asked
       FROM "Organisation" WHERE id = $1`,
    [id],
  );

/** Nothing has been said or queued for the players' group, and the Pi still treats it as silent. */
async function expectPlayersGroupSilent(request: APIRequestContext, db: TestDb, c: Club) {
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [c.org])).toBe(0);
  expect((await orgRow(db, c.org))!.whatsappBotEnabled).toBe(false);
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.silentGroups).toContain(c.group);
  expect(orgs.orgs.map((o: { whatsappGroupId: string }) => o.whatsappGroupId)).not.toContain(c.group);
  const poll = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(c.group)}`, { headers: PI });
  expect(poll.status()).toBe(404);
}

/** The owner's "APPROVE <ref>" by WhatsApp, the way the Pi forwards it. */
let wa = 0;
async function approve(request: APIRequestContext, c: Club, hold: "1" | "0", now: Date = DAY) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: {
      ...KEY,
      "x-mt-test-self-join": "1",
      "x-mt-test-setup-hold": hold,
      "x-mt-test-setup-learning": "0",
      "x-test-now": now.toISOString(),
    },
    data: { phone: E2E.APPROVER_PHONE, body: `APPROVE ${c.code}`, waMessageId: `e2e-s6-wa-${++wa}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
async function waitForJob(db: TestDb, c: Club, purpose: string) {
  await expect.poll(async () => (await jobs(db, c.phone, purpose)).length, { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(1);
  return (await jobs(db, c.phone, purpose))[0];
}
const link = async (request: APIRequestContext, data: Record<string, unknown>) => {
  const res = await request.post("/api/whatsapp/admin-group-link", { headers: KEY, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

test.beforeAll(() => {
  resetDb();
});
test.afterAll(() => {
  resetDb();
});

// ══ A. THE 24-HOUR REMINDER ═════════════════════════════════════════════

test("A: 24 hours after the setup DM was due, inside message hours: ONE reminder, at once, with a fresh signed-in settings link", async ({ request, db }) => {
  const c = club("Riverside FC");
  await seedHeld(c, { approvedAt: ago(DAY, 24, 60_000), askedAt: ago(DAY, 24) });

  // A minute before the 24 hours are up: nothing.
  await cron(request, new Date(DAY.getTime() - 60_000));
  expect(await reminders(db, c)).toEqual([]);

  const run = await cron(request, DAY);
  expect(run.setupReminders).toEqual({ considered: 1, sent: 1 });
  const sent = await reminders(db, c);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ refId: `${c.org}:setup-reminder`, status: "queued", sendAfter: null });
  const m = /^Just checking: Riverside FC is approved, but I'm still quiet in "Riverside FC group"\. Reply \*GO\* when you're ready and I'll introduce myself, or check the settings first: (\S+)\nI won't remind you again\.$/.exec(
    sent[0].text,
  );
  expect(m, sent[0].text).not.toBeNull();
  // A signed-in link (a token), not the bare settings address.
  expect(m![1].startsWith(`${E2E_BASE_URL}/`), m![1]).toBe(true);
  expect(m![1]).not.toBe(`${E2E_BASE_URL}/admin/settings`);

  // Once: the next run, and a run a month later, add nothing. No automatic go-live either.
  expect((await cron(request, new Date(DAY.getTime() + 15 * 60_000))).setupReminders).toBeUndefined();
  await cron(request, new Date(DAY.getTime() + 30 * 24 * HOUR));
  expect(await reminders(db, c)).toHaveLength(1);
  expect(await orgRow(db, c.org)).toMatchObject({ setupStage: "setting-up", whatsappBotEnabled: false, liveAt: null });
  await expectPlayersGroupSilent(request, db, c);
});

test("A: due outside message hours: queued for the next 09:00 London, in Turkish for a Turkish club", async ({ request, db }) => {
  const c = club("Kadıköy Halı Saha", "tr");
  await seedHeld(c, { approvedAt: ago(NIGHT, 25), askedAt: ago(NIGHT, 24, 10 * 60_000) });
  await cron(request, NIGHT);
  const sent = await reminders(db, c);
  expect(sent).toHaveLength(1);
  expect(sent[0].status).toBe("queued");
  expect(sent[0].sendAfter).toEqual(messageHoursSendAfter(NIGHT));
  expect(sent[0].text).toMatch(
    /^Küçük bir hatırlatma: Kadıköy Halı Saha onaylandı, ama "Kadıköy Halı Saha group" grubunda hâlâ sessizim\. Hazır olduğunuzda \*BAŞLA\* yazın, kendimi tanıtayım; ya da önce ayarlara göz atın: \S+\nBir daha hatırlatmayacağım\.$/,
  );
  // The Pi is not handed it during the night.
  const poll = await (await request.get("/api/whatsapp/platform-jobs", { headers: PI })).json();
  expect(poll.jobs.some((j: { id: string }) => j.id === sent[0].id)).toBe(false);
});

test("A: NEVER TWICE: six cron runs at the same moment queue exactly one reminder", async ({ request, db }) => {
  const c = club("Racers FC");
  await seedHeld(c, { approvedAt: ago(DAY, 30), askedAt: ago(DAY, 26) });
  const runs = await Promise.all(Array.from({ length: 6 }, () => cron(request, DAY)));
  expect(await reminders(db, c)).toHaveLength(1);
  expect(runs.reduce((n, r) => n + (r.setupReminders?.sent ?? 0), 0)).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${c.org}:setup-reminder:%`])).toBe(1);
});

test("A: not sent to a club that went live, was suspended, or that MatchTime was removed from", async ({ request, db }) => {
  const live = club("Live FC");
  const off = club("Switched Off FC");
  const gone = club("Removed FC");
  for (const c of [live, off, gone]) await seedHeld(c, { approvedAt: ago(DAY, 30), askedAt: ago(DAY, 26) });
  await db.run(`UPDATE "Organisation" SET "setupStage" = 'live', "whatsappBotEnabled" = true, "liveAt" = now() WHERE id = $1`, [live.org]);
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'suspended' WHERE id = $1`, [off.org]);
  await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() WHERE id = $1`, [gone.org]);
  await cron(request, DAY);
  for (const c of [live, off, gone]) expect(await reminders(db, c), c.name).toEqual([]);

  // Added back while still setting up (the removal stamp cleared): reminded then, once.
  await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = NULL WHERE id = $1`, [gone.org]);
  await cron(request, DAY);
  await cron(request, new Date(DAY.getTime() + HOUR));
  expect(await reminders(db, gone)).toHaveLength(1);
  // Tidy: Live FC was made live by hand, with no group routes behind it.
  await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false, "approvalStatus" = 'suspended' WHERE id = $1`, [live.org]);
});

test("A: not sent when the setup DM itself was refused, cancelled or failed; and not BEFORE a setup DM that is still to go", async ({ request, db }) => {
  const refused = club("Refused FC");
  const failed = club("Failed FC");
  const waiting = club("Waiting FC");
  await seedHeld(refused, { approvedAt: ago(DAY, 30), askedAt: ago(DAY, 26), dm: "none" });
  await seedHeld(failed, { approvedAt: ago(DAY, 30), askedAt: ago(DAY, 26), dm: "failed" });
  await seedHeld(waiting, { approvedAt: ago(DAY, 30), askedAt: ago(DAY, 26), dm: "queued" });
  await db.run(`UPDATE "PlatformJob" SET "sendAfter" = $2 WHERE id = $1`, [`${waiting.org}-ask`, new Date(DAY.getTime() + 2 * HOUR).toISOString()]);

  await cron(request, DAY);
  for (const c of [refused, failed, waiting]) expect(await reminders(db, c), c.name).toEqual([]);

  // The setup DM then goes: its club is reminded. The other two never are, whatever appears later.
  await db.run(`UPDATE "PlatformJob" SET status = 'sent' WHERE "refId" IN ($1,$2,$3)`, [
    `${refused.org}:setup-ask`,
    `${failed.org}:setup-ask`,
    `${waiting.org}:setup-ask`,
  ]);
  await cron(request, new Date(DAY.getTime() + 3 * HOUR));
  expect(await reminders(db, waiting)).toHaveLength(1);
  expect(await reminders(db, refused)).toEqual([]);
  expect(await reminders(db, failed)).toEqual([]);
});

// ══ B. THE 72-HOUR NOTE TO THE OWNER ════════════════════════════════════

test("B: still setting up 72 hours after approval: ONE owner DM with the clubs page, and one ops event", async ({ request, db }) => {
  const c = club("Slow Starters FC");
  await seedHeld(c, { approvedAt: ago(DAY, 72), askedAt: ago(DAY, 72), dm: "none" });

  await cron(request, new Date(DAY.getTime() - 60_000));
  expect(await ownerNotes(db, c)).toEqual([]);

  const run = await cron(request, DAY);
  expect(run.setupStuck).toEqual({ considered: 1, noted: 1 });
  const notes = await ownerNotes(db, c);
  expect(notes).toHaveLength(1);
  expect(notes[0].text).toBe(
    `Slow Starters FC has been approved for 3 days and its organiser has not gone live. MatchTime is still silent in its group. You can take it live from the clubs page: ${E2E_BASE_URL}/admin/clubs`,
  );
  expect(notes[0].status).toBe("queued");
  expect(ownerQuietUntil(DAY)).toBeNull();
  expect(notes[0].sendAfter).toBeNull();
  expect(await alerts(db, c.org)).toEqual([
    {
      kind: "club-setup",
      severity: "warning",
      title: "Still setting up after 3 days",
      detail:
        "This club was approved 3 days ago and its organiser has not gone live. MatchTime is still silent in its group. You can take it live from the clubs page.",
      dedupeKey: "setup-stuck-72h",
    },
  ]);

  // Once.
  expect((await cron(request, new Date(DAY.getTime() + 15 * 60_000))).setupStuck).toBeUndefined();
  await cron(request, new Date(DAY.getTime() + 30 * 24 * HOUR));
  expect(await ownerNotes(db, c)).toHaveLength(1);
  expect(await alerts(db, c.org)).toHaveLength(1);
  // Nothing went to the organiser, and nothing to the group.
  expect(await reminders(db, c)).toEqual([]);
  await expectPlayersGroupSilent(request, db, c);
});

test("B: in the owner's quiet hours the note waits for 09:00 London; six runs at once still queue one", async ({ request, db }) => {
  const c = club("Night Owls FC");
  await seedHeld(c, { approvedAt: ago(NIGHT, 73), askedAt: ago(NIGHT, 73), dm: "none" });
  const runs = await Promise.all(Array.from({ length: 6 }, () => cron(request, NIGHT)));
  const notes = await ownerNotes(db, c);
  expect(notes).toHaveLength(1);
  expect(runs.reduce((n, r) => n + (r.setupStuck?.noted ?? 0), 0)).toBe(1);
  expect(ownerQuietUntil(NIGHT)).not.toBeNull();
  expect(notes[0].sendAfter).toEqual(ownerQuietUntil(NIGHT));
  // 09:00 London, said without the shared rule: the hour and the minute of the hold.
  expect(formatLondon(notes[0].sendAfter!, "HH:mm")).toBe("09:00");
  expect(await alerts(db, c.org)).toHaveLength(1);
});

test("B: removed from its group: NO owner DM, one ops event that says so; suspended: nothing at all", async ({ request, db }) => {
  const gone = club("Kicked Out FC");
  const off = club("Turned Off FC");
  await seedHeld(gone, { approvedAt: ago(DAY, 80), askedAt: ago(DAY, 80), dm: "none" });
  await seedHeld(off, { approvedAt: ago(DAY, 80), askedAt: ago(DAY, 80), dm: "none" });
  await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() WHERE id = $1`, [gone.org]);
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'suspended' WHERE id = $1`, [off.org]);
  await cron(request, DAY);
  await cron(request, new Date(DAY.getTime() + HOUR));
  expect(await ownerNotes(db, gone)).toEqual([]);
  expect(await alerts(db, gone.org)).toEqual([
    {
      kind: "club-setup",
      severity: "warning",
      title: "Still setting up after 3 days",
      detail:
        "This club was approved 3 days ago and has not gone live. MatchTime was removed from its group while it was setting up, so it cannot be taken live and you were not messaged about it.",
      dedupeKey: "setup-stuck-72h-removed",
    },
  ]);
  expect(await ownerNotes(db, off)).toEqual([]);
  expect(await alerts(db, off.org)).toEqual([]);
});

// ══ C. THE ADMIN GROUP STEP ═════════════════════════════════════════════

let HELD: Club;
let COMMAND = "";

test("C: the setup DM carries the optional admin group step, and the command follows as a SECOND message with a 7-day code", async ({ request, db }) => {
  HELD = club("Harbour FC");
  await seedPending(HELD);
  const r = await approve(request, HELD, "1");
  expect(r).toMatchObject({ result: "approved", heldOrgId: HELD.org });

  const ask = await waitForJob(db, HELD, "setup-ask");
  const blocks = ask.text.split("\n\n");
  const at = blocks.indexOf(
    "👥 *Admin group (optional):* if your organisers have their own WhatsApp group, add me to it and send my next message there. Admin messages will then go to that group instead of to you.",
  );
  expect(at, ask.text).toBeGreaterThan(0);
  expect(blocks[at - 1]).toMatch(/^⭐ \*Starting ratings:\*/);
  expect(blocks[at + 1]).toMatch(/^When you're happy, reply \*GO\* here/);

  const org = (await orgRow(db, HELD.org))!;
  expect(org.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  // Seven days from the DM's due time.
  expect(org.asked).toEqual(DAY);
  expect(org.codeExpires).toEqual(new Date(DAY.getTime() + 7 * 24 * HOUR));

  const second = await jobs(db, HELD.phone, "setup-admin-code");
  expect(second).toHaveLength(1);
  // Exactly the command: nothing before it, nothing after it.
  expect(second[0].text).toBe(`Match Time admin group ${org.code}`);
  expect(second[0]).toMatchObject({ refId: `${HELD.org}:setup-admin-code`, status: "queued", sendAfter: ask.sendAfter });
  // Its own job, ordered right after the setup DM.
  expect(second[0].createdAt.getTime() - ask.createdAt.getTime()).toBe(1);
  COMMAND = second[0].text;

  // The cron, however often, adds no second setup DM and no second command.
  await cron(request, DAY);
  await cron(request, new Date(DAY.getTime() + HOUR));
  expect(await jobs(db, HELD.phone, "setup-ask")).toHaveLength(1);
  expect(await jobs(db, HELD.phone, "setup-admin-code")).toHaveLength(1);
  await expectPlayersGroupSilent(request, db, HELD);
});

test("C: the Pi is handed the setup DM first and the command second", async ({ request, db }) => {
  // A poll hands out the five oldest jobs: clear what the tests above left queued.
  await db.run(`UPDATE "PlatformJob" SET status = 'sent' WHERE status = 'queued' AND (phone IS NULL OR phone <> $1)`, [HELD.phone]);
  const poll = await (await request.get("/api/whatsapp/platform-jobs", { headers: PI })).json();
  const mine = (poll.jobs as Array<{ id: string; kind: string; phone?: string; purpose?: string; text?: string }>).filter(
    (j) => j.kind === "dm" && j.phone === HELD.phone,
  );
  expect(mine.map((j) => j.purpose)).toEqual(["setup-ask", "setup-admin-code"]);
  expect(mine[1].text).toBe(COMMAND);
  // Both delivered.
  for (const j of mine) {
    const ack = await request.post("/api/whatsapp/platform-jobs", { headers: PI, data: { id: j.id, outcome: "sent", waMessageId: `wa-${j.id}` } });
    expect(ack.status()).toBe(200);
  }
  expect((await jobs(db, HELD.phone, "setup-admin-code"))[0].status).toBe("sent");
});

test("C: the organiser adds MatchTime to the organisers' own group: recorded as a silent candidate, no setup, no word anywhere", async ({ request, db }) => {
  const res = await request.post("/api/whatsapp/bot-added", {
    headers: { ...KEY, "x-mt-test-self-join": "1" },
    data: { groupId: HELD.hq, groupSubject: "Harbour organisers", addedByPhone: HELD.phone, participants: [{ phone: HELD.phone }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ ignored: "admin-group-awaiting-code", silent: true, introText: null });
  expect(await db.one(`SELECT "awaitingAdminLink","leftAt" FROM "UnsolicitedGroup" WHERE "groupId" = $1`, [HELD.hq])).toMatchObject({
    awaitingAdminLink: true,
    leftAt: null,
  });
  expect(await db.all(`SELECT id FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [HELD.hq])).toEqual([]);
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.silentGroups).toContain(HELD.hq);
  await expectPlayersGroupSilent(request, db, HELD);
});

test("C: the command forwarded into the PLAYERS' group by mistake: nothing is posted there; the organiser is told by DM, once", async ({ request, db }) => {
  const out = await link(request, { groupId: HELD.group, text: COMMAND, senderPhone: HELD.phone, botMentioned: false, messageId: "e2e-s7-m1" });
  // What the Pi gets: no reply text, so it posts nothing in the players' group.
  expect(out).toEqual({ ok: true, outcome: "ignored", replyText: null, reason: "club-setting-up" });

  const told = await jobs(db, HELD.phone, "setup-reply");
  expect(told).toHaveLength(1);
  expect(told[0].text).toBe(
    "That is your players' group, so it can't be the admin group. Add me to a separate group for the admins and send the message there.",
  );
  expect(told[0]).toMatchObject({ status: "queued", sendAfter: null });

  // The Pi forwards the same message again: still one DM.
  await link(request, { groupId: HELD.group, text: COMMAND, senderPhone: HELD.phone, botMentioned: false, messageId: "e2e-s7-m1" });
  expect(await jobs(db, HELD.phone, "setup-reply")).toHaveLength(1);

  // A stranger sending it there: silence, and no DM to anyone.
  const stranger = await link(request, { groupId: HELD.group, text: COMMAND, senderPhone: "447700900977", messageId: "e2e-s7-m2" });
  expect(stranger).toEqual({ ok: true, outcome: "ignored", replyText: null, reason: "not-an-admin" });
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE phone = '447700900977'`)).toBe(0);

  // The mistake did not spend the code, link anything, or wake the group.
  expect(await orgRow(db, HELD.org)).toMatchObject({ adminGroupId: null, code: COMMAND.slice(-6) });
  await expectPlayersGroupSilent(request, db, HELD);
});

test("C: the command in the SEPARATE group links it for the setting-up club, and the confirmation is posted THERE", async ({ request, db }) => {
  const out = await link(request, { groupId: HELD.hq, text: COMMAND, senderPhone: HELD.phone, botMentioned: false, messageId: "e2e-s7-m3" });
  expect(out).toMatchObject({ ok: true, outcome: "linked", adminGroup: { groupId: HELD.hq, orgId: HELD.org } });
  // The introduction, for a club not switched on yet: it says so.
  expect(out.replyText).toMatch(/^👋 I'm MatchTime, I'll help run \*Harbour FC\*'s .*Once I'm switched on for the club, this is what I do\./);
  expect(out.replyText).toContain("Once I'm on, type *help* here to see what I take.");
  expect(await orgRow(db, HELD.org)).toMatchObject({
    approvalStatus: "approved",
    setupStage: "setting-up",
    adminGroupId: HELD.hq,
    adminChannelMode: "admin-group",
    code: null,
  });
  expect((await db.one<{ leftAt: Date | null }>(`SELECT "leftAt" FROM "UnsolicitedGroup" WHERE "groupId" = $1`, [HELD.hq]))?.leftAt).not.toBeNull();

  // The Pi: an admin group, no longer silent. The players' group: still silent, still not served.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.adminGroups).toContainEqual({ groupId: HELD.hq, orgId: HELD.org });
  expect(orgs.silentGroups).not.toContain(HELD.hq);
  await expectPlayersGroupSilent(request, db, HELD);
  // No further DM to the organiser about it.
  expect(await jobs(db, HELD.phone, "setup-reply")).toHaveLength(1);

  // Before go-live, a message in the admin group is read by nobody and answered by nobody.
  const chat = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HELD.hq, messageId: "e2e-s7-m4", text: "When do we start?", senderPhone: HELD.phone, timestamp: DAY.toISOString() },
  });
  expect(await chat.json()).toMatchObject({ ok: true, ignored: "no-open-pick", replyText: null });
  await expectPlayersGroupSilent(request, db, HELD);
});

test("C: the organiser says GO: the club goes live and admin messages are still set to go to that group", async ({ request, db }) => {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { ...KEY, "x-mt-test-setup-learning": "0" },
    data: { phone: HELD.phone, body: "GO", waMessageId: "e2e-s7-go", authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ handled: "setup-go", outcome: "went-live" });
  expect(await orgRow(db, HELD.org)).toMatchObject({
    setupStage: "live",
    whatsappBotEnabled: true,
    adminGroupId: HELD.hq,
    adminChannelMode: "admin-group",
  });
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.adminGroups).toContainEqual({ groupId: HELD.hq, orgId: HELD.org });
  expect(orgs.orgs.map((o: { whatsappGroupId: string }) => o.whatsappGroupId)).toContain(HELD.group);
  // Live: no reminder a day later, and no note to the owner three days later.
  await cron(request, new Date(DAY.getTime() + 25 * HOUR));
  await cron(request, new Date(DAY.getTime() + 80 * HOUR));
  expect(await reminders(db, HELD)).toEqual([]);
  expect(await ownerNotes(db, HELD)).toEqual([]);
  // Tidy: take it out of the Pi's served set for the tests below.
  await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false, "approvalStatus" = 'suspended' WHERE id = $1`, [HELD.org]);
});

test("C: a club that already has an admin group: no admin block and no second message", async ({ request, db }) => {
  const c = club("Already Linked FC");
  await seedPending(c);
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [c.org, c.hq]);
  await approve(request, c, "1");
  const ask = await waitForJob(db, c, "setup-ask");
  expect(ask.text).not.toContain("Admin group (optional)");
  expect(ask.text).toContain("reply *GO* here");
  await cron(request, DAY);
  expect(await jobs(db, c.phone, "setup-admin-code")).toEqual([]);
  expect((await orgRow(db, c.org))!.code).toBeNull();
});

test("C: Turkish club: the Turkish block and the Turkish form of the command, which the same route reads", async ({ request, db }) => {
  const c = club("Moda Spor", "tr");
  await seedPending(c);
  await approve(request, c, "1");
  const ask = await waitForJob(db, c, "setup-ask");
  expect(ask.text).toContain(
    "👥 *Yönetici grubu (isteğe bağlı):* organizatörlerinizin kendi WhatsApp grubu varsa beni o gruba ekleyin ve bir sonraki mesajımı orada gönderin. Yönetici mesajları o zaman size değil, o gruba gider.",
  );
  const code = (await orgRow(db, c.org))!.code;
  const second = await jobs(db, c.phone, "setup-admin-code");
  expect(second).toHaveLength(1);
  expect(second[0].text).toBe(`Match Time yönetici grubu ${code}`);

  const mistake = await link(request, { groupId: c.group, text: second[0].text, senderPhone: c.phone, messageId: "e2e-s7-tr1" });
  expect(mistake).toEqual({ ok: true, outcome: "ignored", replyText: null, reason: "club-setting-up" });
  expect((await jobs(db, c.phone, "setup-reply")).map((j) => j.text)).toEqual([
    "Orası oyuncularınızın grubu, bu yüzden yönetici grubu olamaz. Beni yöneticiler için ayrı bir gruba ekleyin ve mesajı orada gönderin.",
  ]);
  const ok = await link(request, { groupId: c.hq, text: second[0].text, senderPhone: c.phone, messageId: "e2e-s7-tr2" });
  expect(ok).toMatchObject({ outcome: "linked" });
  // The introduction in Turkish, for a club not switched on yet.
  expect(ok.replyText).toMatch(/^👋 Ben MatchTime\. \*Moda Spor\* .*Kulüp için açıldığımda burada şunları yaparım\./);
  expect(ok.replyText).toContain("Açıldığımda, neleri kabul ettiğimi görmek için burada *yardım* yazın.");
  await expectPlayersGroupSilent(request, db, c);
});

// ══ D. REMOVED FROM THE GROUP, AND ADDED BACK (the real routes) ═════════

/** MatchTime itself was removed from the group, as the Pi reports it. */
async function botRemoved(request: APIRequestContext, c: Club) {
  const res = await request.post("/api/whatsapp/bot-removed", { headers: KEY, data: { groupId: c.group } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, setup: "removed", orgId: c.org });
  return body;
}
/** The organiser adds MatchTime back to the same group. */
async function botAddedBack(request: APIRequestContext, c: Club, now: Date) {
  const res = await request.post("/api/whatsapp/bot-added", {
    headers: { ...KEY, "x-mt-test-self-join": "1", "x-mt-test-setup-learning": "0", "x-test-now": now.toISOString() },
    data: { groupId: c.group, groupSubject: c.subject, addedByPhone: c.phone, participants: [{ phone: c.phone }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
const removedAt = (db: TestDb, c: Club) =>
  db.one<{ at: Date | null }>(`SELECT "setupRemovedAt" AS at FROM "Organisation" WHERE id = $1`, [c.org]).then((r) => r?.at ?? null);

test("D: a REMOVED club gets no reminder and no owner DM: for the owner an ops event only", async ({ request, db }) => {
  const c = club("Left Out FC");
  await seedHeld(c, { approvedAt: ago(DAY, 80), askedAt: ago(DAY, 79), dm: "sent" });
  await botRemoved(request, c);
  expect(await removedAt(db, c)).not.toBeNull();

  await cron(request, DAY);
  await cron(request, new Date(DAY.getTime() + 30 * 24 * HOUR));
  // Due for both by the clock, and sent neither.
  expect(await reminders(db, c)).toEqual([]);
  expect(await ownerNotes(db, c)).toEqual([]);
  const stuck = (await alerts(db, c.org)).filter((a) => (a.dedupeKey ?? "").startsWith("setup-stuck"));
  expect(stuck).toHaveLength(1);
  expect(stuck[0]).toMatchObject({ dedupeKey: "setup-stuck-72h-removed", title: "Still setting up after 3 days" });
  expect(stuck[0].detail).toContain("was removed from its group");
  await expectPlayersGroupSilent(request, db, c);
});

test("D: removal takes back the queued setup DM AND its admin group command; after the re-add a fresh pair goes, and the reminder runs from the NEW setup DM", async ({ request, db }) => {
  const c = club("Back Again FC");
  await seedPending(c);
  // Approved at night: the setup DM and the command wait for 09:00.
  await approve(request, c, "1", NIGHT);
  const firstAsk = await waitForJob(db, c, "setup-ask");
  expect(firstAsk.sendAfter).toEqual(messageHoursSendAfter(NIGHT));
  const firstCode = (await orgRow(db, c.org))!.code;
  expect((await jobs(db, c.phone, "setup-admin-code")).map((j) => j.text)).toEqual([`Match Time admin group ${firstCode}`]);

  await botRemoved(request, c);
  for (const purpose of ["setup-ask", "setup-admin-code"]) {
    const all = await jobs(db, c.phone, purpose);
    expect(all.map((j) => [j.status, j.failReason]), purpose).toEqual([["failed", "cancelled: removed"]]);
  }
  // The setup DM never went, so the club is "never asked" again.
  expect((await orgRow(db, c.org))!.asked).toBeNull();
  // While removed: nothing is due, however long it takes.
  await cron(request, new Date(DAY.getTime() + 3 * 24 * HOUR));
  expect(await jobs(db, c.phone, "setup-ask")).toHaveLength(1);
  expect(await reminders(db, c)).toEqual([]);

  // Added back four days later, in the daytime.
  const BACK = new Date(DAY.getTime() + 4 * 24 * HOUR);
  await botAddedBack(request, c, BACK);
  expect(await removedAt(db, c)).toBeNull();
  await expect
    .poll(async () => (await jobs(db, c.phone, "setup-ask")).filter((j) => j.status === "queued").length, { timeout: 30_000, intervals: [200, 500, 1000] })
    .toBe(1);
  await cron(request, BACK);
  // One fresh setup DM, and with it one fresh command carrying a NEW code.
  expect((await jobs(db, c.phone, "setup-ask")).map((j) => j.status)).toEqual(["failed", "queued"]);
  const codes = await jobs(db, c.phone, "setup-admin-code");
  expect(codes.map((j) => j.status)).toEqual(["failed", "queued"]);
  const org = (await orgRow(db, c.org))!;
  expect(org.code).not.toBe(firstCode);
  expect(codes[1].text).toBe(`Match Time admin group ${org.code}`);
  const newAsked = org.asked!;
  expect(newAsked.getTime()).toBeGreaterThanOrEqual(BACK.getTime());
  // The new code's 7 days run from the NEW setup DM.
  expect(org.codeExpires).toEqual(new Date(newAsked.getTime() + 7 * 24 * HOUR));

  // The reminder: not 24 hours after the cancelled one (long past), but 24 hours after the new one.
  await db.run(`UPDATE "PlatformJob" SET status = 'sent' WHERE phone = $1 AND purpose IN ('setup-ask','setup-admin-code') AND status = 'queued'`, [c.phone]);
  await cron(request, new Date(newAsked.getTime() + 23 * HOUR));
  expect(await reminders(db, c)).toEqual([]);
  await cron(request, new Date(newAsked.getTime() + 24 * HOUR));
  await cron(request, new Date(newAsked.getTime() + 30 * 24 * HOUR));
  expect(await reminders(db, c)).toHaveLength(1);
  await expectPlayersGroupSilent(request, db, c);
});

test("D: removal takes back a QUEUED reminder, and does NOT make a club whose setup DM had gone 'never asked' (no second setup DM after the re-add)", async ({ request, db }) => {
  const c = club("Night Leavers FC");
  const asked = ago(NIGHT, 24, 10 * 60_000);
  await seedHeld(c, { approvedAt: ago(NIGHT, 25), askedAt: asked, dm: "sent" });
  await cron(request, NIGHT);
  const queued = await reminders(db, c);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ status: "queued", sendAfter: messageHoursSendAfter(NIGHT) });

  await botRemoved(request, c);
  expect((await reminders(db, c)).map((j) => [j.status, j.failReason])).toEqual([["failed", "cancelled: removed"]]);
  // The setup DM itself went yesterday: its stamp is KEPT.
  expect((await orgRow(db, c.org))!.asked).toEqual(asked);

  const BACK = new Date(DAY.getTime() + 2 * 24 * HOUR);
  await botAddedBack(request, c, BACK);
  expect(await removedAt(db, c)).toBeNull();
  await cron(request, BACK);
  await cron(request, new Date(BACK.getTime() + 30 * 24 * HOUR));
  // Still the one setup DM they were sent, no command out of nowhere, and no second reminder.
  expect((await jobs(db, c.phone, "setup-ask")).map((j) => j.status)).toEqual(["sent"]);
  expect(await jobs(db, c.phone, "setup-admin-code")).toEqual([]);
  expect((await reminders(db, c)).map((j) => j.status)).toEqual(["failed"]);
  expect((await orgRow(db, c.org))!.asked).toEqual(asked);
});

test("D: a club removed AFTER its reminder was sent is not reminded a second time after the re-add", async ({ request, db }) => {
  const c = club("Reminded Once FC");
  await seedHeld(c, { approvedAt: ago(DAY, 27), askedAt: ago(DAY, 26), dm: "sent" });
  await cron(request, DAY);
  expect(await reminders(db, c)).toHaveLength(1);
  await db.run(`UPDATE "PlatformJob" SET status = 'sent' WHERE phone = $1 AND purpose = 'setup-reminder'`, [c.phone]);

  await botRemoved(request, c);
  const BACK = new Date(DAY.getTime() + 24 * HOUR);
  await botAddedBack(request, c, BACK);
  expect(await removedAt(db, c)).toBeNull();
  for (const hours of [0, 24, 48, 30 * 24]) await cron(request, new Date(BACK.getTime() + hours * HOUR));
  expect((await reminders(db, c)).map((j) => j.status)).toEqual(["sent"]);
  expect((await jobs(db, c.phone, "setup-ask")).map((j) => j.status)).toEqual(["sent"]);
});

// ══ FLAG OFF ════════════════════════════════════════════════════════════

test("FLAG OFF: an approval that does not hold the club never produces a reminder, an owner's note or an admin group command", async ({ request, db }) => {
  const c = club("Today FC");
  await seedPending(c);
  const r = await approve(request, c, "0");
  expect(r).toEqual({ ok: true, handled: "approver-dm", result: "approved" });
  expect(await orgRow(db, c.org)).toMatchObject({ setupStage: "live", whatsappBotEnabled: true, code: null, asked: null });
  // The "you're live" DM, as today, with no admin group step in it.
  const live = await jobs(db, c.phone, "organiser-decision");
  expect(live).toHaveLength(1);
  expect(live[0].text).not.toContain("Admin group (optional)");

  for (const hours of [1, 25, 73, 24 * 30]) {
    const run = await cron(request, new Date(Date.now() + hours * HOUR));
    expect(run.setupDms).toBeUndefined();
  }
  for (const purpose of ["setup-ask", "setup-admin-code", "setup-reminder"]) {
    expect(await jobs(db, c.phone, purpose), purpose).toEqual([]);
  }
  expect(await ownerNotes(db, c)).toEqual([]);
  expect((await alerts(db, c.org)).filter((a) => (a.dedupeKey ?? "").startsWith("setup-stuck"))).toEqual([]);
  expect((await orgRow(db, c.org))!.code).toBeNull();

  // Its own group still gets L3 for the command, as today (it is live).
  const l3 = await link(request, { groupId: c.group, text: "@Match Time admin group ABCDEF", senderPhone: c.phone, messageId: "e2e-s7-off" });
  expect(l3).toEqual({
    ok: true,
    outcome: "main-group",
    replyText: "This is *Today FC*'s main group, so it can't be the admin group. Add me to a separate group for the admins.",
  });
  expect(await jobs(db, c.phone, "setup-reply")).toEqual([]);
  await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false, "approvalStatus" = 'suspended' WHERE id = $1`, [c.org]);
});

// ══ Through the lib, against Postgres ═══════════════════════════════════
// LAST in this file: it claims every platform job that is due.

test("the follow-ups against Postgres: once under concurrent runs, the cancel, the race with go-live, the whole link path (tsx)", async () => {
  test.setTimeout(240_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/setup-followups-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 230_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`setup-followups-lib-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK: 20 setup follow-up checks");
});
