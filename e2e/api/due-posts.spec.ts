/**
 * /api/whatsapp/due-posts — scheduler recipient selection.
 *
 * Uses the test-only x-test-now header (MT_TEST_MODE=1) to pin the clock
 * inside the deterministic windows:
 *   rate-dm        08:00–10:00 London the morning after the match
 *   rate-reminder  18:00–19:00 London, only after the initial DM landed
 *
 * Asserts that members with Membership.ratingDmOptOut=true are skipped
 * in BOTH personal-DM loops while everyone else still gets theirs.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, ORG_ID, MATCH, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  targetUser?: string;
  text?: string;
}

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  // Olivia opted out (set directly — the dm-reply path itself is covered
  // in dm-reply.spec.ts; this spec tests the scheduler respecting it).
  await db.run(
    `UPDATE "Membership" SET "ratingDmOptOut" = true, "ratingDmOptOutAt" = now()
     WHERE "userId" = $1 AND "orgId" = $2`,
    [U.opt, ORG_ID],
  );
});

async function duePostsAt(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    { headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString() } },
  );
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  return (json.instructions ?? []) as Instruction[];
}

const rateDmKey = (userId: string) => `${MATCH.rate}:rate-dm:${userId}`;

test("morning-after rate DMs go to every confirmed player EXCEPT the opted-out one", async ({ request }) => {
  // The match was seeded at 20:00 London yesterday; 08:30 London today is
  // squarely inside the 08-10 morning-after window (12.5h since kickoff).
  // (Computed via londonAt, NOT from the pg-returned timestamp — naive
  // timestamps come back parsed in machine-local time.)
  const fakeNow = londonAt(0, 8, 30);

  const instructions = await duePostsAt(request, fakeNow);
  const keys = instructions.map((i) => i.key);

  for (const uid of [U.rater, U.player, U.third, U.stale]) {
    expect(keys).toContain(rateDmKey(uid));
  }
  expect(keys).not.toContain(rateDmKey(U.opt));

  // The rate DM carries the rating magic link — sanity-check shape.
  const dm = instructions.find((i) => i.key === rateDmKey(U.rater));
  expect(dm?.kind).toBe("dm");
  expect(dm?.text).toMatch(/rate your teammates/i);
});

test("evening rate REMINDERS skip the opted-out player too", async ({ request, db }) => {
  // The reminder loop requires the initial rate-dm breadcrumb — simulate
  // the bot having ACK'd everyone's morning DM (including Olivia's, so
  // the only thing excluding her tonight is the opt-out flag).
  for (const uid of [U.rater, U.player, U.third, U.stale, U.opt]) {
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser")
       VALUES ($1, $2, 'rate-dm', $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [`e2e-sn-rate-dm-${uid}`, rateDmKey(uid), MATCH.rate, uid],
    );
  }
  // Riley has already rated — reminders must skip raters as well. (Pat
  // and Tom also count as "already rated": the seed has them rating
  // Riley, which is exactly the signal the reminder loop keys on.)
  await db.run(
    `INSERT INTO "Rating" (id, "matchId", "raterId", "playerId", score)
     VALUES ($1, $2, $3, $4, 7)
     ON CONFLICT ("matchId", "raterId", "playerId") DO UPDATE SET score = 7`,
    ["e2e-rating-riley-pat", MATCH.rate, U.rater, U.player],
  );

  // 18:30 London today = 22.5h after yesterday's 20:00 kickoff — inside
  // the 18-19 reminder window and the 5-day rating window.
  const fakeNow = londonAt(0, 18, 30);

  const instructions = await duePostsAt(request, fakeNow);
  const reminderTargets = instructions
    .filter((i) => i.key?.includes(":rate-reminder:"))
    .map((i) => i.targetUser);

  expect(reminderTargets).toContain(U.stale); // hasn't rated → reminded
  expect(reminderTargets).not.toContain(U.opt); // opted out
  expect(reminderTargets).not.toContain(U.rater); // already rated (above)
  expect(reminderTargets).not.toContain(U.player); // already rated (seed)
  expect(reminderTargets).not.toContain(U.third); // already rated (seed)
});
