/**
 * SELF-JOIN: RELINK AFTER A RE-ADD (2026-10-11), against a real Postgres
 * and the real routes.
 *
 * The organiser connects, adds MatchTime, then removes it and adds it
 * straight back (to switch on WhatsApp's "Message history") WITHOUT going
 * to the website for a new code. That add used to be unsolicited: silent,
 * nothing stored, left after 48 hours, nobody told. It now links the same
 * request again: the chat the re-add brought is stored, the club is
 * pending, and the organiser and the owner each hear once per relink.
 * Anybody else's add stays unsolicited.
 *
 * The rule is `decideRelinkAfterReAdd` (src/lib/group-add-rules.ts).
 * Flag handling is as in self-join-group-add.spec.ts. Deterministic end to
 * end: nothing here calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };

const CLUB = "e2e-sjr-riverside";
const ALI = "e2e-sjr-ali";
const ALI_PHONE = "447700900981";
const ALI_LID = "158055467598981";
const BEN_PHONE = "447700900982";
const STRANGER_PHONE = "447700900989";
const REQ = "e2e-sjr-req";
const GROUP = "120363700000000001@g.us";
const OTHER_GROUP = "120363700000000002@g.us";

const MEMBERS = [
  { phone: ALI_PHONE, pushname: "Ali" },
  { phone: BEN_PHONE, pushname: "Ben" },
];
const chat = (...texts: string[]) =>
  texts.map((text, i) => ({ author: "Ben", text, timestamp: new Date(Date.now() - (texts.length - i) * 60_000).toISOString() }));

async function botAdded(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/bot-added", { headers: ON, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function botRemoved(request: APIRequestContext, groupId: string) {
  const res = await request.post("/api/whatsapp/bot-removed", { headers: ON, data: { groupId } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const connect = (db: TestDb, id: string = REQ) =>
  db.one<{
    status: string;
    groupId: string | null;
    groupSubject: string | null;
    memberCount: number | null;
    addedByPhone: string | null;
    addedByLid: string | null;
    adderMatch: string | null;
    participants: Array<{ phone: string | null }> | null;
    capturedHistory: Array<{ text: string }> | null;
    linkedAt: Date | null;
    botRemovedAt: Date | null;
  }>(`SELECT * FROM "ClubConnect" WHERE id = $1`, [id]);

/** `botRemovedAt` as the ISO string the relink's dedupe keys carry. Read as
 *  text: the column is UTC without a zone, which the driver would parse as
 *  local time. */
const removedStamp = async (db: TestDb) =>
  (
    await db.one<{ s: string }>(
      `SELECT to_char("botRemovedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM "ClubConnect" WHERE id = $1`,
      [REQ],
    )
  )!.s;

const clubStatus = async (db: TestDb) =>
  (await db.one<{ approvalStatus: string }>(`SELECT "approvalStatus" FROM "Organisation" WHERE id = $1`, [CLUB]))?.approvalStatus;

const jobsTo = (db: TestDb, phone: string) =>
  db.all<{ text: string; refId: string; purpose: string }>(
    `SELECT text, "refId", purpose FROM "PlatformJob" WHERE phone = $1 AND kind = 'dm' ORDER BY "createdAt"`,
    [phone],
  );
const acks = async (db: TestDb) => (await jobsTo(db, ALI_PHONE)).filter((j) => j.refId.includes(":in-group"));
const ownerDms = (db: TestDb) => jobsTo(db, E2E.APPROVER_PHONE);

const liveLinks = (db: TestDb) =>
  db.count(`SELECT COUNT(*) FROM "ClubConnect" WHERE "orgId" = $1 AND status = 'group_linked' AND "botRemovedAt" IS NULL`, [CLUB]);
const openUnsolicited = (db: TestDb, groupId: string = GROUP) =>
  db.count(`SELECT COUNT(*) FROM "UnsolicitedGroup" WHERE "groupId" = $1 AND "leftAt" IS NULL`, [groupId]);

const ACK_TEXT = (group: string) =>
  `Thanks, I'm in "${group}". I'll stay quiet there until your club is approved, usually within a day. I'll message you here when it's live.`;

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'Riverside FC',$1,$2,'draft','en',now(),now())`,
    [CLUB, `${CLUB}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ($1,'Ali Demir',$2,$3,true,true,now())`,
    [ALI, `${ALI}@e2e-test.invalid`, `+${ALI_PHONE}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${ALI}-mem`, ALI, CLUB]);
  // The organiser pressed "Add MatchTime to WhatsApp": a code is waiting.
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt")
     VALUES ($1,$2,$3,$4,'7KQ2','issued',now(),now() + interval '60 minutes',now())`,
    [REQ, CLUB, ALI, ALI_PHONE],
  );
});

test.afterAll(() => {
  resetDb();
});

test("connect, then add: linked and pending, the first chat stored, one ack and one owner DM", async ({ request, db }) => {
  const dm = await request.post("/api/whatsapp/dm-reply", {
    headers: ON,
    data: {
      authorName: "Ali",
      waMessageId: `e2e-sjr-dm-${Date.now()}`,
      phone: ALI_PHONE,
      senderLid: `${ALI_LID}@lid`,
      body: "Connect Riverside FC, code 7KQ2",
    },
  });
  expect(dm.status(), await dm.text()).toBe(200);
  expect((await connect(db))?.status).toBe("dm_verified");

  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    enrichmentHistory: chat("old chat, before the history switch"),
  });
  expect(json).toMatchObject({ selfJoin: "linked", ignored: "self-join-pending", silent: true, introText: null });
  expect(await clubStatus(db)).toBe("pending");
  expect((await connect(db))?.capturedHistory?.map((m) => m.text)).toEqual(["old chat, before the history switch"]);
  expect((await acks(db)).map((j) => j.refId)).toEqual([`${REQ}:in-group`]);
  expect((await ownerDms(db)).map((j) => j.refId)).toEqual([REQ]);
});

test("removed while pending: back to draft, the chat deleted", async ({ request, db }) => {
  // The live case: by now the code the organiser used has long expired.
  await db.run(
    `UPDATE "ClubConnect" SET "issuedAt" = now() - interval '3 hours', "expiresAt" = now() - interval '2 hours',
       "linkedAt" = (now() at time zone 'utc') - interval '2 hours' WHERE id = $1`,
    [REQ],
  );
  expect(await botRemoved(request, GROUP)).toMatchObject({ returnedToDraft: 1 });
  expect(await clubStatus(db)).toBe("draft");
  const row = await connect(db);
  expect(row?.status).toBe("group_linked");
  expect(row?.botRemovedAt).not.toBeNull();
  expect(row?.capturedHistory).toBeNull();
});

test("a stranger adds MatchTime back, the organiser still in the group: unsolicited, exactly as before", async ({ request, db }) => {
  const dmsBefore = await db.count(`SELECT COUNT(*) FROM "PlatformJob"`);
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: STRANGER_PHONE,
    participants: [...MEMBERS, { phone: STRANGER_PHONE }],
    enrichmentHistory: chat("a stranger's add brings chat too"),
  });
  expect(json).toMatchObject({ selfJoin: "unsolicited", ignored: "unsolicited", silent: true, introText: null });
  expect(await clubStatus(db)).toBe("draft");
  const row = await connect(db);
  expect(row?.botRemovedAt).not.toBeNull();
  expect(row?.capturedHistory).toBeNull();
  expect(await liveLinks(db)).toBe(0);
  expect(await openUnsolicited(db)).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob"`)).toBe(dmsBefore);
});

test("the organiser adds it back with NO new code: linked again, the new chat stored, pending, one ack and one owner DM", async ({
  request,
  db,
}) => {
  const before = await connect(db);
  const removedAt = await removedStamp(db);
  // The stranger's unsolicited row is still open: the relink must close it,
  // or the 48-hour auto-leave would take MatchTime out of a waiting club's group.
  expect(await openUnsolicited(db)).toBe(1);

  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s (new)",
    addedByPhone: ALI_PHONE,
    participants: [...MEMBERS, { phone: "447700900983", pushname: "Cem" }],
    enrichmentHistory: chat("in for Tuesday", "me too", "who has the bibs"),
  });
  // The Pi hears exactly what it hears for a first link.
  expect(json).toMatchObject({ selfJoin: "linked", ignored: "self-join-pending", silent: true, introText: null });

  const row = await connect(db);
  expect(row).toMatchObject({
    status: "group_linked",
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s (new)",
    memberCount: 3,
    addedByPhone: ALI_PHONE,
    adderMatch: "phone",
    botRemovedAt: null,
  });
  expect(row?.participants).toHaveLength(3);
  expect(row?.capturedHistory?.map((m) => m.text)).toEqual(["in for Tuesday", "me too", "who has the bibs"]);
  // The chat's 7 days are measured from the relink, when it was stored.
  expect(row!.linkedAt!.getTime()).toBeGreaterThan(before!.linkedAt!.getTime() + 60 * 60 * 1000);

  expect(await clubStatus(db)).toBe("pending");
  expect(await liveLinks(db)).toBe(1);
  expect(await openUnsolicited(db)).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1`, [GROUP])).toBe(0);

  // One more ack and one more owner DM, for THIS relink.
  const ack = await acks(db);
  expect(ack.map((j) => j.refId)).toEqual([`${REQ}:in-group`, `${REQ}:in-group:relink:${removedAt}`]);
  expect(ack[1]).toMatchObject({ purpose: "connect-reply", text: ACK_TEXT("Riverside Tuesday 5s (new)") });
  const owner = await ownerDms(db);
  expect(owner.map((j) => j.refId)).toEqual([REQ, `${REQ}:relink:${removedAt}`]);
  // The first owner DM had not gone out yet (nothing in this spec plays the
  // Pi and sends it). It is NOT cancelled or replaced: the owner gets both,
  // each a true "club waiting" at the time it was queued. Accepted.
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE phone = $1 AND purpose = 'owner-approval' AND status = 'queued'`, [E2E.APPROVER_PHONE])).toBe(2);
  expect(owner[1].purpose).toBe("owner-approval");
  expect(owner[1].text).toBe(
    [
      "New club waiting: *Riverside FC* (ref 7KQ2)",
      "Organiser: Ali Demir, +44 7700 900981 (phone verified at sign-up)",
      "Added by: the organiser (matched by phone)",
      'Group: "Riverside Tuesday 5s (new)", 3 members (club chose English)',
      "Reply APPROVE 7KQ2 or REJECT 7KQ2, or use matchtime.ai/admin/clubs",
    ].join("\n"),
  );

  // Still silent for the Pi.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: ON })).json();
  expect(orgs.silentGroups).toContain(GROUP);
});

test("the same add delivered again (the Pi retries): nothing new, nobody DMed twice", async ({ request, db }) => {
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s (new)",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    enrichmentHistory: chat("a retry must not replace the stored chat"),
  });
  expect(json).toMatchObject({ selfJoin: "already-linked", ignored: "self-join-pending", silent: true });
  expect(await acks(db)).toHaveLength(2);
  expect(await ownerDms(db)).toHaveLength(2);
  expect((await connect(db))?.capturedHistory?.map((m) => m.text)).toEqual(["in for Tuesday", "me too", "who has the bibs"]);
  expect(await liveLinks(db)).toBe(1);
});

test("a second remove and re-add works too, this time matched by the connect DM's LID: one more ack, one more owner DM", async ({
  request,
  db,
}) => {
  expect(await botRemoved(request, GROUP)).toMatchObject({ returnedToDraft: 1 });
  expect(await clubStatus(db)).toBe("draft");
  const removedAt = await removedStamp(db);

  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s (new)",
    addedByLid: `${ALI_LID}@lid`,
    participants: MEMBERS,
    enrichmentHistory: chat("second time round"),
  });
  expect(json).toMatchObject({ selfJoin: "linked", ignored: "self-join-pending" });
  const row = await connect(db);
  expect(row).toMatchObject({ adderMatch: "lid", addedByLid: ALI_LID, addedByPhone: null, botRemovedAt: null });
  expect(row?.capturedHistory?.map((m) => m.text)).toEqual(["second time round"]);
  expect(await clubStatus(db)).toBe("pending");

  expect((await acks(db)).map((j) => j.refId)).toEqual([
    `${REQ}:in-group`,
    expect.stringContaining(":in-group:relink:"),
    `${REQ}:in-group:relink:${removedAt}`,
  ]);
  const owner = await ownerDms(db);
  expect(owner).toHaveLength(3);
  expect(owner[2].refId).toBe(`${REQ}:relink:${removedAt}`);
  expect(owner[2].text).toContain("Added by: the organiser (matched by WhatsApp id)");
});

test("the organiser also runs an approved club, and the add arrives twice AT ONCE: one relink, not an admin-group candidate; no member list came, so the old one is cleared", async ({
  request,
  db,
}) => {
  // Ali is an admin of the seeded approved club as well. Before, that made
  // his re-add an "admin group waiting for its code" and the club stayed draft.
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'ADMIN')`, [`${ALI}-approved-mem`, ALI, ORG_ID]);
  expect(await botRemoved(request, GROUP)).toMatchObject({ returnedToDraft: 1 });
  // An admin-group candidate row left open for this group by an earlier add.
  await db.run(
    `INSERT INTO "UnsolicitedGroup" (id,"groupId","addedAt","awaitingAdminLink") VALUES ('e2e-sjr-candidate',$1,(now() at time zone 'utc'),true)`,
    [GROUP],
  );
  expect((await connect(db))?.participants).toHaveLength(2);
  const removedAt = await removedStamp(db);

  // The same add, delivered twice at the same moment, with no member list.
  const add = () => botAdded(request, { groupId: GROUP, groupSubject: "Riverside Tuesday 5s (new)", addedByPhone: ALI_PHONE });
  const both = await Promise.all([add(), add()]);
  expect(both.map((j) => j.selfJoin).sort()).toEqual(["already-linked", "linked"]);
  for (const j of both) expect(j).toMatchObject({ ignored: "self-join-pending", silent: true });

  expect(await clubStatus(db)).toBe("pending");
  expect(await liveLinks(db)).toBe(1);
  const row = await connect(db);
  expect(row).toMatchObject({ adderMatch: "phone", memberCount: 0, botRemovedAt: null });
  // Nobody who was in the group before the removal is carried over unseen.
  expect(row?.participants).toBeNull();

  // The candidate row is closed, so no code posted later finds a waiting candidate and nothing auto-leaves.
  expect(await db.one(`SELECT "leftAt" IS NOT NULL AS closed, "awaitingAdminLink" FROM "UnsolicitedGroup" WHERE id = 'e2e-sjr-candidate'`)).toEqual({
    closed: true,
    awaitingAdminLink: false,
  });
  expect(await openUnsolicited(db)).toBe(0);

  // One ack and one owner DM for the two deliveries together.
  expect((await acks(db)).filter((j) => j.refId === `${REQ}:in-group:relink:${removedAt}`)).toHaveLength(1);
  expect((await ownerDms(db)).filter((j) => j.refId === `${REQ}:relink:${removedAt}`)).toHaveLength(1);
  expect(await acks(db)).toHaveLength(4);
  expect(await ownerDms(db)).toHaveLength(4);

  await db.run(`DELETE FROM "Membership" WHERE id = $1`, [`${ALI}-approved-mem`]);
});

test("more than 24 hours after the removal: the organiser's re-add is unsolicited again", async ({ request, db }) => {
  await botRemoved(request, GROUP);
  await db.run(`UPDATE "ClubConnect" SET "botRemovedAt" = (now() at time zone 'utc') - interval '25 hours' WHERE id = $1`, [REQ]);
  const json = await botAdded(request, { groupId: GROUP, groupSubject: "Riverside Tuesday 5s", addedByPhone: ALI_PHONE, participants: MEMBERS });
  expect(json).toMatchObject({ selfJoin: "unsolicited", silent: true });
  expect(await clubStatus(db)).toBe("draft");
  expect(await liveLinks(db)).toBe(0);
  expect(await acks(db)).toHaveLength(4);
  expect(await ownerDms(db)).toHaveLength(4);
});

test("the organiser's re-add to a DIFFERENT group is not a relink", async ({ request, db }) => {
  await botRemoved(request, GROUP);
  await db.run(`UPDATE "ClubConnect" SET "botRemovedAt" = (now() at time zone 'utc') - interval '5 minutes' WHERE id = $1`, [REQ]);
  const json = await botAdded(request, { groupId: OTHER_GROUP, groupSubject: "Another group", addedByPhone: ALI_PHONE, participants: MEMBERS });
  expect(json).toMatchObject({ selfJoin: "unsolicited", silent: true });
  expect(await clubStatus(db)).toBe("draft");
  expect(await liveLinks(db)).toBe(0);
  await botRemoved(request, OTHER_GROUP);
});

test("a NEW code since the removal: the code flow wins, and the club never has two live links", async ({ request, db }) => {
  // Removed five minutes ago (still inside the window), and the organiser
  // has been back to the website for a new code.
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt")
     VALUES ('e2e-sjr-new',$1,$2,$3,'9XT4','issued',(now() at time zone 'utc'),(now() at time zone 'utc') + interval '60 minutes',now())`,
    [CLUB, ALI, ALI_PHONE],
  );
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    enrichmentHistory: chat("linked through the new code"),
  });
  expect(json).toMatchObject({ selfJoin: "linked", ignored: "self-join-pending" });

  // The NEW request holds the link; the old one stays removed.
  expect(await connect(db, "e2e-sjr-new")).toMatchObject({ status: "group_linked", groupId: GROUP, botRemovedAt: null });
  const old = await connect(db);
  expect(old?.botRemovedAt).not.toBeNull();
  expect(old?.capturedHistory).toBeNull();
  expect(await liveLinks(db)).toBe(1);
  expect(await clubStatus(db)).toBe("pending");
  expect((await ownerDms(db)).map((j) => j.refId).at(-1)).toBe("e2e-sjr-new");

  // Removed again, the new code's request is the one a re-add links again;
  // the older request is never revived beside it.
  await botRemoved(request, GROUP);
  const again = await botAdded(request, { groupId: GROUP, groupSubject: "Riverside Tuesday 5s", addedByPhone: ALI_PHONE, participants: MEMBERS });
  expect(again).toMatchObject({ selfJoin: "linked" });
  expect((await connect(db, "e2e-sjr-new"))?.botRemovedAt).toBeNull();
  expect((await connect(db))?.botRemovedAt).not.toBeNull();
  expect(await liveLinks(db)).toBe(1);
});

test("a newer request that does NOT match the add (its code unused, the adder known only by LID): no relink of the older one", async ({
  request,
  db,
}) => {
  // Back to: old request removed just now, a newer request exists, and it
  // is only `issued` (no LID on it), so a LID-only add cannot match it.
  await botRemoved(request, GROUP);
  await db.run(`UPDATE "ClubConnect" SET status = 'expired', "botRemovedAt" = NULL, "groupId" = NULL WHERE id = 'e2e-sjr-new'`);
  await db.run(`UPDATE "ClubConnect" SET "botRemovedAt" = (now() at time zone 'utc') - interval '5 minutes' WHERE id = $1`, [REQ]);
  expect(await clubStatus(db)).toBe("draft");

  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByLid: `${ALI_LID}@lid`,
    participants: MEMBERS,
  });
  expect(json).toMatchObject({ selfJoin: "unsolicited", silent: true });
  expect(await clubStatus(db)).toBe("draft");
  expect(await liveLinks(db)).toBe(0);
});
