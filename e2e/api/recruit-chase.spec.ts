/**
 * /api/whatsapp/due-posts — the recruit CHASE-UP, end to end.
 *
 * The invite blast (`inviteRecentPlayers`) writes one
 * `<matchId>:recruit-dm:<userId>` SentNotification per player it DMs.
 * ~3h later the scheduler chases the ones who never answered, exactly
 * once. This spec seeds those invite rows by hand (the blast itself is
 * admin-triggered and covered elsewhere) and asserts the scheduler's
 * SELECTION through the real endpoint, in preview mode (`x-no-claim`) so
 * one window can be polled repeatedly.
 *
 * The upcoming fixture match is 4 confirmed out of 5, i.e. permanently
 * one short, which is the state the chase exists for.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, PHONE, ORG_ID, MATCH, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  targetUser?: string;
  text?: string;
  phone?: string;
}

const HOUR = 60 * 60 * 1000;
const chaseKey = (userId: string) => `${MATCH.upcoming}:recruit-chase:${userId}`;
const inviteKey = (userId: string) => `${MATCH.upcoming}:recruit-dm:${userId}`;

/** Noon today, London — inside the sociable window, well before the
 *  fixture match (+2 days) and its deadline. */
const NOON = londonAt(0, 12, 0);

async function duePostsAt(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    {
      headers: {
        "x-api-key": E2E.WHATSAPP_API_KEY,
        "x-test-now": now.toISOString(),
        "x-no-claim": "1",
      },
    },
  );
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  return (json.instructions ?? []) as Instruction[];
}

async function chaseKeysAt(request: APIRequestContext, now: Date): Promise<string[]> {
  const instructions = await duePostsAt(request, now);
  return instructions
    .map((i) => i.key)
    .filter((k): k is string => !!k && k.includes(":recruit-chase:"));
}

test.beforeAll(async () => {
  resetDb();
});

/**
 * Seed the invite rows. Everyone here was DM'd 4h before NOON, so the 3h
 * delay is up for all of them except Walt, who was invited 1h ago.
 *
 *   fresh  — silent. THE ONE we expect to chase.
 *   extra  — said "maybe" (TentativeAvailability).
 *   rater  — replied by DM (fingerprinted by the outbound ack BotJob).
 *   opt    — opted out of match-invite DMs.
 *   player — already CONFIRMED for this match (seeded).
 *   third  — answered in the group; the analyzer logged intent "out".
 *   guest  — silent, but has no phone number on file.
 *   walt   — silent, invited only 1h ago.
 */
test.beforeEach(async ({ db }) => {
  const invitedAt = new Date(NOON.getTime() - 4 * HOUR);
  const invitees: Array<[string, Date]> = [
    [U.fresh, invitedAt],
    [U.extra, invitedAt],
    [U.rater, invitedAt],
    [U.opt, invitedAt],
    [U.player, invitedAt],
    [U.third, invitedAt],
    [U.guest, invitedAt],
    [U.walt, new Date(NOON.getTime() - 1 * HOUR)],
  ];
  for (const [uid, at] of invitees) {
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "createdAt")
       VALUES ($1, $2, 'recruit-dm', $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET "createdAt" = EXCLUDED."createdAt"`,
      [`e2e-sn-invite-${uid}`, inviteKey(uid), MATCH.upcoming, uid, at],
    );
  }

  // Olivia asked not to be sent match invites (PR #8). The blast already
  // honours this; so must the chase.
  await db.run(
    `UPDATE "Membership" SET "subMatchInviteDm" = false, "subPrefsUpdatedAt" = now()
     WHERE "userId" = $1 AND "orgId" = $2`,
    [U.opt, ORG_ID],
  );

  // Zara said maybe.
  await db.run(
    `INSERT INTO "TentativeAvailability" (id, "matchId", "userId", "dueAt", "updatedAt")
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("matchId", "userId") DO NOTHING`,
    ["e2e-tent-extra", MATCH.upcoming, U.extra, new Date(NOON.getTime() + 24 * HOUR)],
  );

  // Riley replied to the invite by DM. Nothing logs an inbound DM, but
  // every dm-reply handler answers with an outbound DM BotJob — that ack
  // is the fingerprint the scheduler reads.
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "createdAt")
     VALUES ($1, $2, 'dm', $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      "e2e-botjob-rater-ack",
      ORG_ID,
      PHONE.rater.replace(/^\+/, ""),
      "👍 Noted. You weren't down for that one anyway, so nothing's changed.",
      new Date(NOON.getTime() - 2 * HOUR),
    ],
  );

  // Tom answered in the GROUP and the analyzer read it as an "out".
  await db.run(
    `INSERT INTO "AnalyzedMessage"
       (id, "waMessageId", "orgId", "groupId", "authorUserId", body, "handledBy", intent, "createdAt")
     VALUES ($1, $2, $3, $4, $5, 'cant do it this week lads', 'llm', 'out', $6)
     ON CONFLICT ("waMessageId") DO NOTHING`,
    [
      "e2e-am-third-out",
      "e2e-wa-third-out",
      ORG_ID,
      E2E.GROUP_ID,
      U.third,
      new Date(NOON.getTime() - 2 * HOUR),
    ],
  );
});

test("chases only the player who stayed completely silent", async ({ request }) => {
  const keys = await chaseKeysAt(request, NOON);
  expect(keys).toEqual([chaseKey(U.fresh)]);
});

test("the chase is a DM to that player, with the copy the owner asked for", async ({ request }) => {
  const instructions = await duePostsAt(request, NOON);
  const chase = instructions.find((i) => i.key === chaseKey(U.fresh));
  expect(chase?.kind).toBe("dm");
  expect(chase?.targetUser).toBe(U.fresh);
  expect(chase?.phone).toBe(PHONE.fresh.replace(/^\+/, ""));
  // 5-player squad with 4 confirmed = 1 still needed.
  expect(chase?.text).toContain("still after 1 player");
  expect(chase?.text).toMatch(/\*IN\*/);
  expect(chase?.text).toMatch(/\*OUT\*/);
  expect(chase?.text).toMatch(/stop asking/i);
  expect(chase?.text).not.toMatch(/[—–]/); // house style
  expect(chase?.text).not.toContain("/");
});

test("does NOT chase before the 3h delay is up", async ({ request }) => {
  // 2h after the invites went out — nobody is ripe yet.
  const keys = await chaseKeysAt(request, new Date(NOON.getTime() - 2 * HOUR));
  expect(keys).toEqual([]);
});

test("does NOT chase in the middle of the night", async ({ request }) => {
  // 03:00 London. Everyone invited 4h before noon is long past 3h, but
  // the sociable-hours gate must keep the bot quiet.
  const keys = await chaseKeysAt(request, londonAt(0, 3, 0));
  expect(keys).toEqual([]);
});

test("chases exactly once — a claimed chase is never re-emitted", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser")
     VALUES ($1, $2, 'dm', $3, $4)
     ON CONFLICT (key) DO NOTHING`,
    ["e2e-sn-chase-fresh", chaseKey(U.fresh), MATCH.upcoming, U.fresh],
  );
  const keys = await chaseKeysAt(request, NOON);
  expect(keys).toEqual([]);

  await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [chaseKey(U.fresh)]);
});

test("stops chasing the moment the player answers", async ({ request, db }) => {
  // Ian says IN through any route at all: an Attendance row appears.
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 5, now())
     ON CONFLICT ("matchId", "userId") DO NOTHING`,
    ["e2e-att-fresh-in", MATCH.upcoming, U.fresh],
  );
  const keys = await chaseKeysAt(request, NOON);
  expect(keys).toEqual([]);

  await db.run(`DELETE FROM "Attendance" WHERE id = $1`, ["e2e-att-fresh-in"]);
});

test("stops chasing when the squad has filled", async ({ request, db }) => {
  // A fifth player confirms, so there is nothing left to recruit for —
  // and Ian must not be asked to fill a spot that no longer exists.
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 5, now())
     ON CONFLICT ("matchId", "userId") DO NOTHING`,
    ["e2e-att-omar1-in", MATCH.upcoming, U.omar1],
  );
  const keys = await chaseKeysAt(request, NOON);
  expect(keys).toEqual([]);

  await db.run(`DELETE FROM "Attendance" WHERE id = $1`, ["e2e-att-omar1-in"]);
});

test("stops chasing once the attendance deadline has passed", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET "attendanceDeadline" = $1 WHERE id = $2`, [
    new Date(NOON.getTime() - 1 * HOUR),
    MATCH.upcoming,
  ]);
  const keys = await chaseKeysAt(request, NOON);
  expect(keys).toEqual([]);
});

test("never chases about a cancelled match", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET "attendanceDeadline" = $1, status = 'CANCELLED' WHERE id = $2`, [
    new Date(NOON.getTime() + 24 * HOUR),
    MATCH.upcoming,
  ]);
  const keys = await chaseKeysAt(request, NOON);
  expect(keys).toEqual([]);
});
