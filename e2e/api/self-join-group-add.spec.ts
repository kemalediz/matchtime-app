/**
 * SELF-JOIN SLICE 6: group add linking, against a real Postgres and the
 * real routes. Plan: MDs/self-join-and-approval-plan-2026-09-28.md,
 * sections 2.3, 4.1, 5.5, 5.6, 5.7, 6.1 and 8.
 *
 * The dev server runs with SELF_JOIN_ENABLED unset (off) and
 * ONBOARDING_AUTOSTART=1. A request turns self-join on with the
 * `x-mt-test-self-join` header, honoured only because the harness boots
 * the server with MT_TEST_MODE=1. SELF_JOIN_APPROVER_PHONES is the test
 * number E2E.APPROVER_PHONE.
 *
 * Deterministic end to end: nothing here calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };

const EN_ORG = "e2e-sj6-riverside";
const TR_ORG = "e2e-sj6-kartallar";
const ALI = "e2e-sj6-ali";
const ALI_PHONE = "447700900971";
const AYSE = "e2e-sj6-ayse";
const AYSE_PHONE = "905321234571";
const AYSE_LID = "158055467598971";
const STRANGER_PHONE = "447700900979";

const EN_GROUP = "120363600000000001@g.us";
const TR_GROUP = "120363600000000002@g.us";
const RANDOM_GROUP = "120363600000000003@g.us";
const OFF_GROUP = "120363600000000004@g.us";

async function botAdded(request: APIRequestContext, data: Record<string, unknown>, headers: Record<string, string> = ON) {
  const res = await request.post("/api/whatsapp/bot-added", { headers, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function botRemoved(request: APIRequestContext, groupId: string) {
  const res = await request.post("/api/whatsapp/bot-removed", { headers: ON, data: { groupId } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const connect = (db: TestDb, id: string) =>
  db.one<{
    status: string;
    groupId: string | null;
    groupSubject: string | null;
    memberCount: number | null;
    addedByPhone: string | null;
    addedByLid: string | null;
    adderMatch: string | null;
    detectedLang: string | null;
    linkedAt: Date | null;
    ownerDmQueuedAt: Date | null;
    botRemovedAt: Date | null;
  }>(`SELECT * FROM "ClubConnect" WHERE id = $1`, [id]);

const org = (db: TestDb, id: string) =>
  db.one<{ approvalStatus: string; whatsappBotEnabled: boolean; whatsappGroupId: string | null }>(
    `SELECT "approvalStatus","whatsappBotEnabled","whatsappGroupId" FROM "Organisation" WHERE id = $1`,
    [id],
  );

const jobsTo = (db: TestDb, phone: string) =>
  db.all<{ text: string; refId: string; purpose: string }>(
    `SELECT text, "refId", purpose FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt"`,
    [phone],
  );

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  for (const [orgId, name, lang, user, userName, phone] of [
    [EN_ORG, "Riverside FC", "en", ALI, "Ali Demir", ALI_PHONE],
    [TR_ORG, "Kartallar", "tr", AYSE, "Ayşe Yılmaz", AYSE_PHONE],
  ] as const) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'draft',$4,now(),now())`,
      [orgId, name, `${orgId}-invite`, lang],
    );
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
       VALUES ($1,$2,$3,$4,true,true,now())`,
      [user, userName, `${user}@e2e-test.invalid`, `+${phone}`],
    );
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${user}-mem`, user, orgId]);
  }
  // Both organisers sent their connect DM a few minutes ago. Ayşe's phone
  // was hidden: her request is bound to her LID alone.
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","dmLid","dmPhoneMatched","addWindowEndsAt","updatedAt") VALUES
       ('e2e-sj6-en',$1,$2,$3,'7KQ2','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',$3,NULL,true,now() + interval '23 hours',now()),
       ('e2e-sj6-tr',$4,$5,$6,'9XT4','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',NULL,$7,NULL,now() + interval '23 hours',now())`,
    [EN_ORG, ALI, ALI_PHONE, TR_ORG, AYSE, AYSE_PHONE, AYSE_LID],
  );
});

test.afterAll(() => {
  resetDb();
});

test("flag OFF: an organiser's add is not linked; the club stays draft; the owner hears nothing", async ({ request, db }) => {
  await botAdded(request, { groupId: OFF_GROUP, groupSubject: "Riverside Tuesday 5s", addedByPhone: ALI_PHONE }, KEY);
  expect((await connect(db, "e2e-sj6-en"))?.status).toBe("dm_verified");
  expect((await org(db, EN_ORG))?.approvalStatus).toBe("draft");
  expect(await jobsTo(db, E2E.APPROVER_PHONE)).toEqual([]);
  expect(await jobsTo(db, ALI_PHONE)).toEqual([]);
});

test("the orgs route asks the Pi to sweep while organisers wait, and lists every club's group as known", async ({ request }) => {
  const on = await (await request.get("/api/whatsapp/orgs", { headers: ON })).json();
  expect(on.selfJoinSweep.knownGroups).toContain(E2E.GROUP_ID);
  const off = await (await request.get("/api/whatsapp/orgs", { headers: KEY })).json();
  expect("selfJoinSweep" in off).toBe(false);
});

test("the organiser adds MatchTime: linked, pending, silent, one owner DM, one ack", async ({ request, db }) => {
  const participants = [
    { phone: ALI_PHONE, pushname: "Ali" },
    { phone: "447700900972", pushname: "Ben" },
    { phone: "447700900973", pushname: "Cem" },
  ];
  const json = await botAdded(request, {
    groupId: EN_GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants,
  });
  expect(json).toMatchObject({ introText: null, silent: true, selfJoin: "linked", ignored: "self-join-pending" });

  const row = await connect(db, "e2e-sj6-en");
  expect(row).toMatchObject({
    status: "group_linked",
    groupId: EN_GROUP,
    groupSubject: "Riverside Tuesday 5s",
    memberCount: 3,
    addedByPhone: ALI_PHONE,
    adderMatch: "phone",
  });
  expect(row?.linkedAt).not.toBeNull();
  expect(row?.ownerDmQueuedAt).not.toBeNull();

  // Pending, and still silent: bot off, no group id until approval.
  expect(await org(db, EN_ORG)).toEqual({ approvalStatus: "pending", whatsappBotEnabled: false, whatsappGroupId: null });

  const owner = await jobsTo(db, E2E.APPROVER_PHONE);
  expect(owner).toHaveLength(1);
  expect(owner[0]).toMatchObject({ purpose: "owner-approval", refId: "e2e-sj6-en" });
  expect(owner[0].text).toBe(
    [
      "New club waiting: *Riverside FC* (ref 7KQ2)",
      "Organiser: Ali Demir, +44 7700 900971 (phone verified at sign-up)",
      "Added by: the organiser (matched by phone)",
      'Group: "Riverside Tuesday 5s", 3 members, looks English (club chose English)',
      "Reply APPROVE 7KQ2 or REJECT 7KQ2, or use matchtime.ai/admin/clubs",
    ].join("\n"),
  );

  const ack = await jobsTo(db, ALI_PHONE);
  expect(ack).toEqual([
    {
      purpose: "connect-reply",
      refId: "e2e-sj6-en:in-group",
      text: "Thanks, I'm in \"Riverside Tuesday 5s\". I'll stay quiet there until we switch you on, and I'll message you here when it's done.",
    },
  ]);

  // The Pi is told to keep away.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: ON })).json();
  expect(orgs.silentGroups).toContain(EN_GROUP);
  expect(orgs.orgs.map((o: { whatsappGroupId: string }) => o.whatsappGroupId)).not.toContain(EN_GROUP);

  // A re-add changes nothing and DMs nobody again.
  const again = await botAdded(request, { groupId: EN_GROUP, groupSubject: "Riverside Tuesday 5s", addedByPhone: ALI_PHONE, participants });
  expect(again).toMatchObject({ selfJoin: "already-linked", silent: true, introText: null });
  expect(await jobsTo(db, E2E.APPROVER_PHONE)).toHaveLength(1);
  expect(await jobsTo(db, ALI_PHONE)).toHaveLength(1);
});

test("a LID-only adder matches the connect DM's LID; the ack is Turkish; the owner is told the number is unconfirmed", async ({
  request,
  db,
}) => {
  const json = await botAdded(request, {
    groupId: TR_GROUP,
    groupSubject: "Cuma Halı Saha",
    addedByLid: AYSE_LID,
    participants: [{ lidId: `${AYSE_LID}@lid`, pushname: "Ayşe" }, { phone: "905321234572" }],
    enrichmentHistory: [{ author: "Erdal", text: "ben varım bu hafta", timestamp: new Date().toISOString() }],
  });
  expect(json.selfJoin).toBe("linked");
  expect(await connect(db, "e2e-sj6-tr")).toMatchObject({ adderMatch: "lid", addedByLid: AYSE_LID, addedByPhone: null });
  expect((await org(db, TR_ORG))?.approvalStatus).toBe("pending");

  const ack = await jobsTo(db, AYSE_PHONE);
  expect(ack.map((j) => j.text)).toEqual([
    'Teşekkürler, "Cuma Halı Saha" grubuna katıldım. Sizi açana kadar orada sessiz kalacağım, bitince size buradan yazacağım.',
  ]);
  const owner = (await jobsTo(db, E2E.APPROVER_PHONE)).find((j) => j.refId === "e2e-sj6-tr");
  expect(owner?.text).toContain("Added by: the organiser (matched by WhatsApp id) (organiser's WhatsApp number not confirmed)");
  expect(owner?.text).toContain("(club chose Türkçe)");
});

test("an add nobody asked for: unsolicited, silent, nobody DMed; left after 48 hours", async ({ request, db }) => {
  const before = (await jobsTo(db, E2E.APPROVER_PHONE)).length;
  const json = await botAdded(request, {
    groupId: RANDOM_GROUP,
    groupSubject: "Random lads",
    addedByPhone: STRANGER_PHONE,
    participants: [{ phone: STRANGER_PHONE }],
  });
  expect(json).toMatchObject({ selfJoin: "unsolicited", silent: true, introText: null });
  expect(await db.count(`SELECT COUNT(*) FROM "UnsolicitedGroup" WHERE "groupId" = $1 AND "leftAt" IS NULL`, [RANDOM_GROUP])).toBe(1);
  expect(await jobsTo(db, E2E.APPROVER_PHONE)).toHaveLength(before);
  expect(await jobsTo(db, STRANGER_PHONE)).toEqual([]);
  expect((await (await request.get("/api/whatsapp/orgs", { headers: ON })).json()).silentGroups).toContain(RANDOM_GROUP);

  // Not yet 48 hours: no leave.
  await request.get("/api/whatsapp/platform-jobs", { headers: ON });
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1`, [RANDOM_GROUP])).toBe(0);

  // 49 hours later: the leave is queued and handed to the Pi.
  await db.run(`UPDATE "UnsolicitedGroup" SET "addedAt" = now() - interval '49 hours' WHERE "groupId" = $1`, [RANDOM_GROUP]);
  let leave: { id: string } | undefined;
  for (let i = 0; i < 4 && !leave; i++) {
    const { jobs } = await (await request.get("/api/whatsapp/platform-jobs", { headers: ON })).json();
    leave = jobs.find((j: { kind: string; groupId?: string }) => j.kind === "leave-group" && j.groupId === RANDOM_GROUP);
  }
  expect(leave).toBeTruthy();

  // The Pi reports it left; the next poll marks the row left, and no second leave is queued.
  await request.post("/api/whatsapp/platform-jobs", { headers: KEY, data: { id: leave!.id, outcome: "sent" } });
  await request.get("/api/whatsapp/platform-jobs", { headers: ON });
  expect(await db.count(`SELECT COUNT(*) FROM "UnsolicitedGroup" WHERE "groupId" = $1 AND "leftAt" IS NOT NULL`, [RANDOM_GROUP])).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1`, [RANDOM_GROUP])).toBe(1);
});

test("MatchTime removed while pending: the club goes back to draft, nobody is DMed", async ({ request, db }) => {
  const dmsBefore = await db.count(`SELECT COUNT(*) FROM "PlatformJob"`);
  const json = await botRemoved(request, EN_GROUP);
  expect(json).toMatchObject({ ok: true, returnedToDraft: 1 });
  expect((await org(db, EN_ORG))?.approvalStatus).toBe("draft");
  expect((await connect(db, "e2e-sj6-en"))?.botRemovedAt).not.toBeNull();
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob"`)).toBe(dmsBefore);
});

test("Sutton FC's group (the seeded approved club): no add, removal or stale row can make it pending or leave it", async ({
  request,
  db,
}) => {
  // An organiser with an open request, in Sutton's group, "adds" MatchTime there.
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","addWindowEndsAt","updatedAt")
     VALUES ('e2e-sj6-sutton-try',$1,$2,$3,'HN4P','dm_verified',now(),now() + interval '1 hour',now(),$3,now() + interval '23 hours',now())`,
    [TR_ORG, AYSE, AYSE_PHONE],
  );
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'draft' WHERE id = $1`, [TR_ORG]);

  for (const data of [
    { addedByPhone: AYSE_PHONE, participants: [{ phone: AYSE_PHONE }] },
    { addedByPhone: STRANGER_PHONE, participants: [{ phone: AYSE_PHONE }] },
    { discovered: true, participants: [{ phone: AYSE_PHONE }] },
  ]) {
    const json = await botAdded(request, { groupId: E2E.GROUP_ID, groupSubject: "Sutton FC", ...data });
    expect(json).toMatchObject({ ignored: "live-org", silent: false, introText: null });
  }
  await botRemoved(request, E2E.GROUP_ID);

  // A stale unsolicited row naming Sutton's group, days old.
  await db.run(
    `INSERT INTO "UnsolicitedGroup" (id,"groupId","addedAt") VALUES ('e2e-sj6-stale',$1,now() - interval '72 hours')`,
    [E2E.GROUP_ID],
  );
  for (let i = 0; i < 3; i++) await request.get("/api/whatsapp/platform-jobs", { headers: ON });

  expect(await org(db, ORG_ID)).toEqual({ approvalStatus: "approved", whatsappBotEnabled: true, whatsappGroupId: E2E.GROUP_ID });
  expect((await connect(db, "e2e-sj6-sutton-try"))?.status).toBe("dm_verified");
  expect(
    await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1 AND status <> 'failed'`, [
      E2E.GROUP_ID,
    ]),
  ).toBe(0);
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: ON })).json();
  expect(orgs.silentGroups).not.toContain(E2E.GROUP_ID);
  expect(orgs.orgs.map((o: { whatsappGroupId: string }) => o.whatsappGroupId)).toContain(E2E.GROUP_ID);
});
