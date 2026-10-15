/**
 * MatchTime JOINS BY INVITE (2026-10-15), against a real Postgres and the
 * real routes.
 *
 * WhatsApp refused to let a new organiser (not in MatchTime's contacts) add
 * MatchTime to his group, and offered "Invite to group". The Pi now asks
 * /api/whatsapp/group-invite whether the sender is the organiser of an open
 * DM-verified request, joins on a yes, and then runs the ordinary bot-added
 * flow. An invite join brings NO shared history, so the add that follows
 * has none; it must still link the club and DM the owner.
 *
 * Deterministic end to end: nothing here calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };

const ORG = "e2e-inv-fnf";
const OWNER = "e2e-inv-owner";
const OWNER_PHONE = "447700900961";
const OWNER_LID = "158055467598961";
const STRANGER_PHONE = "447700900969";
const GROUP = "120363600000000061@g.us";

async function inviteCheck(request: APIRequestContext, data: Record<string, unknown>, headers: Record<string, string> = ON) {
  const res = await request.post("/api/whatsapp/group-invite", { headers, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const jobsTo = (db: TestDb, phone: string) =>
  db.all<{ text: string; refId: string; purpose: string }>(
    `SELECT text, "refId", purpose FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt"`,
    [phone],
  );

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'FNF',$1,$2,'draft','en',now(),now())`,
    [ORG, `${ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ($1,'Fikret N',$2,$3,true,true,now())`,
    [OWNER, `${OWNER}@e2e-test.invalid`, `+${OWNER_PHONE}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${OWNER}-mem`, OWNER, ORG]);
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","dmLid","dmPhoneMatched","addWindowEndsAt","updatedAt") VALUES
       ('e2e-inv-cc',$1,$2,$3,'4FN7','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',$3,$4,true,now() + interval '23 hours',now())`,
    [ORG, OWNER, OWNER_PHONE, OWNER_LID],
  );
});

test.afterAll(() => {
  resetDb();
});

test("flag OFF: nobody's invite is accepted", async ({ request }) => {
  expect(await inviteCheck(request, { phone: OWNER_PHONE, kind: "invite-message" }, KEY)).toEqual({
    accept: false,
    reason: "self-join-off",
  });
});

test("a stranger's invite is not accepted", async ({ request }) => {
  expect(await inviteCheck(request, { phone: STRANGER_PHONE, kind: "invite-message" })).toEqual({
    accept: false,
    reason: "not-organiser",
  });
  expect(await inviteCheck(request, { senderLid: "999999999999999@lid", kind: "invite-link" })).toEqual({
    accept: false,
    reason: "not-organiser",
  });
});

test("the organiser's invite is accepted, by phone or by LID", async ({ request }) => {
  expect(await inviteCheck(request, { phone: OWNER_PHONE, kind: "invite-message" })).toEqual({ accept: true, match: "phone" });
  expect(await inviteCheck(request, { senderLid: `${OWNER_LID}@lid`, kind: "invite-link" })).toEqual({
    accept: true,
    match: "lid",
  });
});

test("the join that follows, with NO shared history, links the club and DMs the owner once", async ({ request, db }) => {
  // What the Pi posts after an invite join: the inviter as the adder (by
  // LID, as a DM from a stranger usually arrives), the roster, no history.
  const res = await request.post("/api/whatsapp/bot-added", {
    headers: ON,
    data: {
      groupId: GROUP,
      groupSubject: "FNF Thursday",
      addedByLid: OWNER_LID,
      participants: [{ phone: OWNER_PHONE, lidId: `${OWNER_LID}@lid` }, { phone: "447700900962" }, { phone: "447700900963" }],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ selfJoin: "linked", silent: true, introText: null });

  const row = await db.one<{ status: string; groupId: string | null; adderMatch: string | null }>(
    `SELECT status,"groupId","adderMatch" FROM "ClubConnect" WHERE id = 'e2e-inv-cc'`,
  );
  expect(row).toMatchObject({ status: "group_linked", groupId: GROUP, adderMatch: "lid" });
  const club = await db.one<{ approvalStatus: string }>(`SELECT "approvalStatus" FROM "Organisation" WHERE id = $1`, [ORG]);
  expect(club?.approvalStatus).toBe("pending");

  const owner = (await jobsTo(db, E2E.APPROVER_PHONE)).filter((j) => j.refId === "e2e-inv-cc");
  expect(owner).toHaveLength(1);
  expect(owner[0].text).toContain("New club waiting: *FNF* (ref 4FN7)");
  expect(owner[0].text).toContain("Reply APPROVE 4FN7 or REJECT 4FN7");

  // The request is linked now: a second invite from the same organiser is not accepted.
  expect(await inviteCheck(request, { phone: OWNER_PHONE, kind: "invite-message" })).toEqual({
    accept: false,
    reason: "no-open-request",
  });
});
