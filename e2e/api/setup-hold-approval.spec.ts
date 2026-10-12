/**
 * GO-LIVE SLICE S3: APPROVAL HOLDS THE CLUB, AND ONE SETUP DM REPLACES
 * TODAY'S TWO. Against a real Postgres and the real routes (go-live plan
 * 2.1, 2.3, 2.4).
 *
 * With SETUP_HOLD_ENABLED on, the owner's "APPROVE 7KQ2" leaves the club
 * approved and SETTING UP: bot off, group silent, no hello, no "you're
 * live" DM, no free period started. The chat reading runs right after the
 * response (`after()`), and the organiser gets ONE setup DM when it
 * reaches a final status, or at once when the reading is off. The
 * 15-minute cron is the retry. Never two DMs, whoever races whom.
 *
 * With the flag off an approval is exactly today's: that is pinned in
 * full by self-join-decisions.spec.ts and web/admin-clubs.spec.ts (both
 * untouched), and once more here beside the held path.
 *
 * The dev server runs with every flag unset; requests turn them on with
 * the test-only headers (honoured only under MT_TEST_MODE=1). The model is
 * STUBBED through `x-mt-test-setup-learning-stub`. Nothing here calls a
 * model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { messageHoursSendAfter } from "@/lib/message-hours";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const PI = { ...KEY, "x-mt-platform-jobs": "1" };
const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };

// Pinned clocks, on today's date so the sweep's "approved in the last 3
// days" still matches a club approved by the real clock a moment ago.
const today = new Date().toISOString().slice(0, 10);
const DAY = `${today}T11:00:00.000Z`; // 12:00 London in summer, 11:00 in winter: inside 09:00 to 23:00
const NIGHT = `${today}T23:30:00.000Z`; // 00:30 or 23:30 London: outside it

const rolling = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
) as { history: unknown[] };

const QUIET = {
  open_places: { answer: "unclear", confidence: "low", evidence: [] },
  drop_out_deadline: { day: "none", time: "none", confidence: "low", evidence: [] },
  list_published: { day: "none", time: "none", confidence: "low", evidence: [] },
  payments: { answer: "no_sign", confidence: "low", evidence: [] },
  monthly_list: {
    answer: "no_sign",
    prepay_for_month: false,
    pay_as_you_go_fill_ins: false,
    credit_for_missed_games: false,
    confidence: "low",
    evidence: [],
  },
  weekly_game: { day: "none", time: "none", venue: "", players_per_side: 0, confidence: "low", evidence: [] },
};
/** Switches rolling squad on: two quotes from two messages. */
const ROLLING_ANSWER = {
  regular_game: true,
  squad: {
    answer: "rolling",
    confidence: "high",
    evidence: ["Same lot as last week, let me know if you can't do Tuesday", "Usual crew this week too, only message if you're dropping out"],
  },
  ...QUIET,
};
/** A game group, read, and nothing to change. */
const NOTHING_ANSWER = { regular_game: true, squad: { answer: "sign_up_each_week", confidence: "low", evidence: [] }, ...QUIET };

interface Club {
  org: string;
  name: string;
  lang: "en" | "tr";
  user: string;
  phone: string;
  code: string;
  group: string;
  subject: string;
}
let seq = 0;
function club(name: string, lang: "en" | "tr" = "en"): Club {
  const i = ++seq;
  return {
    org: `e2e-s3-org-${i}`,
    name,
    lang,
    user: `e2e-s3-user-${i}`,
    phone: `4477009007${String(i).padStart(2, "0")}`,
    code: `S3${String(i).padStart(2, "0")}`,
    group: `1203639100000000${String(i).padStart(2, "0")}@g.us`,
    subject: `${name} group`,
  };
}

/** A club waiting for the owner: pending, its group linked, the add's chat stored. */
async function seedPending(c: Club, opts: { history?: unknown[] | null } = {}) {
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
  const history = opts.history === undefined ? rolling.history : opts.history;
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","groupId","groupSubject",
       "memberCount","addedByPhone","adderMatch",participants,"detectedLang","linkedAt","capturedHistory","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'group_linked',now() - interval '2 hours',now() + interval '1 hour',now() - interval '10 minutes',$4,$6,$7,
       2,$4,'phone',$8::jsonb,$9,now() - interval '5 minutes',$10::jsonb,now())`,
    [
      `${c.org}-cc`,
      c.org,
      c.user,
      c.phone,
      c.code,
      c.group,
      c.subject,
      JSON.stringify([
        { phone: c.phone, pushname: "Ali" },
        { phone: `${c.phone.slice(0, -2)}99`, pushname: "Ben" },
      ]),
      c.lang,
      history === null ? null : JSON.stringify(history),
    ],
  );
}

let wa = 0;
interface Flags {
  hold: "1" | "0";
  learning?: "1" | "0";
  stub?: unknown;
  rawStub?: string;
  now?: string;
}
function flagHeaders(f: Flags): Record<string, string> {
  return {
    "x-mt-test-setup-hold": f.hold,
    ...(f.learning ? { "x-mt-test-setup-learning": f.learning } : {}),
    ...(f.stub !== undefined ? { "x-mt-test-setup-learning-stub": JSON.stringify(f.stub) } : {}),
    ...(f.rawStub !== undefined ? { "x-mt-test-setup-learning-stub": f.rawStub } : {}),
    "x-test-now": f.now ?? DAY,
  };
}

/** The owner's "APPROVE <ref>" by WhatsApp, the way the Pi forwards it. */
async function approve(request: APIRequestContext, c: Club, f: Flags) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { ...KEY, "x-mt-test-self-join": "1", ...flagHeaders(f) },
    data: { phone: E2E.APPROVER_PHONE, body: `APPROVE ${c.code}`, waMessageId: `e2e-s3-wa-${++wa}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** The 15-minute cron. */
async function cron(request: APIRequestContext, f: Omit<Flags, "hold">) {
  const res = await request.get("/api/cron/learn-setup", { headers: { ...CRON, ...flagHeaders({ hold: "0", ...f }) } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ considered: number; setupDms?: { considered: number; sent: number } }>;
}

const orgRow = (db: TestDb, id: string) =>
  db.one<{
    approvalStatus: string;
    setupStage: string;
    whatsappBotEnabled: boolean;
    whatsappGroupId: string | null;
    billingStatus: string;
    rollingSquadEnabled: boolean;
    asked: Date | null;
    liveAt: Date | null;
  }>(
    `SELECT "approvalStatus","setupStage","whatsappBotEnabled","whatsappGroupId","billingStatus","rollingSquadEnabled",
            "setupAskedAt" AT TIME ZONE 'UTC' AS asked, "liveAt"
       FROM "Organisation" WHERE id = $1`,
    [id],
  );
const jobs = (db: TestDb, phone: string, purpose: string) =>
  db.all<{ text: string; refId: string; sendAfter: Date | null; status: string }>(
    `SELECT text, "refId", "sendAfter" AT TIME ZONE 'UTC' AS "sendAfter", status FROM "PlatformJob"
      WHERE phone = $1 AND purpose = $2 ORDER BY "createdAt"`,
    [phone, purpose],
  );
const setupDms = (db: TestDb, c: Club) => jobs(db, c.phone, "setup-ask");
const reading = (db: TestDb, id: string) =>
  db.one<{ status: string; reason: string | null; attempts: number }>(
    `SELECT status, reason, attempts FROM "ClubSetupLearning" WHERE "orgId" = $1`,
    [id],
  );
const storedChat = (db: TestDb, id: string) =>
  db.one<{ h: unknown }>(`SELECT "capturedHistory" AS h FROM "ClubConnect" WHERE "orgId" = $1`, [id]);

/** Wait for the run that follows the approval (`after()`) to queue the DM. */
async function waitForSetupDm(db: TestDb, c: Club) {
  await expect.poll(async () => (await setupDms(db, c)).length, { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(1);
  return (await setupDms(db, c))[0];
}

/** Everything a held approval must leave untouched, and silent. */
async function expectHeldAndSilent(request: APIRequestContext, db: TestDb, c: Club) {
  expect(await orgRow(db, c.org)).toMatchObject({
    approvalStatus: "approved",
    setupStage: "setting-up",
    whatsappBotEnabled: false,
    whatsappGroupId: c.group,
    // The suite runs with BILLING_ENABLED on: the free period has NOT started.
    billingStatus: "exempt",
    liveAt: null,
  });
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1`, [c.org])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBillingMonth" WHERE "orgId" = $1`, [c.org])).toBe(0);
  // No hello, and the scheduler's one-time intro is left for go-live to claim.
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [c.org])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`org-${c.org}:bot-intro`])).toBe(0);
  // Not the "you're live" DM, and never the separate findings DM.
  expect(await jobs(db, c.phone, "organiser-decision")).toEqual([]);
  expect(await jobs(db, c.phone, "setup-learned")).toEqual([]);
  // The roster from the add's snapshot is still imported.
  expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1`, [c.org])).toBe(2);
  // The Pi: the group is silent, not served, and nothing is due in it.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect(orgs.silentGroups).toContain(c.group);
  expect(orgs.orgs.map((o: { whatsappGroupId: string }) => o.whatsappGroupId)).not.toContain(c.group);
  const poll = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(c.group)}`, { headers: PI });
  expect(poll.status()).toBe(404);
}

test.beforeAll(() => {
  resetDb();
});
test.afterAll(() => {
  resetDb();
});

test("FLAG OFF is today's approval: hello queued, bot on, 'you're live' DM, free period started, findings DM separate", async ({ request, db }) => {
  const c = club("Riverside FC");
  await seedPending(c);
  const r = await approve(request, c, { hold: "0", learning: "1", stub: ROLLING_ANSWER });
  expect(r).toEqual({ ok: true, handled: "approver-dm", result: "approved" });

  expect(await orgRow(db, c.org)).toMatchObject({
    approvalStatus: "approved",
    setupStage: "live",
    whatsappBotEnabled: true,
    whatsappGroupId: c.group,
    billingStatus: "trial",
    asked: null,
  });
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1`, [c.org])).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [c.org])).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`org-${c.org}:bot-intro`])).toBe(1);
  const live = await jobs(db, c.phone, "organiser-decision");
  expect(live).toHaveLength(1);
  expect(live[0].text).toMatch(/^Good news: Riverside FC is live\. I've said hello in "Riverside FC group"\./);
  const ack = await jobs(db, E2E.APPROVER_PHONE, "owner-ack");
  expect(ack.at(-1)!.text).toBe("Approved Riverside FC. The hello goes out in the group within a few minutes.");

  // Nothing was scheduled after the approval: the reading waits for the cron, as today.
  expect(await reading(db, c.org)).toBeNull();
  const swept = await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  expect(swept.considered).toBe(1);
  // No club is setting up, so the cron's response has no setup DM report at all.
  expect("setupDms" in swept).toBe(false);
  // The findings DM, separate, exactly as today. No setup DM, ever.
  const findings = await jobs(db, c.phone, "setup-learned");
  expect(findings).toHaveLength(1);
  expect(findings[0].refId).toBe(`${c.org}:setup-learned`);
  expect(findings[0].text).toMatch(/^I read the recent messages in "Riverside FC group" to see how it runs, and set MatchTime up the same way\./);
  expect(findings[0].text).toContain("Everything is on your settings page");
  expect(await setupDms(db, c)).toEqual([]);
});

test("FLAG ON, by WhatsApp: held and silent; the reading runs after the response and ONE setup DM carries its findings", async ({ request, db }) => {
  const c = club("Harbour FC");
  await seedPending(c);
  const r = await approve(request, c, { hold: "1", learning: "1", stub: ROLLING_ANSWER });
  expect(r).toEqual({ ok: true, handled: "approver-dm", result: "approved", heldOrgId: c.org });
  const ack = await jobs(db, E2E.APPROVER_PHONE, "owner-ack");
  expect(ack.at(-1)!.text).toBe(
    "Approved Harbour FC. Its organiser is being asked to confirm the setup, and MatchTime stays silent in the group until they reply GO.",
  );

  // The reading ran promptly, with no cron: `after()`.
  const dm = await waitForSetupDm(db, c);
  await expectHeldAndSilent(request, db, c);
  expect(await reading(db, c.org)).toMatchObject({ status: "applied" });
  expect((await orgRow(db, c.org))!.rollingSquadEnabled).toBe(true);
  expect((await storedChat(db, c.org))!.h).toBeNull();

  expect(dm.refId).toBe(`${c.org}:setup-ask`);
  expect(dm.status).toBe("queued");
  // Daytime: it goes at once, and the stamp is that moment.
  expect(dm.sendAfter).toBeNull();
  expect((await orgRow(db, c.org))!.asked).toEqual(new Date(DAY));

  const blocks = dm.text.split("\n\n");
  expect(blocks[0]).toBe(
    `Good news: Harbour FC is approved. I'm in "Harbour FC group" and I'm staying quiet there until you tell me to start.`,
  );
  expect(blocks[1]).toBe(`I read the recent messages in "Harbour FC group" to see how it runs, and set MatchTime up the same way.`);
  expect(blocks[2]).toMatch(
    /^✅ \*Rolling squad is on:\*[^\n]*\nFrom messages like: "Same lot as last week, let me know if you can't do Tuesday"\nUndo or change: http\S+$/,
  );
  expect(dm.text).toMatch(/⚙️ \*Check or change how your group runs:\*\nhttp\S+/);
  expect(dm.text).toMatch(/📅 \*Your weekly game:\*[^\n]*\nhttp\S+/);
  expect(dm.text).toMatch(/⭐ \*Starting ratings:\*[^\n]*\nhttp\S+/);
  expect(dm.text).toMatch(
    /When you're happy, reply \*GO\* here and I'll introduce myself in the group, or press \*Go live\* on your settings page:\nhttp\S+\nUntil then I say nothing in the group\./,
  );
  expect(blocks.at(-1)).toBe("Your first two months are free. The free period starts when I go live in the group.");
  // Rolling squad is on, so "standard setup" would be false; and the findings DM's own closing line is not repeated.
  expect(dm.text).not.toMatch(/standard setup/i);
  expect(dm.text).not.toContain("Everything is on your settings page");
  expect(dm.text).not.toMatch(/[—–]/);

  // The cron afterwards, twice: never a second DM, never the findings DM.
  await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  expect(await setupDms(db, c)).toHaveLength(1);
  expect(await jobs(db, c.phone, "setup-learned")).toEqual([]);
});

test("FLAG ON: the reading found nothing: the DM says so and explains the standard setup", async ({ request, db }) => {
  const c = club("Mill Lane FC");
  await seedPending(c);
  await approve(request, c, { hold: "1", learning: "1", stub: NOTHING_ANSWER });
  const dm = await waitForSetupDm(db, c);
  await expectHeldAndSilent(request, db, c);
  expect(await reading(db, c.org)).toMatchObject({ status: "nothing" });
  const blocks = dm.text.split("\n\n");
  expect(blocks[1]).toBe(
    `I read the recent messages in "Mill Lane FC group" and found nothing that needs a setting changed, so MatchTime is on its standard setup.`,
  );
  expect(blocks[2]).toBe("Standard setup: players say In or Out each week, and a free place goes to the first person on the bench.");
  expect(blocks[3]).toMatch(/^⚙️ /);
});

test("FLAG ON, Turkish, no chat stored (skipped): the DM is Turkish and says the chat could not be read", async ({ request, db }) => {
  const c = club("Kartallar", "tr");
  await seedPending(c, { history: null });
  await approve(request, c, { hold: "1", learning: "1", stub: ROLLING_ANSWER });
  const dm = await waitForSetupDm(db, c);
  await expectHeldAndSilent(request, db, c);
  expect(await reading(db, c.org)).toMatchObject({ status: "skipped", reason: "no-history" });
  const blocks = dm.text.split("\n\n");
  expect(blocks[0]).toBe(
    `Güzel haber: Kartallar onaylandı. "Kartallar group" grubundayım ve siz başlamamı söyleyene kadar orada sessiz kalacağım.`,
  );
  expect(blocks[1]).toBe("Grubunuzun son mesajlarını okuyamadım, bu yüzden MatchTime standart düzeninde.");
  expect(blocks[2]).toBe("Standart düzen: oyuncular her hafta VARIM ya da YOKUM der, boşalan yer yedek listesindeki ilk kişiye verilir.");
  expect(dm.text).toContain("buraya *GO* yazın");
  expect(blocks.at(-1)).toBe("İlk iki ayınız ücretsiz. Ücretsiz dönem, grupta yayına geçtiğimde başlar.");
});

test("FLAG ON, Turkish, the reading applied a setting: the findings are in Turkish", async ({ request, db }) => {
  const c = club("Aslanlar", "tr");
  await seedPending(c);
  await approve(request, c, { hold: "1", learning: "1", stub: ROLLING_ANSWER });
  const dm = await waitForSetupDm(db, c);
  expect(await reading(db, c.org)).toMatchObject({ status: "applied" });
  expect(dm.text).toMatch(/^Güzel haber: Aslanlar onaylandı\./);
  expect(dm.text).toContain("MatchTime'ı aynı şekilde kurdum.");
  expect(dm.text).toContain("✅ *Kadro devam ediyor:*");
  expect(dm.text).toMatch(/Geri almak ya da değiştirmek için: http\S+/);
  expect(dm.text).not.toMatch(/Standart düzen/);
});

test("FLAG ON: the reading fails every time: no DM while it is retried, then the DM, once, saying it could not be read", async ({ request, db }) => {
  const c = club("Quarry FC");
  await seedPending(c);
  // The model "answers" with something that is not JSON, every time.
  const broken = { learning: "1" as const, rawStub: "sorry, I cannot help with that" };
  await approve(request, c, { hold: "1", ...broken });

  // Attempt 1 ran after the response and was deferred: nothing is sent yet.
  await expect.poll(async () => (await reading(db, c.org))?.status, { timeout: 30_000 }).toBe("deferred");
  expect(await setupDms(db, c)).toEqual([]);
  expect((await orgRow(db, c.org))!.asked).toBeNull();

  // The cron retries. Attempt 2: deferred again, still no DM.
  await cron(request, broken);
  expect(await reading(db, c.org)).toMatchObject({ status: "deferred", attempts: 2 });
  expect(await setupDms(db, c)).toEqual([]);

  // Attempt 3 is the last: failed, and the DM goes in the same run.
  const last = await cron(request, broken);
  expect(await reading(db, c.org)).toMatchObject({ status: "failed", attempts: 3 });
  expect(last.setupDms).toEqual({ considered: 1, sent: 1 });
  const sent = await setupDms(db, c);
  expect(sent).toHaveLength(1);
  expect(sent[0].text.split("\n\n")[1]).toBe("I couldn't read your group's recent messages, so MatchTime is on its standard setup.");
  await expectHeldAndSilent(request, db, c);

  await cron(request, broken);
  expect(await setupDms(db, c)).toHaveLength(1);
});

test("FLAG ON, the reading OFF, at night: the DM is queued at once for 09:00 London, and the reading is closed for good", async ({ request, db }) => {
  const c = club("Night Owls FC");
  await seedPending(c);
  await approve(request, c, { hold: "1", learning: "0", now: NIGHT });
  const dm = await waitForSetupDm(db, c);
  await expectHeldAndSilent(request, db, c);

  const nine = messageHoursSendAfter(new Date(NIGHT));
  expect(nine).not.toBeNull();
  expect(dm.sendAfter).toEqual(nine);
  expect((await orgRow(db, c.org))!.asked).toEqual(nine);
  // The platform channel does not hand it to the Pi before then.
  const due = await (await request.get("/api/whatsapp/platform-jobs", { headers: PI })).json();
  expect(JSON.stringify(due)).not.toContain("Night Owls FC is approved");

  // No reading sentence: nothing was read.
  const blocks = dm.text.split("\n\n");
  expect(blocks[0]).toMatch(/^Good news: Night Owls FC is approved\./);
  expect(blocks[1]).toMatch(/^Standard setup: /);
  expect(dm.text).not.toContain("I read the recent messages");
  expect(dm.text).not.toContain("couldn't read");

  // The reading can never run behind that DM: closed, and the stored chat deleted.
  expect(await reading(db, c.org)).toMatchObject({ status: "skipped", reason: "reading-off" });
  expect((await storedChat(db, c.org))!.h).toBeNull();
  const later = await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  expect(later.considered).toBe(0);
  expect((await orgRow(db, c.org))!.rollingSquadEnabled).toBe(false);
  expect(await setupDms(db, c)).toHaveLength(1);
});

test("NEVER TWICE: six cron runs at the same moment for one due club queue exactly one DM", async ({ request, db }) => {
  const c = club("Racers FC");
  await seedPending(c);
  // Held by hand, its reading already final: every run finds it due.
  await db.run(
    `UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now(), "setupStage" = 'setting-up', "whatsappGroupId" = $2 WHERE id = $1`,
    [c.org, c.group],
  );
  await db.run(`UPDATE "ClubConnect" SET status = 'closed', "capturedHistory" = NULL WHERE "orgId" = $1`, [c.org]);
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,applied,suggestions,noted,"updatedAt") VALUES ($1,$2,'nothing','[]','[]','[]',now())`,
    [`${c.org}-csl`, c.org],
  );

  const runs = await Promise.all(Array.from({ length: 6 }, () => cron(request, { learning: "1", stub: NOTHING_ANSWER })));
  expect(await setupDms(db, c)).toHaveLength(1);
  // Exactly one run reports having sent it.
  expect(runs.reduce((n, r) => n + (r.setupDms?.sent ?? 0), 0)).toBe(1);
  expect((await orgRow(db, c.org))!.asked).toEqual(new Date(DAY));
});

test("NEVER TWICE: the run that follows an approval racing four cron runs queues exactly one DM", async ({ request, db }) => {
  const c = club("Sprinters FC");
  await seedPending(c);
  // The reading is off, so the `after()` run and every cron all want to send at once.
  const [approved] = await Promise.all([
    approve(request, c, { hold: "1", learning: "0" }),
    ...Array.from({ length: 4 }, async () => {
      // Each cron keeps trying until the approval has landed.
      for (let i = 0; i < 20; i++) {
        const r = await cron(request, { learning: "0" });
        if (r.setupDms) return r;
      }
      return null;
    }),
  ]);
  expect(approved).toMatchObject({ result: "approved", heldOrgId: c.org });
  await waitForSetupDm(db, c);
  // Give any straggler time to land, then count again.
  await cron(request, { learning: "0" });
  expect(await setupDms(db, c)).toHaveLength(1);
  await expectHeldAndSilent(request, db, c);
});

test("a held club the owner then turns off, or one MatchTime was removed from, is not sent the setup DM", async ({ request, db }) => {
  const off = club("Switched Off FC");
  const gone = club("Removed FC");
  for (const c of [off, gone]) {
    await seedPending(c);
    await db.run(
      `UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now(), "setupStage" = 'setting-up', "whatsappGroupId" = $2 WHERE id = $1`,
      [c.org, c.group],
    );
    await db.run(`UPDATE "ClubConnect" SET status = 'closed' WHERE "orgId" = $1`, [c.org]);
  }
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'suspended' WHERE id = $1`, [off.org]);
  await db.run(`UPDATE "Organisation" SET "setupRemovedAt" = now() WHERE id = $1`, [gone.org]);
  await cron(request, { learning: "0" });
  expect(await setupDms(db, off)).toEqual([]);
  expect(await setupDms(db, gone)).toEqual([]);
});
