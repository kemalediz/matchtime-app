/**
 * /api/whatsapp/reaction — a 👍 or 👎 on the RECRUIT INVITE DM.
 *
 * The invite now says "Playing? Reply *IN* or tap 👍 … Can't make it?
 * Reply *OUT* or tap 👎". This spec proves the tap actually does
 * something, end to end against the real route and the real DB:
 * the reaction resolves to the right player and match, the attendance
 * write lands, the player gets an honest personal ack, and the group is
 * told once (and only once).
 *
 * The chain under test is built the way production builds it: a BotJob
 * for the DM, the `botjob-<id>` claim row with a waMessageId stamped by
 * /ack, and the `recruit-dm-job:<id>` link row written by the recruit
 * blast. See src/lib/recruit-reaction.ts.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, ORG_ID, PHONE, MATCH } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const bare = (p: string) => p.replace(/^\+/, "");

/** Queue an invite DM exactly as `inviteRecentPlayers` does, then stamp
 *  it with a WhatsApp message id the way /ack does on delivery. */
async function seedInvite(
  db: TestDb,
  opts: { jobId: string; waMessageId: string; userId: string; phone: string },
): Promise<void> {
  await db.run(
    `INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "pollOptions", "pollMulti", "sentAt", "createdAt")
     VALUES ($1, $2, 'dm', $3, 'invite', ARRAY[]::text[], false, now(), timezone('UTC', now()) - interval '1 minute')`,
    [opts.jobId, ORG_ID, opts.phone],
  );
  // The dispatch claim row (created by /due-posts), with the id /ack stamps.
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "waMessageId", "createdAt")
     VALUES ($1, $2, 'dm', $3, timezone('UTC', now()))`,
    [`sn-${opts.jobId}`, `botjob-${opts.jobId}`, opts.waMessageId],
  );
  // The link row (created by the recruit blast) — matchId + targetUser.
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "createdAt")
     VALUES ($1, $2, 'recruit-dm-link', $3, $4, timezone('UTC', now()))`,
    [`sn-link-${opts.jobId}`, `recruit-dm-job:${opts.jobId}`, MATCH.upcoming, opts.userId],
  );
}

async function react(
  request: APIRequestContext,
  body: { waMessageId: string; emoji: string; fromPhone: string },
) {
  const res = await request.post("/api/whatsapp/reaction", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { ...body, fromAuthorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const status = (db: TestDb, userId: string) =>
  db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );

/** Only the OUT-OF-BAND lines. `registerAttendance` queues its own
 *  "squad complete" post, which is existing behaviour and not what this
 *  spec is about. */
const groupPosts = (db: TestDb) =>
  db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'
       AND text LIKE '%on their invite%' ORDER BY "createdAt" ASC`,
    [ORG_ID],
  );

const lastDmTo = (db: TestDb, phone: string) =>
  db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2
     ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID, bare(phone)],
  );

const WA = {
  fresh: "true_447700900009@c.us_REACT1",
  extra: "true_447700900010@c.us_REACT2",
};

test("👍 on the invite DM registers the player and tells the group once", async ({
  request,
  db,
}) => {
  await seedInvite(db, {
    jobId: "job-fresh",
    waMessageId: WA.fresh,
    userId: U.fresh,
    phone: bare(PHONE.fresh),
  });

  const json = await react(request, { waMessageId: WA.fresh, emoji: "👍", fromPhone: bare(PHONE.fresh) });

  expect(json.handled).toBe("recruit-dm-reaction");
  expect(json.decision).toBe("in");
  expect(json.status).toBe("CONFIRMED");
  expect(json.matchId).toBe(MATCH.upcoming);

  // The write actually landed — the ack is only honest because of this.
  expect((await status(db, U.fresh))?.status).toBe("CONFIRMED");

  // The player hears back personally.
  expect((await lastDmTo(db, PHONE.fresh))?.text).toContain("You're in");

  // …and the group, which could not otherwise see a 1-1 reaction.
  const posts = await groupPosts(db);
  expect(posts.length).toBe(1);
  expect(posts[0].text).toContain("is IN");
  expect(posts[0].text).toContain("👍");
});

test("a repeat 👍 is a NO-OP: no second registration, no second group post", async ({
  request,
  db,
}) => {
  const before = (await groupPosts(db)).length;

  const json = await react(request, { waMessageId: WA.fresh, emoji: "👍", fromPhone: bare(PHONE.fresh) });

  expect(json.status).toBe("CONFIRMED");
  expect(json.announced).toBe(false);
  expect((await groupPosts(db)).length).toBe(before);
});

test("a 👍 when the squad is FULL goes to the bench, never a rollover", async ({
  request,
  db,
}) => {
  // The fixture match is maxPlayers 5 and the test above took the 5th slot.
  await seedInvite(db, {
    jobId: "job-extra",
    waMessageId: WA.extra,
    userId: U.extra,
    phone: bare(PHONE.extra),
  });

  const json = await react(request, { waMessageId: WA.extra, emoji: "👍", fromPhone: bare(PHONE.extra) });

  expect(json.decision).toBe("in");
  expect(json.status).toBe("BENCH");
  expect((await status(db, U.extra))?.status).toBe("BENCH");
  expect((await lastDmTo(db, PHONE.extra))?.text.toLowerCase()).toContain("bench");
  // Still the SAME match — a full squad must not roll anyone forward.
  expect(json.matchId).toBe(MATCH.upcoming);
});

test("👎 registers OUT — saying no is as easy as saying yes", async ({ request, db }) => {
  const before = (await groupPosts(db)).length;

  const json = await react(request, { waMessageId: WA.fresh, emoji: "👎", fromPhone: bare(PHONE.fresh) });

  expect(json.decision).toBe("out");
  expect(json.status).toBe("DROPPED");
  expect((await status(db, U.fresh))?.status).toBe("DROPPED");
  expect((await lastDmTo(db, PHONE.fresh))?.text.toLowerCase()).toContain("marked out");

  const posts = await groupPosts(db);
  expect(posts.length).toBe(before + 1);
  expect(posts[posts.length - 1].text).toContain("is OUT");
  expect(posts[posts.length - 1].text).toContain("👎");
});

test("an unrelated emoji is ignored — a ❤️ on the invite is not an answer", async ({
  request,
  db,
}) => {
  const before = (await groupPosts(db)).length;

  const json = await react(request, { waMessageId: WA.fresh, emoji: "❤️", fromPhone: bare(PHONE.fresh) });

  expect(json.ignored).toBe("not-yes-no");
  expect((await status(db, U.fresh))?.status).toBe("DROPPED"); // unchanged
  expect((await groupPosts(db)).length).toBe(before);
});

test("a reaction on a message that is NOT an invite DM is ignored", async ({ request, db }) => {
  const before = (await groupPosts(db)).length;

  const json = await react(request, {
    waMessageId: "true_447700900003@c.us_SOMETHINGELSE",
    emoji: "👍",
    fromPhone: bare(PHONE.player),
  });

  expect(json.ignored).toBe("no-open-offer");
  expect(await status(db, U.player)).toEqual({ status: "CONFIRMED" }); // untouched
  expect((await groupPosts(db)).length).toBe(before);
});
