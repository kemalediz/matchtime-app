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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { messageHoursSendAfter } from "@/lib/message-hours";

const execFileAsync = promisify(execFile);

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

/** What main posts in the group at an approval today (`sj_group_hello`, English, organiser "Ali"). */
const FLAG_OFF_HELLO = [
  "👋 Hi everyone, I'm *MatchTime*. Ali has set me up to run this group's games. Here's what I do, right here in WhatsApp:\n",
  "\n",
  "✅ *Who's in:* just say *In* or *Out*. I keep the list and tick your message.\n",
  "🪑 *The bench:* once we're full, anyone who says *In* late goes on the bench, and the bench gets first dibs if someone drops.\n",
  "⏰ *Remind me:* say *\"@Match Time remind me Thursday\"* and I'll DM you then.\n",
  "⚖️ *Fair teams:* tag me and I pick balanced teams from player ratings.\n",
  "⭐ *Man of the Match and ratings* after every game.\n",
  "📊 *Stats:* ask me anything, and everyone gets their own stats page.\n",
  "💷 *Match fees:* your organiser can switch on card or bank pay links.\n",
  "\n",
  "I stay quiet during the banter and only reply to In, Out or a tag. Anything else, tag me: *@Match Time help*",
].join("");
/** What main DMs the organiser today (`sj_dm_approved` with the club fee tip: the suite runs with billing on). */
const FLAG_OFF_ORGANISER_DM = [
  "Good news: Riverside FC is live. I've said hello in \"Riverside FC group\".\n",
  "\n",
  "A few things to set up when you have a minute:\n",
  "\n",
  "📅 *Your weekly game:* check the day, time and venue, or change them:\n",
  "<link>\n",
  "\n",
  "⭐ *Starting ratings:* give each player a rough score out of 10 so the first teams are fair:\n",
  "<link>\n",
  "\n",
  "⚙️ *Settings:* switch on payments, rolling squad, weekly deadlines, admin messages, organiser picks and badge announcements:\n",
  "<link>\n",
  "\n",
  "❓ *Help any time:* message me here, for example *help payments* or *help badges*.\n",
  "\n",
  "Your first two months are free.\n",
  "\n",
  "💷 *Club fee tip:* after that MatchTime only charges for the games you play, up to £9.99 a month for the group, paid by card by whoever collects the match fees. Each game played costs at most £2.50, about *25p a player per game* with 10 players, so a £8 game could be charged at *£8.25*.",
].join("");

const alerts = (db: TestDb, orgId: string) =>
  db.all<{ kind: string; severity: string; title: string; detail: string; dedupeKey: string | null }>(
    `SELECT kind, severity, title, detail, "dedupeKey" FROM "OpsAlert" WHERE "orgId" = $1 ORDER BY "firstSeenAt"`,
    [orgId],
  );

/** A club held by hand: approved `approvedAgo` ago, setting up, its connect request closed. */
async function seedHeld(c: Club, approvedAgo: string, opts: { history?: unknown[] | null } = {}) {
  await seedPending(c, opts);
  const db = testDb();
  await db.run(
    `UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now() - $3::interval, "setupStage" = 'setting-up', "whatsappGroupId" = $2 WHERE id = $1`,
    [c.org, c.group, approvedAgo],
  );
  await db.run(`UPDATE "ClubConnect" SET status = 'closed' WHERE "orgId" = $1`, [c.org]);
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

  // PR #235 review fix 8: the COMPLETE set of what the approval wrote,
  // pinned. These are the values main produces today for this club (the
  // texts come from `sj_group_hello`, `sj_dm_approved` and
  // `sj_dm_approved_tip`, none of which this slice touches); links are
  // replaced by <link> because each one is minted.
  const unlink = (s: string) => s.replace(/https?:\/\/\S+/g, "<link>");
  const botJobs = await db.all<{ kind: string; phone: string | null; text: string; sendAfter: Date | null; sentAt: Date | null }>(
    `SELECT kind, phone, text, "sendAfter", "sentAt" FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt"`,
    [c.org],
  );
  expect(botJobs).toEqual([{ kind: "group", phone: null, sendAfter: null, sentAt: null, text: FLAG_OFF_HELLO }]);
  const platformJobs = await db.all<{ kind: string; purpose: string; phone: string; refId: string; text: string; sendAfter: Date | null; status: string }>(
    `SELECT kind, purpose, phone, "refId", text, "sendAfter", status FROM "PlatformJob" ORDER BY "createdAt", purpose`,
  );
  expect(platformJobs.map((j) => ({ ...j, text: unlink(j.text) }))).toEqual([
    {
      kind: "dm",
      purpose: "organiser-decision",
      phone: c.phone,
      refId: `${c.org}-cc:approved`,
      sendAfter: null,
      status: "queued",
      text: FLAG_OFF_ORGANISER_DM,
    },
    {
      kind: "dm",
      purpose: "owner-ack",
      phone: E2E.APPROVER_PHONE,
      refId: `dm:e2e-s3-wa-${wa}`,
      sendAfter: null,
      status: "queued",
      text: "Approved Riverside FC. The hello goes out in the group within a few minutes.",
    },
  ]);
  expect(
    await db.one(
      `SELECT "approvalStatus","setupStage","whatsappBotEnabled","whatsappGroupId","approvalDecidedBy","billingStatus","billingPlan",
              "setupAskedAt","setupRemovedAt","liveAt","liveBy",("approvedAt" IS NOT NULL) AS "approvedAtSet",
              ("approvedAt" = "approvalDecidedAt") AS "approvedWhenDecided"
         FROM "Organisation" WHERE id = $1`,
      [c.org],
    ),
  ).toEqual({
    approvalStatus: "approved",
    setupStage: "live",
    whatsappBotEnabled: true,
    whatsappGroupId: c.group,
    approvalDecidedBy: `whatsapp:${E2E.APPROVER_PHONE}`,
    billingStatus: "trial",
    billingPlan: "standard",
    setupAskedAt: null,
    setupRemovedAt: null,
    liveAt: null,
    liveBy: null,
    approvedAtSet: true,
    approvedWhenDecided: true,
  });
  expect(await db.count(`SELECT COUNT(*) FROM "OpsAlert" WHERE "orgId" = $1`, [c.org])).toBe(0);

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

  // THE READING FOR A CLUB THAT WAS NEVER HELD (the path every new club
  // takes today) gives exactly what it gave before the reading learned to
  // refuse a closed row (PR #235): the setting switched, the row recorded
  // as applied with what was read and what it cost, the chat deleted, and
  // the same findings DM, word for word.
  expect((await orgRow(db, c.org))!.rollingSquadEnabled).toBe(true);
  expect(
    await db.one(
      `SELECT status, reason, attempts, applied, suggestions, noted, kept, "messageCount", "costUsd", model IS NOT NULL AS "hasModel",
              ("dmQueuedAt" IS NOT NULL) AS "dmQueued"
         FROM "ClubSetupLearning" WHERE "orgId" = $1`,
      [c.org],
    ),
  ).toEqual({
    status: "applied",
    reason: null,
    attempts: 1,
    applied: [
      {
        key: "rollingSquad",
        from: false,
        to: true,
        evidence: ["Same lot as last week, let me know if you can't do Tuesday", "Usual crew this week too, only message if you're dropping out"],
        undoneAt: null,
      },
    ],
    suggestions: [],
    noted: [],
    kept: [],
    messageCount: rolling.history.length,
    costUsd: 0.0145,
    hasModel: true,
    dmQueued: true,
  });
  expect((await storedChat(db, c.org))!.h).toBeNull();
  expect(unlink(findings[0].text)).toBe(
    [
      `I read the recent messages in "Riverside FC group" to see how it runs, and set MatchTime up the same way.\n\n`,
      `✅ *Rolling squad is on:* whoever played last time is in next time, unless they say OUT.\n`,
      `From messages like: "Same lot as last week, let me know if you can't do Tuesday"\n`,
      `Undo or change: <link>\n\n`,
      `Everything is on your settings page, with the chat messages behind each one: <link>`,
    ].join(""),
  );
  expect(findings[0].sendAfter).toBeNull();
});

test("FLAG ON, by WhatsApp: held and silent; the reading runs after the response and ONE setup DM carries its findings", async ({ request, db }) => {
  const c = club("Harbour FC");
  await seedPending(c);
  const r = await approve(request, c, { hold: "1", learning: "1", stub: ROLLING_ANSWER });
  expect(r).toEqual({ ok: true, handled: "approver-dm", result: "approved", heldOrgId: c.org });
  const ack = await jobs(db, E2E.APPROVER_PHONE, "owner-ack");
  expect(ack.at(-1)!.text).toBe(
    "Approved Harbour FC. It stays silent in its group: its organiser is sent the setup message and goes live by replying GO. Any problem shows on the health page.",
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
  // The Turkish DM asks for BAŞLA and names the button "Yayına al" (as the go-live PR does).
  expect(dm.text).toContain("buraya *BAŞLA* yazın");
  expect(dm.text).toContain("*Yayına al* düğmesine basın");
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
  // Tidy: the removed club is still readable by the reading sweep; give it
  // a finished reading so the tests below see no club left to read.
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,applied,suggestions,noted,"updatedAt") VALUES ($1,$2,'nothing','[]','[]','[]',now())
     ON CONFLICT ("orgId") DO UPDATE SET status = 'nothing'`,
    [`${gone.org}-csl`, gone.org],
  );
});

// ── PR #235 review fix 1: the 2-hour cap ────────────────────────────────

test("THE CAP: a reading stuck 'running' with its attempts used up is closed two hours after approval, and the DM goes", async ({ request, db }) => {
  const stuck = club("Stuck FC");
  const fresh = club("Fresh FC");
  // Approved 3 hours ago / 1 hour 50 ago by the pinned clock. Both readings
  // died on their last attempt: nothing may ever retake them.
  await seedHeld(stuck, "3 hours");
  await seedHeld(fresh, "110 minutes");
  for (const c of [stuck, fresh]) {
    await db.run(`UPDATE "Organisation" SET "approvedAt" = $2::timestamptz AT TIME ZONE 'UTC' - $3::interval WHERE id = $1`, [
      c.org,
      DAY,
      c === stuck ? "3 hours" : "110 minutes",
    ]);
    await db.run(
      `INSERT INTO "ClubSetupLearning" (id,"orgId",status,attempts,"updatedAt") VALUES ($1,$2,'running',3,now())`,
      [`${c.org}-csl`, c.org],
    );
  }

  const r = await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  // The reading sweep cannot take either (attempts used up) ...
  expect(r.considered).toBe(0);
  // ... and the cap takes only the one past two hours.
  expect(r.setupDms).toEqual({ considered: 1, sent: 1 });

  expect(await reading(db, stuck.org)).toMatchObject({ status: "skipped", reason: "timed-out" });
  expect((await storedChat(db, stuck.org))!.h).toBeNull();
  const [dm] = await setupDms(db, stuck);
  expect(dm.text.split("\n\n")[1]).toBe("I couldn't read your group's recent messages, so MatchTime is on its standard setup.");
  // Still held and silent: the cap sends a DM, it does not make the club live.
  expect(await orgRow(db, stuck.org)).toMatchObject({
    setupStage: "setting-up",
    whatsappBotEnabled: false,
    rollingSquadEnabled: false,
    asked: new Date(DAY),
  });
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [stuck.org])).toBe(0);

  // At 1 hour 50 the other club is still waited for: untouched.
  expect(await reading(db, fresh.org)).toMatchObject({ status: "running", attempts: 3 });
  expect((await storedChat(db, fresh.org))!.h).not.toBeNull();
  expect(await setupDms(db, fresh)).toEqual([]);

  // Closed for good: no later sweep reads it, whatever the model would say.
  const later = await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  expect(later.considered).toBe(0);
  expect((await orgRow(db, stuck.org))!.rollingSquadEnabled).toBe(false);
  expect(await setupDms(db, stuck)).toHaveLength(1);
  // Tidy: let the fresh club's DM go so later tests see no club due.
  await db.run(`UPDATE "Organisation" SET "setupAskedAt" = now() WHERE id = $1`, [fresh.org]);
});

test("THE CAP: 'deferred' and approved four days ago (outside the reading sweep's window) is not stranded either", async ({ request, db }) => {
  const c = club("Long Wait FC");
  await seedHeld(c, "4 days");
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,reason,attempts,"updatedAt") VALUES ($1,$2,'deferred','ai-cap',2,now() - interval '4 days')`,
    [`${c.org}-csl`, c.org],
  );
  const r = await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  // Past the 3-day window, so the reading sweep never selects it again.
  expect(r.considered).toBe(0);
  expect(r.setupDms).toEqual({ considered: 1, sent: 1 });
  expect(await reading(db, c.org)).toMatchObject({ status: "skipped", reason: "timed-out" });
  const [dm] = await setupDms(db, c);
  expect(dm.text).toContain("I couldn't read your group's recent messages");
  expect((await orgRow(db, c.org))!.rollingSquadEnabled).toBe(false);
});

test("THE CAP does not touch a reading that finished: approved three hours ago, read at 1h59, reported as read", async ({ request, db }) => {
  const c = club("On Time FC");
  await seedHeld(c, "3 hours", { history: null });
  await db.run(`UPDATE "Organisation" SET "rollingSquadEnabled" = true WHERE id = $1`, [c.org]);
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,applied,suggestions,noted,"updatedAt")
     VALUES ($1,$2,'applied',$3::jsonb,'[]','[]',now() - interval '61 minutes')`,
    [`${c.org}-csl`, c.org, JSON.stringify([{ key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] }])],
  );
  await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  expect(await reading(db, c.org)).toMatchObject({ status: "applied" });
  const [dm] = await setupDms(db, c);
  expect(dm.text).toContain("✅ *Rolling squad is on:*");
  expect(dm.text).not.toContain("couldn't read");
});

// ── PR #235 review fix 4: the DM states what is true NOW ─────────────────

test("a setting the organiser undid, and one they changed by hand, are not reported as on; 'standard setup' needs every default", async ({ request, db }) => {
  const c = club("Changed Mind FC");
  await seedHeld(c, "10 minutes", { history: null });
  // The reading switched rolling squad and payment tracking on. The
  // organiser has since undone rolling squad from the settings page, and
  // set a drop-out deadline by hand.
  await db.run(
    `UPDATE "Organisation" SET "rollingSquadEnabled" = false, "paymentTrackingEnabled" = true, "dropOutDeadlineDay" = 1, "dropOutDeadlineTime" = '21:00' WHERE id = $1`,
    [c.org],
  );
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,applied,suggestions,noted,"updatedAt") VALUES ($1,$2,'applied',$3::jsonb,'[]','[]',now())`,
    [
      `${c.org}-csl`,
      c.org,
      JSON.stringify([
        { key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"], undoneAt: new Date().toISOString() },
        { key: "paymentTracking", from: false, to: true, evidence: ["sent £6"] },
      ]),
    ],
  );
  await cron(request, { learning: "1", stub: ROLLING_ANSWER });
  const [dm] = await setupDms(db, c);
  expect(dm.text).not.toContain("Rolling squad is on");
  expect(dm.text).toContain("✅ *Payment tracking is on:*");
  expect(dm.text).not.toMatch(/standard setup/i);

  // Nothing found, but the organiser set a list day: never "standard setup".
  const d = club("List Day FC");
  await seedHeld(d, "10 minutes", { history: null });
  await db.run(`UPDATE "Organisation" SET "listPublishDay" = 2, "listPublishTime" = '20:00' WHERE id = $1`, [d.org]);
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id,"orgId",status,applied,suggestions,noted,"updatedAt") VALUES ($1,$2,'nothing','[]','[]','[]',now())`,
    [`${d.org}-csl`, d.org],
  );
  await cron(request, { learning: "1", stub: NOTHING_ANSWER });
  const [dm2] = await setupDms(db, d);
  expect(dm2.text).toContain("found nothing that needs a setting changed, so I changed nothing.");
  expect(dm2.text).not.toMatch(/standard setup/i);
});

// ── PR #235 review fix 2: what cannot be sent is shown to the owner, once ──

test("the organiser's number is not a MatchTime user's any more: no DM, stamped, ONE ops event, not retried", async ({ request, db }) => {
  const c = club("Lost Number FC");
  await seedHeld(c, "10 minutes", { history: null });
  // The organiser changed their number after connecting.
  await db.run(`UPDATE "User" SET "phoneNumber" = '+447700900599' WHERE id = $1`, [c.user]);
  const first = await cron(request, { learning: "0" });
  expect(first.setupDms).toEqual({ considered: 1, sent: 0 });
  expect(await setupDms(db, c)).toEqual([]);
  expect((await orgRow(db, c.org))!.asked).toEqual(new Date(DAY));
  const seen = await alerts(db, c.org);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "club-setup", severity: "warning", title: "Setup message not sent", dedupeKey: "setup-ask-not-sent" });
  expect(seen[0].detail).toContain("(number-not-known)");
  // Ids and codes only: no number, no name.
  expect(seen[0].detail).not.toMatch(/4477|Lost Number/);

  // Not retried: the club is no longer due, and no second event is recorded.
  const second = await cron(request, { learning: "0" });
  expect(second.setupDms).toBeUndefined();
  expect(await alerts(db, c.org)).toHaveLength(1);
});

test("a held club with no organiser on record: stamped, ONE ops event, and it stops taking a place in every sweep", async ({ request, db }) => {
  const c = club("Nobody FC");
  await seedHeld(c, "10 minutes", { history: null });
  await db.run(`DELETE FROM "ClubConnect" WHERE "orgId" = $1`, [c.org]);
  const first = await cron(request, { learning: "0" });
  expect(first.setupDms).toEqual({ considered: 1, sent: 0 });
  expect((await orgRow(db, c.org))!.asked).toEqual(new Date(DAY));
  const seen = await alerts(db, c.org);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "club-setup", title: "Setup message not sent" });
  expect(seen[0].detail).toContain("(no-organiser)");
  const second = await cron(request, { learning: "0" });
  expect(second.setupDms).toBeUndefined();
  expect(await alerts(db, c.org)).toHaveLength(1);
});

// ── PR #235 review fixes 3, 5 and 8: through the lib, against Postgres ──
// LAST in this file: it claims every platform job that is due.

test("decideClub and the reading against Postgres: suspend cancels the waiting DM, a closed reading applies nothing (tsx)", async () => {
  test.setTimeout(420_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/setup-hold-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 400_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`setup-hold-lib-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK: 14 setup-hold checks");
});
