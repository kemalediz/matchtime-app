/**
 * SELF-JOIN SLICE 5: the connect DM, against a real Postgres and the real
 * dm-reply route. Plan: MDs/self-join-and-approval-plan-2026-09-28.md,
 * sections 5.3, 5.4 and cap 6 of section 7.
 *
 * The dev server runs with SELF_JOIN_ENABLED unset (off). A request turns
 * it on with the `x-mt-test-self-join` header, which the server honours
 * only because the e2e harness boots it with MT_TEST_MODE=1 (the same
 * double gate as the organiser web's cookie). The Pi never sends it.
 *
 * Deterministic end to end: the connect handler never calls a model.
 */
import { test, expect, resetDb } from "../fixtures";
import { PHONE, U, ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { addDmIntentBodies } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };

const EN_ORG = "e2e-sj5-riverside";
const TR_ORG = "e2e-sj5-kartallar";
const ALI = "e2e-sj5-ali";
const ALI_PHONE = "447700900961";
const AYSE = "e2e-sj5-ayse";
const AYSE_PHONE = "905321234561";
const STRANGER_PHONE = "447700900969";
const LID = "158055467598961";

let n = 0;
const msgId = () => `e2e-sj5-${Date.now()}-${++n}`;

async function dm(
  request: APIRequestContext,
  data: { phone?: string; body: string; waMessageId?: string; senderLid?: string; senderAltPhone?: string },
  headers: Record<string, string> = ON,
) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers,
    data: { authorName: "Someone", waMessageId: msgId(), ...data },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const connect = (db: TestDb, id: string) =>
  db.one<{
    status: string;
    dmAt: Date | null;
    dmPhone: string | null;
    dmLid: string | null;
    dmPhoneMatched: boolean | null;
    dmWaMessageId: string | null;
    addWindowEndsAt: Date | null;
    lastMismatchPhoneMasked: string | null;
    siteCapAt: Date | null;
  }>(`SELECT * FROM "ClubConnect" WHERE id = $1`, [id]);

const replies = (db: TestDb, phone: string) =>
  db.all<{ text: string; refId: string; purpose: string; status: string }>(
    `SELECT text, "refId", purpose, status FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt"`,
    [phone],
  );

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  for (const [org, name, lang, user, userName, phone] of [
    [EN_ORG, "Riverside FC", "en", ALI, "Ali Demir", ALI_PHONE],
    [TR_ORG, "Kartallar", "tr", AYSE, "Ayşe Yılmaz", AYSE_PHONE],
  ] as const) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'draft',$4,now(),now())`,
      [org, name, `${org}-invite`, lang],
    );
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
       VALUES ($1,$2,$3,$4,true,true,now())`,
      [user, userName, `${user}@e2e-test.invalid`, `+${phone}`],
    );
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${user}-mem`, user, org]);
  }
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt") VALUES
       ('e2e-sj5-en','${EN_ORG}','${ALI}','${ALI_PHONE}','7KQ2','issued',now(),now() + interval '60 minutes',now()),
       ('e2e-sj5-tr','${TR_ORG}','${AYSE}','${AYSE_PHONE}','9XT4','issued',now() - interval '2 hours',now() - interval '1 hour',now())`,
  );
});

test.afterAll(() => {
  resetDb();
});

test("flag OFF: the connect DM is not recognised; the organiser of a draft club hears nothing, exactly as before", async ({
  request,
  db,
}) => {
  const json = await dm(request, { phone: ALI_PHONE, body: "Connect Riverside FC, code 7KQ2" }, KEY);
  expect(json.handled).toBeUndefined();
  expect(json.ignored).toBe("club-not-approved");
  expect((await connect(db, "e2e-sj5-en"))?.status).toBe("issued");
  expect(await replies(db, ALI_PHONE)).toEqual([]);
});

test("from another number: no reply, and the organiser's card is told (masked)", async ({ request, db }) => {
  const json = await dm(request, { phone: STRANGER_PHONE, body: "Connect Riverside FC, code 7KQ2" });
  expect(json).toMatchObject({ handled: "connect-dm", result: "mismatch", replied: false });
  const row = await connect(db, "e2e-sj5-en");
  expect(row?.status).toBe("issued");
  expect(row?.lastMismatchPhoneMasked).toBe("+44 77** ***969");
  expect(await replies(db, STRANGER_PHONE)).toEqual([]);
});

test("from the sign-up phone, edited text, lowercase: verified, LID kept, one English reply", async ({ request, db }) => {
  const waMessageId = msgId();
  const json = await dm(request, {
    phone: ALI_PHONE,
    senderLid: `${LID}@lid`,
    body: "connect the tuesday lads please, code: 7kq2",
    waMessageId,
  });
  expect(json).toMatchObject({ handled: "connect-dm", result: "verified", replied: true });

  const row = await connect(db, "e2e-sj5-en");
  expect(row).toMatchObject({
    status: "dm_verified",
    dmPhone: ALI_PHONE,
    dmLid: LID,
    dmPhoneMatched: true,
    dmWaMessageId: waMessageId,
  });
  expect(row?.dmAt).not.toBeNull();
  expect(row!.addWindowEndsAt!.getTime() - row!.dmAt!.getTime()).toBe(24 * 60 * 60 * 1000);

  const sent = await replies(db, ALI_PHONE);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ purpose: "connect-reply", refId: "e2e-sj5-en:connected", status: "queued" });
  expect(sent[0].text).toBe(
    "Hi Ali, got it: Riverside FC is connected to this chat.\n" +
      "Next, add me to your football group. Save this number as a contact called MatchTime first, then open the group, tap Add participant and pick MatchTime.\n\n" +
      "*Important: before you confirm, switch on \"Message history\" on that screen.* It sends me your group's recent messages, so I can set MatchTime up the way you already run things.\n\n" +
      "I'll stay quiet in the group until your club is approved, usually within a day. I'll message you here when it's live.",
  );

  // The same WhatsApp message forwarded again: nothing new.
  const again = await dm(request, { phone: ALI_PHONE, body: "connect the tuesday lads please, code: 7kq2", waMessageId });
  expect(again).toMatchObject({ result: "duplicate", replied: false });
  expect(await replies(db, ALI_PHONE)).toHaveLength(1);
});

test("sent again after verifying: 'already connected', once however often", async ({ request, db }) => {
  const first = await dm(request, { phone: ALI_PHONE, body: "Connect Riverside FC, code 7KQ2" });
  expect(first).toMatchObject({ result: "already-connected", replied: true });
  const second = await dm(request, { phone: ALI_PHONE, body: "Connect Riverside FC, code 7KQ2" });
  expect(second).toMatchObject({ result: "already-connected", replied: false });
  const sent = await replies(db, ALI_PHONE);
  expect(sent.map((r) => r.refId)).toEqual(["e2e-sj5-en:connected", "e2e-sj5-en:already-connected"]);
  expect(sent[1].text).toBe("You're already connected. Now just add me to your group.");
});

test("an expired code from the organiser: one reply, in the club's language (Turkish)", async ({ request, db }) => {
  const json = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod 9XT4" });
  expect(json).toMatchObject({ result: "expired", replied: true });
  expect((await connect(db, "e2e-sj5-tr"))?.status).toBe("expired");
  const sent = await replies(db, AYSE_PHONE);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe(
    "Bu kodun süresi doldu. matchtime.ai'de kulübünüzü açın ve MatchTime'ı WhatsApp'a ekle düğmesine tekrar dokunun.",
  );
});

test("cap 6: with five groups connected today, the next organiser's code stays issued and they hear the cap line", async ({
  request,
  db,
}) => {
  // Four more connect DMs today (Ali's makes five).
  for (let i = 0; i < 4; i++) {
    await db.run(
      `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"expiresAt","dmAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'dm_verified',now() + interval '1 hour',now(),now())`,
      [`e2e-sj5-cap-${i}`, EN_ORG, ALI, ALI_PHONE, `CAP${i + 2}`],
    );
  }
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt")
     VALUES ('e2e-sj5-tr2',$1,$2,$3,'HN4P','issued',now(),now() + interval '60 minutes',now())`,
    [TR_ORG, AYSE, AYSE_PHONE],
  );
  const json = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod HN4P" });
  expect(json).toMatchObject({ result: "site-cap", replied: true });
  const row = await connect(db, "e2e-sj5-tr2");
  expect(row?.status).toBe("issued");
  expect(row?.siteCapAt).not.toBeNull();
  const sent = await replies(db, AYSE_PHONE);
  expect(sent.at(-1)?.text).toBe("Her gün birkaç yeni grup alıyoruz. Lütfen yarın tekrar deneyin.");
});

// ── A connect message with a code that names no request (2026-10-12) ────
// Ayşe still has an open request ('e2e-sj5-tr2', code HN4P, Turkish club).
const WRONG_TR =
  "Mesajınızdaki kod Kartallar için verilen kodla eşleşmiyor. matchtime.ai'de kulüp sayfanıza dönün, MatchTime'ı WhatsApp'a ekle düğmesine tekrar dokunun ve açılan mesajı hiç değiştirmeden gönderin.";
const wrongCodeReplies = async (db: TestDb, phone: string) =>
  (await replies(db, phone)).filter((r) => r.refId.includes(":wrong-code:"));

test("wrong code, flag OFF: nothing, exactly as before", async ({ request, db }) => {
  const json = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod ZZZ9" }, KEY);
  expect(json.handled).toBeUndefined();
  expect(await wrongCodeReplies(db, AYSE_PHONE)).toEqual([]);
});

test("wrong code from a stranger: nothing queued for anyone, and the DM falls through", async ({ request, db }) => {
  const before = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "PlatformJob"`);
  const json = await dm(request, { phone: STRANGER_PHONE, body: "Connect Riverside FC, code ZZZ9" });
  expect(json.handled).toBeUndefined();
  expect(json.ignored).toBe("unknown-sender");
  // An organiser whose request is no longer open (Ali's is verified) is a stranger to this branch too.
  const ali = await dm(request, { phone: ALI_PHONE, body: "Connect Riverside FC, code ZZZ9" });
  expect(ali.handled).not.toBe("connect-dm");
  expect(await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "PlatformJob"`)).toEqual(before);
});

test("wrong code with the sender's number hidden (LID only): nothing, as before", async ({ request, db }) => {
  const json = await dm(request, { senderLid: `${LID}@lid`, body: "Kartallar kulübünü bağla, kod ZZZ9" });
  expect(json.handled).not.toBe("connect-dm");
  expect(await wrongCodeReplies(db, AYSE_PHONE)).toEqual([]);
});

test("ordinary chat with a code-shaped word from an organiser with an open request: not a connect message", async ({
  request,
  db,
}) => {
  const json = await dm(request, { phone: AYSE_PHONE, body: "what's the code then" });
  expect(json.handled).not.toBe("connect-dm");
  expect(await wrongCodeReplies(db, AYSE_PHONE)).toEqual([]);
});

test("wrong code from the organiser with an open request: told once, in the club's language; again only after ten minutes", async ({
  request,
  db,
}) => {
  // The DM reader says these are the connect message (stubbed: what the
  // model would read). Since 2026-10-30 no verb list decides it.
  addDmIntentBodies({ "Kartallar kulübünü bağla, kod ZZZ9": "connect_club", "Kartallar kulübünü bağla, kod ZZZ8": "connect_club" });
  const first = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod ZZZ9" });
  expect(first).toMatchObject({ handled: "connect-dm", result: "wrong-code", replied: true });
  let sent = await wrongCodeReplies(db, AYSE_PHONE);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ purpose: "connect-reply", status: "queued", text: WRONG_TR });
  expect(sent[0].refId).toMatch(/^e2e-sj5-tr2:wrong-code:\d+$/);
  // The right code is never sent back, and the request is untouched.
  expect(sent[0].text).not.toContain("HN4P");
  expect((await connect(db, "e2e-sj5-tr2"))?.status).toBe("issued");

  // Another wrong code straight away: handled, and silent.
  const second = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod ZZZ8" });
  expect(second).toMatchObject({ handled: "connect-dm", result: "wrong-code-throttled", replied: false });
  expect(await wrongCodeReplies(db, AYSE_PHONE)).toHaveLength(1);

  // Eleven minutes on, one more.
  await db.run(
    `UPDATE "PlatformJob" SET "createdAt" = (now() at time zone 'utc') - interval '11 minutes' WHERE "refId" LIKE 'e2e-sj5-tr2:wrong-code:%'`,
  );
  const third = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod ZZZ8" });
  expect(third).toMatchObject({ result: "wrong-code", replied: true });
  sent = await wrongCodeReplies(db, AYSE_PHONE);
  expect(sent).toHaveLength(2);
});

test("the connect message in any words, no 'connect' or 'bağla' in it: the reader says so, and the organiser is told", async ({
  request,
  db,
}) => {
  await db.run(
    `UPDATE "PlatformJob" SET "createdAt" = (now() at time zone 'utc') - interval '11 minutes' WHERE "refId" LIKE 'e2e-sj5-tr2:wrong-code:%'`,
  );
  const body = "merhaba, kodum ZZZ7, grubumuzu ekler misiniz";
  addDmIntentBodies({ [body]: "connect_club" });
  const json = await dm(request, { phone: AYSE_PHONE, body });
  expect(json).toMatchObject({ handled: "connect-dm", result: "wrong-code", replied: true });
  expect(await wrongCodeReplies(db, AYSE_PHONE)).toHaveLength(3);
});

test("wrong code after the organiser's request has run out: nothing, as before", async ({ request, db }) => {
  addDmIntentBodies({ "Kartallar kulübünü bağla, kod ZZZ9": "connect_club" });
  await db.run(
    `UPDATE "PlatformJob" SET "createdAt" = (now() at time zone 'utc') - interval '11 minutes' WHERE "refId" LIKE 'e2e-sj5-tr2:wrong-code:%'`,
  );
  await db.run(`UPDATE "ClubConnect" SET "expiresAt" = (now() at time zone 'utc') - interval '1 minute' WHERE id = 'e2e-sj5-tr2'`);
  const json = await dm(request, { phone: AYSE_PHONE, body: "Kartallar kulübünü bağla, kod ZZZ9" });
  expect(json.handled).not.toBe("connect-dm");
  expect(await wrongCodeReplies(db, AYSE_PHONE)).toHaveLength(3);
});

test("flag ON leaves every other DM alone: a member's opt-out still works, an unknown code falls through", async ({
  request,
  db,
}) => {
  const optOut = await dm(request, { phone: PHONE.opt, body: "stop messaging me about ratings please" });
  expect(optOut.handled).toBe("dm-subscription");
  const mem = await db.one<{ subRatingDm: boolean }>(
    `SELECT "subRatingDm" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [U.opt, ORG_ID],
  );
  expect(mem?.subRatingDm).toBe(false);

  const unknown = await dm(request, { phone: PHONE.opt, body: "gate code ZZZZ" });
  expect(unknown.handled).not.toBe("connect-dm");
});
