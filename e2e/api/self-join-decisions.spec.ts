/**
 * SELF-JOIN SLICE 7 ("Decisions"), end to end against a real Postgres and
 * the real routes. Plan: MDs/self-join-and-approval-plan-2026-09-28.md,
 * sections 4.1, 5.4, 6.2, 6.3 and 7 (cap 8).
 *
 * The whole flow an organiser and the owner go through, driven the way the
 * Pi drives it: the connect code, the organiser's connect DM, the group
 * add (pending, one owner DM), the owner's "APPROVE 7KQ2" by DM, the hello
 * queued as the group's first post, the organiser's DM. Then the REJECT
 * path, a non-approver's APPROVE, and cap 8.
 *
 * The dev server runs with SELF_JOIN_ENABLED unset; requests turn it on
 * with `x-mt-test-self-join` (honoured only because the harness boots the
 * server with MT_TEST_MODE=1). SELF_JOIN_APPROVER_PHONES is E2E.APPROVER_PHONE.
 *
 * Deterministic end to end: nothing here calls a model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";
import { t } from "@/lib/i18n/t";

/** The group hello, from the copy table (its wording is pinned in self-join-copy.test.ts). */
const hello = (lang: "en" | "tr") => t(lang).sj_group_hello;

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };
const PI = { ...KEY, "x-mt-platform-jobs": "1" };

const EN_ORG = "e2e-sj7-riverside";
const TR_ORG = "e2e-sj7-kartallar";
const X_ORG = "e2e-sj7-hackney";
const ALI = "e2e-sj7-ali";
const ALI_PHONE = "447700900961";
const AYSE = "e2e-sj7-ayse";
const AYSE_PHONE = "905321234561";
const HAL = "e2e-sj7-hal";
const HAL_PHONE = "447700900965";
const BEN_PHONE = "447700900962";
const CEM_PHONE = "447700900963";

const EN_GROUP = "120363700000000001@g.us";
const TR_GROUP = "120363700000000002@g.us";
const X_GROUP = "120363700000000003@g.us";

let wa = 0;
async function dm(request: APIRequestContext, phone: string, body: string, headers: Record<string, string> = ON, waMessageId?: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers,
    data: { phone, body, waMessageId: waMessageId ?? `e2e-sj7-wa-${++wa}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function botAdded(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/bot-added", { headers: ON, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const org = (db: TestDb, id: string) =>
  db.one<{ approvalStatus: string; whatsappBotEnabled: boolean; whatsappGroupId: string | null; approvedAt: Date | null; approvalDecidedBy: string | null }>(
    `SELECT "approvalStatus","whatsappBotEnabled","whatsappGroupId","approvedAt","approvalDecidedBy" FROM "Organisation" WHERE id = $1`,
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
    [X_ORG, "Hackney Weds", "en", HAL, "Hal Jones", HAL_PHONE],
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
  // Ali tapped "Add MatchTime to WhatsApp" a minute ago: a live connect code.
  // Ayşe and Hal already sent their connect DMs.
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt")
     VALUES ('e2e-sj7-en',$1,$2,$3,'7KQ2','issued',now() - interval '1 minute',now() + interval '59 minutes',now())`,
    [EN_ORG, ALI, ALI_PHONE],
  );
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","dmPhoneMatched","addWindowEndsAt","updatedAt") VALUES
       ('e2e-sj7-tr',$1,$2,$3,'9XT4','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',$3,true,now() + interval '23 hours',now()),
       ('e2e-sj7-x',$4,$5,$6,'4HCW','dm_verified',now() - interval '10 minutes',now() + interval '50 minutes',now() - interval '5 minutes',$6,true,now() + interval '23 hours',now())`,
    [TR_ORG, AYSE, AYSE_PHONE, X_ORG, HAL, HAL_PHONE],
  );
});

test.afterAll(() => {
  resetDb();
});

test("decideClub against Postgres: races, the CHECK constraint, Sutton FC untouchable (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/club-decisions-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 110_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`club-decisions-lib-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK: 4 club-decision checks");
});

test("the whole flow: connect DM, add, pending, APPROVE by DM, hello first, organiser DM", async ({ request, db }) => {
  // 1. The organiser sends the prefilled connect DM.
  const connect = await dm(request, ALI_PHONE, "Connect Riverside FC, code 7KQ2");
  expect(connect).toMatchObject({ handled: "connect-dm", result: "verified" });

  // 2. They add MatchTime to their group: pending, silent, one owner DM.
  const added = await botAdded(request, {
    groupId: EN_GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: [
      { phone: ALI_PHONE, pushname: "Ali" },
      { phone: BEN_PHONE, pushname: "Ben" },
      { phone: CEM_PHONE, pushname: "Cem" },
    ],
  });
  expect(added).toMatchObject({ selfJoin: "linked", silent: true, introText: null });
  expect(await org(db, EN_ORG)).toMatchObject({ approvalStatus: "pending", whatsappBotEnabled: false, whatsappGroupId: null });
  const ask = await jobsTo(db, E2E.APPROVER_PHONE);
  expect(ask.map((j) => j.purpose)).toEqual(["owner-approval"]);
  expect(ask[0].text).toContain("Reply APPROVE 7KQ2 or REJECT 7KQ2");

  // Nothing is due in the group while pending.
  const pendingPoll = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(EN_GROUP)}`, { headers: PI });
  expect(pendingPoll.status()).toBe(404);

  // 3. The owner replies from their own phone, in lower case.
  const decision = await dm(request, E2E.APPROVER_PHONE, "approve 7kq2");
  expect(decision).toMatchObject({ handled: "approver-dm", result: "approved" });

  const o = await org(db, EN_ORG);
  expect(o).toMatchObject({
    approvalStatus: "approved",
    whatsappBotEnabled: true,
    whatsappGroupId: EN_GROUP,
    approvalDecidedBy: `whatsapp:${E2E.APPROVER_PHONE}`,
  });
  expect(o?.approvedAt).not.toBeNull();
  expect(
    await db.one(`SELECT status FROM "ClubConnect" WHERE id = 'e2e-sj7-en'`),
  ).toEqual({ status: "closed" });

  // The roster from the add's snapshot.
  const members = await db.all<{ phoneNumber: string }>(
    `SELECT u."phoneNumber" FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE m."orgId" = $1 ORDER BY u."phoneNumber"`,
    [EN_ORG],
  );
  expect(members.map((m) => m.phoneNumber)).toEqual([`+${ALI_PHONE}`, `+${BEN_PHONE}`, `+${CEM_PHONE}`]);

  // The owner's one-line ack; the organiser's "you're live" DM.
  const owner = await jobsTo(db, E2E.APPROVER_PHONE);
  expect(owner.map((j) => [j.purpose, j.text])).toEqual([
    ["owner-approval", ask[0].text],
    ["owner-ack", "Approved Riverside FC. The hello goes out in the group within a few minutes."],
  ]);
  const organiser = await jobsTo(db, ALI_PHONE);
  expect(organiser.at(-1)).toMatchObject({ purpose: "organiser-decision", refId: "e2e-sj7-en:approved" });
  // A short checklist, each item with its own signed-in link (2026-10-01).
  const live = organiser.at(-1)?.text ?? "";
  expect(live).toMatch(/^Good news: Riverside FC is live\. I've said hello in "Riverside Tuesday 5s"\.\n\n/);
  expect(live).toMatch(/📅 \*Your weekly game:\*[^\n]*\nhttp\S+\n/);
  expect(live).toMatch(/⭐ \*Starting ratings:\*[^\n]*\nhttp\S+\n/);
  expect(live).toMatch(/⚙️ \*Settings:\*[^\n]*\nhttp\S+\n/);
  expect(live).toContain("*help payments* or *help badges*");
  // Club fee billing (slice B2): the suite runs with BILLING_ENABLED on, so
  // the approval started the club's free month (through the one writer,
  // on real Postgres with its CHECK constraints) and the DM follows the
  // free-month sentence with the club fee tip. With the flag off the DM
  // ends on that sentence (unit-pinned in club-decisions.test.ts).
  expect(live).toMatch(/Your first month is free\.\n\n💷 \*Club fee tip:\* after that MatchTime only charges for the games you play, up to £9\.99 a month for the group/);
  expect(live).not.toMatch(/[—–]/);
  expect(await db.one(`SELECT "billingStatus","billingPlan" FROM "Organisation" WHERE id = $1`, [EN_ORG])).toEqual({
    billingStatus: "trial",
    billingPlan: "standard",
  });
  const trial = await db.one<{ start: string; ends: string; approved: string }>(
    `SELECT cb."trialStartedAt"::text AS start, cb."trialEndsAt"::text AS ends, o."approvedAt"::text AS approved
       FROM "ClubBilling" cb JOIN "Organisation" o ON o.id = cb."orgId" WHERE cb."orgId" = $1`,
    [EN_ORG],
  );
  // The free month starts at the approval and runs 30 days.
  expect(trial?.start).toBe(trial?.approved);
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1 AND "trialEndsAt" = "trialStartedAt" + interval '30 days'`,
      [EN_ORG],
    ),
  ).toBe(1);
  // Three distinct links, none of them a bare admin path.
  const urls = live.match(/^http\S+$/gm) ?? [];
  expect(new Set(urls).size).toBe(3);

  // 4. The Pi now serves the group, and it is no longer silent.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: ON })).json();
  expect(orgs.orgs.map((x: { whatsappGroupId: string }) => x.whatsappGroupId)).toContain(EN_GROUP);
  expect(orgs.silentGroups).not.toContain(EN_GROUP);

  // 5. The first thing MatchTime says in the group is the hello.
  const poll = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(EN_GROUP)}`, { headers: PI });
  expect(poll.status()).toBe(200);
  const { instructions } = await poll.json();
  const groupPosts = instructions.filter((i: { kind: string }) => i.kind === "group-message" || i.kind === "group-poll");
  expect(groupPosts).toHaveLength(1);
  expect(groupPosts[0].text).toBe(hello("en")({ organiser: "Ali" }));
  expect(groupPosts[0].text).toContain("Ali has set me up to run this group's games.");
  expect(instructions[0]).toBe(groupPosts[0]);

  // 6. The platform channel hands the Pi the organiser's DM and the ack.
  const { jobs } = await (await request.get("/api/whatsapp/platform-jobs", { headers: ON })).json();
  const purposes = jobs.map((j: { purpose?: string }) => j.purpose);
  expect(purposes).toEqual(expect.arrayContaining(["organiser-decision", "owner-ack"]));
});

test("the same APPROVE forwarded twice acks once; a new APPROVE says it was already approved", async ({ request, db }) => {
  const before = (await jobsTo(db, E2E.APPROVER_PHONE)).length;
  await dm(request, E2E.APPROVER_PHONE, "APPROVE 7KQ2", ON, "e2e-sj7-dup");
  const twice = await dm(request, E2E.APPROVER_PHONE, "APPROVE 7KQ2", ON, "e2e-sj7-dup");
  expect(twice).toMatchObject({ handled: "approver-dm", result: "already" });
  const after = await jobsTo(db, E2E.APPROVER_PHONE);
  expect(after).toHaveLength(before + 1);
  expect(after.at(-1)?.text).toMatch(/^Riverside FC was already approved on \d{1,2} \w+ at \d{2}:\d{2}\.$/);
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [EN_ORG])).toBe(1);
});

test("a non-approver's APPROVE is ignored: nothing decided, nothing sent", async ({ request, db }) => {
  await botAdded(request, {
    groupId: X_GROUP,
    groupSubject: "Hackney Weds",
    addedByPhone: HAL_PHONE,
    participants: [{ phone: HAL_PHONE, pushname: "Hal" }],
  });
  expect((await org(db, X_ORG))?.approvalStatus).toBe("pending");
  const jobsBefore = await db.count(`SELECT COUNT(*) FROM "PlatformJob"`);

  for (const phone of [HAL_PHONE, ALI_PHONE, "447700900999"]) {
    const r = await dm(request, phone, "APPROVE 4HCW");
    expect(r).toEqual({ ok: true, handled: "approver-dm", result: "not-approver" });
  }
  expect(await org(db, X_ORG)).toMatchObject({ approvalStatus: "pending", whatsappBotEnabled: false, whatsappGroupId: null });
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob"`)).toBe(jobsBefore);
});

test("flag OFF: the owner's APPROVE is not read as a decision", async ({ request, db }) => {
  const r = await dm(request, E2E.APPROVER_PHONE, "APPROVE 4HCW", KEY);
  expect(r.handled).not.toBe("approver-dm");
  expect((await org(db, X_ORG))?.approvalStatus).toBe("pending");
});

test("REJECT by DM: leaves the group silently, one polite Turkish DM to the organiser, no hello", async ({ request, db }) => {
  await botAdded(request, {
    groupId: TR_GROUP,
    groupSubject: "Cuma Halı Saha",
    addedByPhone: AYSE_PHONE,
    participants: [{ phone: AYSE_PHONE, pushname: "Ayşe" }],
  });
  expect((await org(db, TR_ORG))?.approvalStatus).toBe("pending");

  // Two clubs wait now: a bare REJECT decides nothing and lists them.
  const bare = await dm(request, E2E.APPROVER_PHONE, "REJECT");
  expect(bare).toMatchObject({ result: "ambiguous" });
  expect((await jobsTo(db, E2E.APPROVER_PHONE)).at(-1)?.text).toBe(
    "Two clubs are waiting: 4HCW Hackney Weds, 9XT4 Kartallar. Reply APPROVE and the ref.",
  );

  const r = await dm(request, E2E.APPROVER_PHONE, "reject 9xt4");
  expect(r).toMatchObject({ result: "rejected" });
  expect(await org(db, TR_ORG)).toMatchObject({ approvalStatus: "rejected", whatsappBotEnabled: false, whatsappGroupId: null });
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [TR_ORG])).toBe(0);
  expect(
    await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1 AND status = 'queued'`, [TR_GROUP]),
  ).toBe(1);
  expect((await jobsTo(db, AYSE_PHONE)).at(-1)).toMatchObject({
    purpose: "organiser-decision",
    text: 'MatchTime\'ı denediğiniz için teşekkürler. "Cuma Halı Saha" grubunu şu an alamıyoruz, bu yüzden gruptan ayrıldım. Bu değişirse size haber vereceğiz.',
  });
  expect((await jobsTo(db, E2E.APPROVER_PHONE)).at(-1)?.text).toBe("Rejected Kartallar. Leaving the group now.");

  // The group stays silent for the Pi.
  const orgs = await (await request.get("/api/whatsapp/orgs", { headers: ON })).json();
  expect(orgs.silentGroups).toContain(TR_GROUP);
});

test("cap 8: a new club's member DMs stop at 20 a day; Sutton FC is never capped", async ({ request, db }) => {
  // Riverside (approved above, day 0) has already had 20 DMs claimed today.
  for (let i = 0; i < 20; i++) {
    await db.run(`INSERT INTO "SentNotification" (id,key,kind,"createdAt") VALUES ($1,$2,'dm',now())`, [
      `e2e-sj7-sn-${i}`,
      `org-${EN_ORG}:e2e-dm-${i}`,
    ]);
  }
  await db.run(`INSERT INTO "BotJob" (id,"orgId",kind,phone,text) VALUES ('e2e-sj7-dm-new',$1,'dm',$2,'hello Ben')`, [
    EN_ORG,
    BEN_PHONE,
  ]);
  const held = await (await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(EN_GROUP)}`, { headers: PI })).json();
  expect(held.instructions.map((i: { key: string }) => i.key)).not.toContain("botjob-e2e-sj7-dm-new");

  // The same backlog on the seeded approved club (approvedAt NULL) goes out.
  for (let i = 0; i < 20; i++) {
    await db.run(`INSERT INTO "SentNotification" (id,key,kind,"createdAt") VALUES ($1,$2,'dm',now())`, [
      `e2e-sj7-sn-s-${i}`,
      `org-${ORG_ID}:e2e-dm-${i}`,
    ]);
  }
  await db.run(`INSERT INTO "BotJob" (id,"orgId",kind,phone,text) VALUES ('e2e-sj7-dm-sutton',$1,'dm',$2,'hello')`, [
    ORG_ID,
    BEN_PHONE,
  ]);
  const sutton = await (await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, { headers: PI })).json();
  expect(sutton.instructions.map((i: { key: string }) => i.key)).toContain("botjob-e2e-sj7-dm-sutton");
});
