/**
 * /api/whatsapp/due-posts: the badge announcement post (2026-10-01).
 *
 * The rules are unit-tested in src/lib/__tests__/badge-announcements.test.ts.
 * This proves the wiring against a real database: the post is emitted at
 * 18:00 London two days after the match, once (claimed with its ledger
 * rows in one transaction, so the next poll has nothing), never from a
 * provisional MoM vote, never for badges earned before the club's first
 * post, never in preview mode's ledger, and never for a club that has the
 * feature off or is dormant.
 *
 * The seed's RATE match kicked off yesterday at 20:00 London with Riley,
 * Pat, Tom, Sam and Olivia confirmed. Two days after it is TOMORROW at
 * 18:00 London (`londonAt(1, 18, …)`).
 */
import { test, expect, resetDb } from "../fixtures";
import { U, NAME, ORG_ID, MATCH, ACTIVITY_ID, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  matchId?: string;
  text?: string;
  badgeLedger?: unknown;
}

const BADGES_KEY = `${MATCH.rate}:badges`;

async function poll(request: APIRequestContext, now: Date, previewOnly = false): Promise<Instruction[]> {
  const headers: Record<string, string> = {
    "x-api-key": E2E.WHATSAPP_API_KEY,
    "x-test-now": now.toISOString(),
  };
  if (previewOnly) headers["x-no-claim"] = "1";
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

const badgesPost = (ins: Instruction[]) => ins.find((i) => i.key === BADGES_KEY);

test.beforeEach(async () => {
  resetDb();
});

test("18:00 two days after the match: one badges post, claimed with its ledger, and not repeated on the next poll", async ({ request, db }) => {
  // Before 18:00 that day: nothing yet.
  expect(badgesPost(await poll(request, londonAt(1, 17, 30), true))).toBeUndefined();

  const first = await poll(request, londonAt(1, 18, 30));
  const post = badgesPost(first);
  expect(post?.kind).toBe("group-message");
  expect(post?.matchId).toBe(MATCH.rate);
  // The five who played are welcomed on one line.
  expect(post?.text).toContain("🏅 *New badges this week*");
  for (const k of ["rater", "player", "third", "stale", "opt"] as const) {
    expect(post?.text).toContain(`*${NAME[k]}*`);
  }
  expect(post?.text).toMatch(/👟 \*On the board\*: welcome .*, first games for the club! 🎉/);
  // The ledger is server-side: the Pi never sees it.
  expect(post?.badgeLedger).toBeUndefined();

  // Claimed AND recorded in the same transaction.
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [BADGES_KEY])).toBe(1);
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "BadgeAnnouncement" WHERE "orgId" = $1 AND "badgeKey" = 'first-game' AND "matchId" = $2`,
      [ORG_ID, MATCH.rate],
    ),
  ).toBe(5);

  // The next poll, and the next evening: nothing more.
  expect(badgesPost(await poll(request, londonAt(1, 18, 31)))).toBeUndefined();
  expect(badgesPost(await poll(request, londonAt(2, 18, 30)))).toBeUndefined();
});

test("a Pi outage at 18:00 does not lose it: retried the next evening, but never after 21:00", async ({ request }) => {
  expect(badgesPost(await poll(request, londonAt(1, 21, 15), true))).toBeUndefined();
  expect(badgesPost(await poll(request, londonAt(2, 19, 0), true))).toBeDefined();
});

test("preview mode writes no ledger rows", async ({ request, db }) => {
  expect(badgesPost(await poll(request, londonAt(1, 18, 30), true))).toBeDefined();
  expect(await db.count(`SELECT COUNT(*) FROM "BadgeAnnouncement"`)).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [BADGES_KEY])).toBe(0);
});

test("a provisional MoM leader is not announced; once the MoM result is posted, it is", async ({ request, db }) => {
  // Pat leads the vote, but the MoM result has not been posted yet.
  await db.run(
    `INSERT INTO "MoMVote" (id, "matchId", "voterId", "playerId") VALUES
       ('e2e-bdg-v1', $1, $2, $3), ('e2e-bdg-v2', $1, $4, $3)`,
    [MATCH.rate, U.third, U.player, U.rater],
  );
  const before = badgesPost(await poll(request, londonAt(1, 18, 30), true));
  expect(before?.text).not.toContain("Man of the Match");

  // The vote is over: the MoM result went out.
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId") VALUES ('e2e-bdg-mom', $1, 'group-message', $2)`,
    [`${MATCH.rate}:mom-announcement`, MATCH.rate],
  );
  const after = badgesPost(await poll(request, londonAt(1, 18, 30), true));
  expect(after?.text).toContain(`🏆 *Man of the Match*: *${NAME.player}* won it for the first time ⭐`);
});

test("first run for a club: badges players already held are recorded silently, never announced", async ({ request, db }) => {
  // An older completed match (8 days ago) where Pat and Tom played: their
  // first games pre-date the club's first badges post.
  const older = londonAt(-8, 20, 0);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "updatedAt")
     VALUES ('e2e-bdg-older', $1, $2, 10, 'COMPLETED', $2, false, now())`,
    [ACTIVITY_ID, older],
  );
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES
       ('e2e-bdg-a1', 'e2e-bdg-older', $1, 'CONFIRMED', 1, now()), ('e2e-bdg-a2', 'e2e-bdg-older', $2, 'CONFIRMED', 2, now())`,
    [U.player, U.third],
  );

  const post = badgesPost(await poll(request, londonAt(1, 18, 30)));
  expect(post?.text).toContain(`*${NAME.rater}*`);
  expect(post?.text).not.toContain(NAME.player);
  expect(post?.text).not.toContain(NAME.third);

  // Their first games are in the ledger all the same, so no later post repeats them.
  for (const uid of [U.player, U.third]) {
    expect(
      await db.count(
        `SELECT COUNT(*) FROM "BadgeAnnouncement" WHERE "orgId" = $1 AND "userId" = $2 AND "badgeKey" = 'first-game'`,
        [ORG_ID, uid],
      ),
    ).toBe(1);
  }
});

test("a club with badge announcements switched off gets none", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "featureBadgeAnnouncements" = false WHERE id = $1`, [ORG_ID]);
  expect(badgesPost(await poll(request, londonAt(1, 18, 30)))).toBeUndefined();
  expect(await db.count(`SELECT COUNT(*) FROM "BadgeAnnouncement"`)).toBe(0);
});

test("a dormant club gets none", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "dormantAt" = now() WHERE id = $1`, [ORG_ID]);
  expect(badgesPost(await poll(request, londonAt(1, 18, 30), true))).toBeUndefined();
});
