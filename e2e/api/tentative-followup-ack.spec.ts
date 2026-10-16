/**
 * THE TENTATIVE FOLLOW-UP ACK IS BUILT FROM THE ROW, END TO END (2026-10-16).
 *
 * FNF incident: Naim said "maybe", MatchTime DMed him the 24h follow-up,
 * and he answered "IN" by DM. FNF is an organiser-pick club, so the write
 * (`registerAttendance`, sourceRef `dm:tentative-followup`) put him on the
 * BENCH with the note "organiser picks who plays", and the organisers were
 * shown him on the waiting list. The DM he got back said
 * "✅ Brilliant, you're in! See you there ⚽", two minutes before an
 * organiser picked him. The dm-reply route built that ack from his ANSWER
 * ("in") and never looked at the status the write returned.
 *
 * Drives the real route against Postgres, one club per pick mode:
 *   1. organiser-pick, a place free, no offer running: IN lands on the
 *      bench and the ack says bench and "the organisers pick who plays";
 *   2. first-come, squad full: IN lands on the bench and the ack says the
 *      squad is full, not "you're in";
 *   3. first-come, a place free: IN is CONFIRMED and the ack is unchanged.
 *
 * Deterministic: "IN" is read by the fast path, no model is called.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** Friday 15 January 2027, 20:30 GMT: far enough ahead to be the next match. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");

interface Club {
  org: string;
  group: string;
  match: string;
  pickMode: "organiser" | "first-come";
  /** CONFIRMED rows already in the squad of 4. */
  confirmed: number;
  /** The player who said maybe and now answers. */
  player: { id: string; phone: string };
}

const CLUBS = {
  organiser: {
    org: "e2e-tfa-op",
    group: "e2e-tfa-op@g.us",
    match: "e2e-tfa-op-match",
    pickMode: "organiser",
    confirmed: 3,
    player: { id: "e2e-tfa-op-naim", phone: "+447700951000" },
  },
  firstComeFull: {
    org: "e2e-tfa-fcf",
    group: "e2e-tfa-fcf@g.us",
    match: "e2e-tfa-fcf-match",
    pickMode: "first-come",
    confirmed: 4,
    player: { id: "e2e-tfa-fcf-pl", phone: "+447700952000" },
  },
  firstComeRoom: {
    org: "e2e-tfa-fcr",
    group: "e2e-tfa-fcr@g.us",
    match: "e2e-tfa-fcr-match",
    pickMode: "first-come",
    confirmed: 2,
    player: { id: "e2e-tfa-fcr-pl", phone: "+447700953000" },
  },
} satisfies Record<string, Club>;

async function seedClub(db: TestDb, c: Club) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "benchPickMode", "updatedAt")
     VALUES ($1, $1, $1, $1 || '-invite', $2, true, $3, now())`,
    [c.org, c.group, c.pickMode],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1 || '-sport', $1, 'Football 2-a-side', 2, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [c.org],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1 || '-act', $1, $1 || '-sport', 'Friday 9-a-side', 5, '20:30', 'Goals', 1, now())`,
    [c.org],
  );
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2 || '-act', $3, 4, 'UPCOMING', $4, now())`,
    [c.match, c.org, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 3600_000).toISOString()],
  );
  const users = [
    ...Array.from({ length: c.confirmed }, (_, i) => ({ id: `${c.org}-sq${i}`, phone: `${c.player.phone.slice(0, -1)}${i + 1}` })),
    c.player,
  ];
  for (const u of users) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $1 || '@e2e.test', $1, $2, now())`, [
      u.id,
      u.phone,
    ]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1 || '-mem', $1, $2, 'PLAYER')`, [u.id, c.org]);
  }
  for (let i = 0; i < c.confirmed; i++) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1 || '-att', $2, $1, 'CONFIRMED', $3, now())`,
      [`${c.org}-sq${i}`, c.match, i + 1],
    );
  }
  // He said maybe, and the follow-up DM has already gone out.
  await db.run(
    `INSERT INTO "TentativeAvailability" (id, "matchId", "userId", "dueAt", "notifiedAt", "updatedAt")
     VALUES ($1 || '-tent', $2, $1, now(), now(), now())`,
    [c.player.id, c.match],
  );
}

let n = 0;
async function answer(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone: phone.replace(/^\+/, ""), body, waMessageId: `e2e-tfa-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const statusOf = async (db: TestDb, c: Club) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [c.match, c.player.id]))
    ?.status;

const lastDm = async (db: TestDb, c: Club) =>
  (
    await db.one<{ text: string }>(
      `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt" DESC LIMIT 1`,
      [c.org, c.player.phone.replace(/^\+/, "")],
    )
  )?.text;

test.beforeAll(async ({ db }) => {
  resetDb();
  for (const c of Object.values(CLUBS)) await seedClub(db, c);
});

test.afterAll(() => {
  resetDb();
});

test("organiser-pick club: an IN to the follow-up goes on the bench and is told so, never 'you're in'", async ({ request, db }) => {
  const c = CLUBS.organiser;
  const json = await answer(request, c.player.phone, "IN");
  expect(json.handled).toBe("tentative-followup");
  expect(json.status).toBe("BENCH");
  expect(await statusOf(db, c)).toBe("BENCH");

  const ack = await lastDm(db, c);
  expect(ack).toBeTruthy();
  expect(ack).not.toContain("you're in");
  expect(ack).not.toContain("Brilliant");
  expect(ack).toContain("bench");
  expect(ack).toContain("organisers pick who plays");
});

test("first-come club, squad full: an IN to the follow-up goes on the bench and is told the squad is full", async ({ request, db }) => {
  const c = CLUBS.firstComeFull;
  const json = await answer(request, c.player.phone, "IN");
  expect(json.status).toBe("BENCH");
  expect(await statusOf(db, c)).toBe("BENCH");

  const ack = await lastDm(db, c);
  expect(ack).not.toContain("you're in");
  expect(ack).toContain("full");
  expect(ack).toContain("bench");
});

test("first-come club, a place free: an IN to the follow-up is CONFIRMED and keeps today's ack", async ({ request, db }) => {
  const c = CLUBS.firstComeRoom;
  const json = await answer(request, c.player.phone, "IN");
  expect(json.status).toBe("CONFIRMED");
  expect(await statusOf(db, c)).toBe("CONFIRMED");
  expect(await lastDm(db, c)).toBe("✅ Brilliant, you're in! See you there ⚽");
});
