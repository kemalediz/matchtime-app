/**
 * WHO ANNOUNCES THE LIST AND TEAMS, END TO END AGAINST POSTGRES (2026-10-14).
 *
 * `Organisation.listAnnouncer` (src/lib/list-announcer.ts), driven through
 * the real /api/whatsapp/due-posts with the test clock (`x-test-now`). No
 * model is called: the organisers' update is fixed text, and the default
 * club's 17:00 post takes the static full-squad branch.
 *
 * Two Friday 20:30 clubs, no weekly deadlines:
 *   O  "The organisers", an admin group linked
 *   M  "MatchTime" (the default, Sutton's shape)
 *
 *   1. Mon 17:05, a Pi that can post in admin groups: O's 17:00 squad goes
 *      to its admin group on the post's own key, and nothing to its
 *      players' group; once claimed, a later poll sends nothing again.
 *   2. Mon 17:05, an older Pi: O's squad goes to the owner by DM.
 *   3. M's 17:00 post goes to its players' group, as it always has.
 *
 * January, so London is GMT and London times equal UTC.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** Friday 15 January 2027, 20:30 GMT. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
const MON_1705 = new Date("2027-01-11T17:05:00.000Z");
const MON_1715 = new Date("2027-01-11T17:15:00.000Z");

const O_GROUP = "e2e-oa-org@g.us";
const O_HQ = "e2e-oa-hq@g.us";
const M_GROUP = "e2e-oa-mt@g.us";
const O_MATCH = "e2e-oa-o-match";
const M_MATCH = "e2e-oa-m-match";
const O_OWNER_PHONE = "+447700930001";

async function club(db: TestDb, key: string, group: string, organisers: boolean): Promise<void> {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
                                 "listAnnouncer", "adminChannelMode", "adminGroupId", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, now())`,
    [
      `e2e-oa-org-${key}`,
      `FNF ${key}`,
      `e2e-oa-${key}`,
      `e2e-oa-invite-${key}`,
      group,
      organisers ? "organisers" : "matchtime",
      organisers ? "admin-group" : "one-person",
      organisers ? O_HQ : null,
    ],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football 9-a-side', 9, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [`e2e-oa-sport-${key}`, `e2e-oa-org-${key}`],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'FNF', 5, '20:30', 'Powerleague', 5, now())`,
    [`e2e-oa-act-${key}`, `e2e-oa-org-${key}`, `e2e-oa-sport-${key}`],
  );
}

async function member(db: TestDb, key: string, userId: string, name: string, phone: string, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    userId,
    `${userId}@e2e.test`,
    name,
    phone,
  ]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [
    `e2e-oa-mem-${userId}`,
    userId,
    `e2e-oa-org-${key}`,
    role,
  ]);
}

async function attend(db: TestDb, matchId: string, userId: string, position: number) {
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', $4, now())`,
    [`e2e-oa-att-${matchId}-${userId}`, matchId, userId, position],
  );
}

async function match(db: TestDb, key: string, id: string, maxPlayers: number) {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2, $3, $4, 'UPCOMING', $5, now())`,
    [id, `e2e-oa-act-${key}`, KICKOFF.toISOString(), maxPlayers, new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
}

type Instr = { key: string; kind: string; text?: string; groupId?: string; phone?: string };

async function duePosts(
  request: APIRequestContext,
  group: string,
  now: Date,
  opts: { preview: boolean; adminGroupPi: boolean },
): Promise<Instr[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(group)}`, {
    headers: {
      "x-api-key": E2E.WHATSAPP_API_KEY,
      "x-test-now": now.toISOString(),
      ...(opts.preview ? { "x-no-claim": "1" } : {}),
      ...(opts.adminGroupPi ? { "x-mt-pi-caps": "admin-group" } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { instructions: Instr[] }).instructions;
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await club(db, "o", O_GROUP, true);
  await member(db, "o", "e2e-oa-hamzah", "Hamzah Khan", O_OWNER_PHONE, "OWNER");
  await member(db, "o", "e2e-oa-raihan", "Raihan Ahmed", "+447700930002");
  await member(db, "o", "e2e-oa-wasim", "Wasim Ali", "+447700930003");
  await match(db, "o", O_MATCH, 18);
  await attend(db, O_MATCH, "e2e-oa-hamzah", 1);
  await attend(db, O_MATCH, "e2e-oa-raihan", 2);
  await attend(db, O_MATCH, "e2e-oa-wasim", 3);

  await club(db, "m", M_GROUP, false);
  await member(db, "m", "e2e-oa-sam", "Sam Sutton", "+447700930011", "OWNER");
  await member(db, "m", "e2e-oa-sid", "Sid Sutton", "+447700930012");
  // A FULL squad, so the 17:00 post is the static branch.
  await match(db, "m", M_MATCH, 2);
  await attend(db, M_MATCH, "e2e-oa-sam", 1);
  await attend(db, M_MATCH, "e2e-oa-sid", 2);
});

test.afterAll(() => resetDb());

/** Players' group posts that name a player. (The one-time introduction a
 *  club gets before self-join approval names nobody and is not a list.) */
const namesInPlayersGroup = (out: Instr[]) =>
  out.filter((i) => i.kind === "group-message" && /Hamzah|Raihan|Wasim/.test(i.text ?? ""));

const SQUAD_TEXT = [
  "📋 *Squad for FNF, Fri 15 Jan at 20:30*: 3 of 18 in, 15 spaces.",
  "",
  "*Confirmed (3/18):*",
  "1. Hamzah Khan",
  "2. Raihan Ahmed",
  "3. Wasim Ali",
  "",
  "MatchTime has not posted this in the players' group: you announce the list and the teams.",
].join("\n");

test("an older Pi: the organisers' squad goes to the owner by DM, nothing to the players' group", async ({ request }) => {
  const out = await duePosts(request, O_GROUP, MON_1705, { preview: true, adminGroupPi: false });
  const evening = out.filter((i) => i.key.startsWith(`${O_MATCH}:evening-update:`));
  expect(evening).toEqual([
    expect.objectContaining({
      kind: "dm",
      key: `${O_MATCH}:evening-update:2027-01-11:e2e-oa-hamzah`,
      phone: O_OWNER_PHONE.replace(/^\+/, ""),
      text: SQUAD_TEXT,
    }),
  ]);
  expect(namesInPlayersGroup(out)).toEqual([]);
});

test("a Pi that posts in admin groups: the squad goes to the admin group, once", async ({ request, db }) => {
  const out = await duePosts(request, O_GROUP, MON_1705, { preview: false, adminGroupPi: true });
  const evening = out.filter((i) => i.key.startsWith(`${O_MATCH}:evening-update:`));
  expect(evening).toEqual([
    expect.objectContaining({
      kind: "admin-group-message",
      key: `${O_MATCH}:evening-update:2027-01-11`,
      groupId: O_HQ,
      text: SQUAD_TEXT,
    }),
  ]);
  expect(namesInPlayersGroup(out)).toEqual([]);
  expect(
    await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`${O_MATCH}:evening-update:2027-01-11`]),
  ).toBe(1);

  const again = await duePosts(request, O_GROUP, MON_1715, { preview: false, adminGroupPi: true });
  expect(again.filter((i) => i.key.includes(":evening-update:"))).toEqual([]);
});

test("MatchTime announces (the default): the 17:00 post is in the players' group, as before", async ({ request }) => {
  const out = await duePosts(request, M_GROUP, MON_1705, { preview: true, adminGroupPi: true });
  const evening = out.filter((i) => i.key === `${M_MATCH}:evening-update:2027-01-11`);
  expect(evening).toHaveLength(1);
  expect(evening[0].kind).toBe("group-message");
  expect(evening[0].text).toContain("Sam Sutton");
  expect(out.some((i) => i.kind === "admin-group-message")).toBe(false);
});
