/**
 * SELF-JOIN: THE GROUP DESCRIPTION IS CAPTURED AT THE ADD (2026-10-12),
 * against a real Postgres and the real routes.
 *
 * The Pi sends the group's WhatsApp description with the add. The server
 * masks numbers out of it (bank details, phone numbers) BEFORE it writes
 * anything, and keeps the masked text on the connect request, beside the
 * captured chat, in `ClubConnect.capturedDescription`. Nothing reads it
 * yet. It is deleted wherever the chat is deleted: when MatchTime is
 * removed, when the club is rejected, once the learned setup has read the
 * chat, and by the 7-day expiry. A re-add may supply it when none is
 * stored and never replaces one.
 *
 * The rules of the masking are unit-tested in
 * src/lib/__tests__/group-description.test.ts. Deterministic end to end:
 * nothing here calls a model (the one learned-setup sweep is handed a
 * stub).
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };
const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };

const CLUB = "e2e-sjd-riverside";
const ALI = "e2e-sjd-ali";
const ALI_PHONE = "447700900951";
const BEN_PHONE = "447700900952";
const REQ = "e2e-sjd-req";
const GROUP = "120363700000000051@g.us";
const MEMBERS = [
  { phone: ALI_PHONE, pushname: "Ali" },
  { phone: BEN_PHONE, pushname: "Ben" },
];

const X = "[number removed]";
const DESC_RAW = [
  "Riverside Tuesday 5s. Tuesdays 20:30 to 21:30, 5 a side, £7 each.",
  "Pay Ali: sort 12-34-56 acc 12345678, or IBAN GB29 NWBK 6016 1331 9268 19.",
  "Problems: call 07700 900123.",
].join("\n");
const DESC_MASKED = [
  "Riverside Tuesday 5s. Tuesdays 20:30 to 21:30, 5 a side, £7 each.",
  `Pay Ali: sort ${X} acc ${X}, or IBAN ${X}.`,
  `Problems: call ${X}.`,
].join("\n");
/** What must never be found anywhere in the database. */
const SECRETS = ["12-34-56", "12345678", "NWBK", "1331 9268", "07700 900123", "900123"];

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

const stored = (db: TestDb, id: string = REQ) =>
  db.one<{ d: string | null; h: Array<{ text: string }> | null; status: string; removed: boolean }>(
    `SELECT "capturedDescription" AS d, "capturedHistory" AS h, status, "botRemovedAt" IS NOT NULL AS removed
       FROM "ClubConnect" WHERE id = $1`,
    [id],
  );

/** Every row of every table that could hold text about this add, as text. */
async function everythingStored(db: TestDb): Promise<string> {
  const parts: string[] = [];
  for (const table of ["ClubConnect", "PlatformJob", "UnsolicitedGroup", "Organisation", "ClubSetupLearning"]) {
    const rows = await db.all<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM "${table}" t`);
    parts.push(...rows.map((r) => r.j));
  }
  return parts.join("\n");
}

async function expectNoSecrets(db: TestDb) {
  const all = await everythingStored(db);
  for (const s of SECRETS) expect(all, `"${s}" must not be stored anywhere`).not.toContain(s);
}

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
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","updatedAt")
     VALUES ($1,$2,$3,$4,'7KD2','issued',now(),now() + interval '60 minutes',now())`,
    [REQ, CLUB, ALI, ALI_PHONE],
  );
});

test.afterAll(() => {
  resetDb();
});

test("the add links the club and stores the description MASKED; the numbers are nowhere in the database", async ({ request, db }) => {
  const dm = await request.post("/api/whatsapp/dm-reply", {
    headers: ON,
    data: { authorName: "Ali", waMessageId: `e2e-sjd-dm-${Date.now()}`, phone: ALI_PHONE, body: "Connect Riverside FC, code 7KD2" },
  });
  expect(dm.status(), await dm.text()).toBe(200);

  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    enrichmentHistory: chat("in for Tuesday", "me too"),
    groupDescription: DESC_RAW,
  });
  // The Pi hears exactly what it heard before: nothing about the description.
  expect(json).toEqual({ ok: true, ignored: "self-join-pending", selfJoin: "linked", silent: true, introText: null });

  const row = await stored(db);
  expect(row?.status).toBe("group_linked");
  expect(row?.d).toBe(DESC_MASKED);
  expect(row?.h?.map((m) => m.text)).toEqual(["in for Tuesday", "me too"]);
  await expectNoSecrets(db);

  // Nobody is told what it says: not the owner, not the organiser.
  const jobs = await db.all<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE kind = 'dm'`);
  expect(jobs.length).toBeGreaterThan(0);
  for (const j of jobs) {
    expect(j.text).not.toContain("Tuesdays 20:30");
    expect(j.text).not.toContain(X);
  }
});

test("the same add delivered again with a different description: the stored one is not replaced", async ({ request, db }) => {
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    groupDescription: "A retry must not replace it. Acc 87654321",
  });
  expect(json).toMatchObject({ selfJoin: "already-linked" });
  expect((await stored(db))?.d).toBe(DESC_MASKED);
  expect(await everythingStored(db)).not.toContain("87654321");
});

test("removed while pending: the description is deleted with the chat", async ({ request, db }) => {
  expect(await botRemoved(request, GROUP)).toMatchObject({ returnedToDraft: 1 });
  const row = await stored(db);
  expect(row).toMatchObject({ removed: true, d: null, h: null });
});

test("the organiser adds it back with NO description: linked again, and none is stored", async ({ request, db }) => {
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    enrichmentHistory: chat("second time round"),
  });
  expect(json).toMatchObject({ selfJoin: "linked" });
  const row = await stored(db);
  expect(row).toMatchObject({ status: "group_linked", removed: false, d: null });
  expect(row?.h?.map((m) => m.text)).toEqual(["second time round"]);
});

test("a later add with something that is not a description, or one far too long: still nothing stored, and no error", async ({
  request,
  db,
}) => {
  const base = { groupId: GROUP, groupSubject: "Riverside Tuesday 5s", addedByPhone: ALI_PHONE, participants: MEMBERS };
  const oversize = `Acc 12345678 ${"x".repeat(5000)}`;
  for (const groupDescription of [42, { text: "Acc 12345678" }, ["Acc 12345678"], "   \n ", oversize]) {
    const json = await botAdded(request, { ...base, groupDescription });
    expect(json).toMatchObject({ ok: true, selfJoin: "already-linked" });
    expect((await stored(db))?.d).toBeNull();
  }
  await expectNoSecrets(db);
});

test("a later add that brings one, when none is stored: filled in, masked, and the chat already stored is left alone", async ({
  request,
  db,
}) => {
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    enrichmentHistory: chat("a retry must not replace the stored chat"),
    groupDescription: `  ${DESC_RAW}  `,
  });
  expect(json).toMatchObject({ selfJoin: "already-linked" });
  const row = await stored(db);
  expect(row?.d).toBe(DESC_MASKED);
  expect(row?.h?.map((m) => m.text)).toEqual(["second time round"]);
  await expectNoSecrets(db);
});

test("removed and added back WITH a description: the relink stores what this add brought, masked", async ({ request, db }) => {
  expect(await botRemoved(request, GROUP)).toMatchObject({ returnedToDraft: 1 });
  expect(await stored(db)).toMatchObject({ d: null, h: null });
  const json = await botAdded(request, {
    groupId: GROUP,
    groupSubject: "Riverside Tuesday 5s",
    addedByPhone: ALI_PHONE,
    participants: MEMBERS,
    groupDescription: "New pitch from November. Ali 07700 900123",
  });
  expect(json).toMatchObject({ selfJoin: "linked" });
  expect((await stored(db))?.d).toBe(`New pitch from November. Ali ${X}`);
  await expectNoSecrets(db);
});

test("rejected: the description is deleted with the chat", async ({ request, db }) => {
  // Give the request chat as well, so both are seen to go.
  await db.run(`UPDATE "ClubConnect" SET "capturedHistory" = $2::jsonb WHERE id = $1`, [REQ, JSON.stringify(chat("in"))]);
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: ON,
    data: { phone: E2E.APPROVER_PHONE, body: "REJECT 7KD2", waMessageId: `e2e-sjd-reject-${Date.now()}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ result: "rejected" });
  expect(await stored(db)).toMatchObject({ status: "closed", d: null, h: null });
});

// ── The learned setup and the expiry, on seeded requests ────────────────

const rolling = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
) as { history: unknown[] };

const NOW = "2026-10-20T11:00:00Z";
const daysAgo = (d: number) => new Date(new Date(NOW).getTime() - d * 24 * 60 * 60 * 1000).toISOString();

type Seed = {
  id: string;
  n: number;
  status: "pending" | "approved";
  linkedDaysAgo: number;
  approvedHoursAgo?: number;
  chat: unknown[] | null;
  description: string | null;
};

async function seedLinked(db: TestDb, c: Seed) {
  const owner = `${c.id}-owner`;
  const phone = `44770090094${c.n}`;
  const approved = c.status === "approved";
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Steve Hart',$2,$3,true,true,now())`,
    [owner, `${owner}@e2e-test.invalid`, `+${phone}`],
  );
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","language","createdAt","updatedAt")
     VALUES ($1,'Tuesday Night 6s',$1,$2,$3,$4,$5,$6,'en',now(),now())`,
    [
      c.id,
      `${c.id}-invite`,
      c.status,
      approved ? new Date(new Date(NOW).getTime() - c.approvedHoursAgo! * 60 * 60 * 1000).toISOString() : null,
      approved ? `${c.id}@g.us` : null,
      approved,
    ],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${owner}-mem`, owner, c.id]);
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
       "capturedHistory","capturedDescription","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Tuesday Night 6s',$7,$9::jsonb,$10,now())`,
    [
      `${c.id}-cc`,
      c.id,
      owner,
      phone,
      `7KS${c.n}`,
      approved ? "closed" : "group_linked",
      daysAgo(c.linkedDaysAgo),
      `${c.id}@g.us`,
      c.chat ? JSON.stringify(c.chat) : null,
      c.description,
    ],
  );
}

const D = "Tuesdays 21:00, 6 a side, £6.";
const READ_ONCE: Seed = { id: "e2e-sjd-read", n: 1, status: "approved", linkedDaysAgo: 1, approvedHoursAgo: 2, chat: rolling.history, description: D };
const TOO_QUIET: Seed = { id: "e2e-sjd-quiet", n: 2, status: "approved", linkedDaysAgo: 1, approvedHoursAgo: 2, chat: null, description: D };
const OLD_BOTH: Seed = { id: "e2e-sjd-old-both", n: 3, status: "pending", linkedDaysAgo: 8, chat: [{ author: "A", text: "in", timestamp: daysAgo(9) }], description: D };
const OLD_DESC_ONLY: Seed = { id: "e2e-sjd-old-desc", n: 4, status: "pending", linkedDaysAgo: 8, chat: null, description: D };
const FRESH: Seed = { id: "e2e-sjd-fresh", n: 5, status: "pending", linkedDaysAgo: 6, chat: null, description: D };
const APPROVED_LONG_AGO: Seed = { id: "e2e-sjd-approved-old", n: 6, status: "approved", linkedDaysAgo: 9, approvedHoursAgo: 96, chat: null, description: D };

/** What the stubbed model answers: nothing found. No model is called. */
const NOTHING_FOUND = {
  regular_game: true,
  squad: { answer: "unclear", confidence: "low", evidence: [] },
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

async function cron(request: APIRequestContext, flag: "1" | "0") {
  const res = await request.get("/api/cron/learn-setup", {
    headers: {
      ...CRON,
      "x-test-now": NOW,
      "x-mt-test-setup-learning": flag,
      "x-mt-test-setup-learning-stub": JSON.stringify(NOTHING_FOUND),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{
    considered: number;
    outcomes: Array<{ orgId: string; outcome: { kind: string; reason?: string } }>;
    expired: { connectRequests: number; onboardingSessions: number };
  }>;
}

test("the 7-day expiry deletes the description with the chat, and a request holding ONLY a description expires too", async ({
  request,
  db,
}) => {
  for (const c of [READ_ONCE, TOO_QUIET, OLD_BOTH, OLD_DESC_ONLY, FRESH, APPROVED_LONG_AGO]) await seedLinked(db, c);

  // Learned setup switched OFF: only the expiry runs.
  const r = await cron(request, "0");
  expect(r.considered).toBe(0);
  expect(r.expired.connectRequests).toBe(3);

  expect(await stored(db, `${OLD_BOTH.id}-cc`)).toMatchObject({ d: null, h: null });
  expect(await stored(db, `${OLD_DESC_ONLY.id}-cc`)).toMatchObject({ d: null, h: null });
  // Approved four days ago: no sweep will ever read it.
  expect(await stored(db, `${APPROVED_LONG_AGO.id}-cc`)).toMatchObject({ d: null });
  // Linked 6 days ago: kept. Approved two hours ago: a sweep may still read it.
  expect((await stored(db, `${FRESH.id}-cc`))?.d).toBe(D);
  expect((await stored(db, `${READ_ONCE.id}-cc`))?.d).toBe(D);
  expect((await stored(db, `${TOO_QUIET.id}-cc`))?.d).toBe(D);

  // A second run finds nothing.
  expect((await cron(request, "0")).expired.connectRequests).toBe(0);
});

test("the learned setup reads the chat once and deletes the description with it, also when the chat was too short to read", async ({
  request,
  db,
}) => {
  const r = await cron(request, "1");
  const kinds = Object.fromEntries(r.outcomes.map((o) => [o.orgId, o.outcome.kind]));
  expect(kinds[READ_ONCE.id]).toBe("done");
  expect(kinds[TOO_QUIET.id]).toBe("skipped");

  expect(await stored(db, `${READ_ONCE.id}-cc`)).toMatchObject({ d: null, h: null });
  expect(await stored(db, `${TOO_QUIET.id}-cc`)).toMatchObject({ d: null, h: null });
  // Nothing READ the description: what the sweep recorded has none of it.
  const learned = await db.all<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM "ClubSetupLearning" t`);
  expect(learned.map((l) => l.j).join("\n")).not.toContain("6 a side");
  // The waiting club's is untouched by the sweep.
  expect((await stored(db, `${FRESH.id}-cc`))?.d).toBe(D);
});
