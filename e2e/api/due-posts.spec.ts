/**
 * /api/whatsapp/due-posts — scheduler recipient selection.
 *
 * Uses the test-only x-test-now header (MT_TEST_MODE=1) to pin the clock
 * inside the deterministic windows:
 *   rate-dm        from 08:00 London onward the morning/day after the match
 *   rate-reminder  18:00 to 19:00 London, from the day after the initial
 *                  DM, at most two (rating-reminder-schedule.ts)
 *
 * Asserts that members with Membership.subRatingDm=false are skipped
 * in BOTH personal-DM loops while everyone else still gets theirs.
 *
 * Since #124 (2026-09-23) the morning DM also skips a player who has
 * already ENGAGED with the match: GIVEN at least one Rating (`raterId`)
 * or cast a MoMVote (`voterId`). The seed has Pat and Tom as RATERS of
 * MATCH.rate, so they are engaged. Riley has only RECEIVED ratings, and
 * Sam has neither, so both of them are still owed the DM. Riley is the
 * case that matters: keying on the wrong column (`playerId`) would skip
 * everyone who was rated, which is most of a real squad.
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
  // Olivia opted out of rating DMs (set directly — the dm-reply path itself
  // is covered in dm-reply.spec.ts; this spec tests the scheduler
  // respecting subRatingDm).
  await db.run(
    `UPDATE "Membership" SET "subRatingDm" = false, "subPrefsUpdatedAt" = now()
     WHERE "userId" = $1 AND "orgId" = $2`,
    [U.opt, ORG_ID],
  );
});

async function duePostsAt(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    // x-no-claim: preview mode. Since claim-on-dispatch (2026-07-19) the
    // endpoint writes each instruction's SentNotification row as it hands
    // it out, so a second poll for the same window returns nothing. These
    // tests assert scheduler SELECTION, so they poll in preview mode.
    // Claim behaviour has its own spec: e2e/api/due-posts-claim.spec.ts.
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

const rateDmKey = (userId: string) => `${MATCH.rate}:rate-dm:${userId}`;

// Who the seed makes owed a morning DM, and who not. See the header.
const NOT_YET_ENGAGED = [U.rater, U.stale]; // Riley: rated BY others only. Sam: nothing.
const ALREADY_RATED = [U.player, U.third]; // both GAVE ratings in the seed

function expectMorningRateDmRecipients(keys: (string | undefined)[]) {
  for (const uid of NOT_YET_ENGAGED) expect(keys).toContain(rateDmKey(uid));
  for (const uid of ALREADY_RATED) expect(keys).not.toContain(rateDmKey(uid));
  expect(keys).not.toContain(rateDmKey(U.opt)); // opted out, never
}

test("morning-after rate DMs go to every confirmed player who has not rated yet, EXCEPT the opted-out one", async ({ request, db }) => {
  // The match was seeded at 20:00 London yesterday; 08:30 London today is
  // the morning after, hour >= 8 → inside the window (12.5h since kickoff).
  // (Computed via londonAt, NOT from the pg-returned timestamp — naive
  // timestamps come back parsed in machine-local time.)
  const fakeNow = londonAt(0, 8, 30);

  // Pin the direction of the engagement check against the fixture, so a
  // seed change cannot quietly turn this into a test of nothing: Riley
  // has RECEIVED ratings and GIVEN none, the two raters have given some.
  const given = await db.count(
    `SELECT COUNT(*) FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`,
    [MATCH.rate, U.rater],
  );
  const received = await db.count(
    `SELECT COUNT(*) FROM "Rating" WHERE "matchId" = $1 AND "playerId" = $2`,
    [MATCH.rate, U.rater],
  );
  expect(given).toBe(0);
  expect(received).toBeGreaterThan(0);
  for (const uid of ALREADY_RATED) {
    expect(
      await db.count(`SELECT COUNT(*) FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`, [
        MATCH.rate,
        uid,
      ]),
    ).toBeGreaterThan(0);
  }

  const instructions = await duePostsAt(request, fakeNow);
  const keys = instructions.map((i) => i.key);

  // Riley only RECEIVED ratings, so he is still asked (inside the helper).
  // He is the one who would go silent in production if the check read
  // `playerId`; Pat and Tom GAVE ratings, so they are not asked again.
  expectMorningRateDmRecipients(keys);

  // The rate DM carries the rating magic link — sanity-check shape.
  const dm = instructions.find((i) => i.key === rateDmKey(U.rater));
  expect(dm?.kind).toBe("dm");
  expect(dm?.text).toMatch(/rate your teammates/i);
});

test("morning-after rate DMs STILL fire at 11:00 — no 10:00 upper bound", async ({ request }) => {
  // 11:00 London the day after = 15h since the 20:00 kickoff. Under the
  // old 08:00–10:00 cap this fell outside the window and NO DM went out;
  // after dropping the cap the DM must fire any time from 08:00 onward.
  const fakeNow = londonAt(0, 11, 0);

  const instructions = await duePostsAt(request, fakeNow);
  const keys = instructions.map((i) => i.key);

  expectMorningRateDmRecipients(keys);
});

test("rate DMs do NOT fire before 08:00 (07:00 the day after)", async ({ request }) => {
  // 07:00 London the day after = 11h since kickoff, the morning after, but
  // hour < 8 → still too early. No rate-dm should be emitted.
  const fakeNow = londonAt(0, 7, 0);

  const instructions = await duePostsAt(request, fakeNow);
  const rateDms = instructions.filter((i) => i.key?.includes(":rate-dm:"));
  expect(rateDms).toHaveLength(0);
});

test("rate DMs do NOT fire on the match day itself (22:00 same evening)", async ({ request }) => {
  // 22:00 London on the kickoff day = 2h after the 20:00 match — hour >= 8
  // but todayKey === matchDayKey, so the morning-after gate must keep it
  // silent (this is what stopped the old midnight DMs).
  const fakeNow = londonAt(-1, 22, 0);

  const instructions = await duePostsAt(request, fakeNow);
  const rateDms = instructions.filter((i) => i.key?.includes(":rate-dm:"));
  expect(rateDms).toHaveLength(0);
});

test("evening rate REMINDERS skip the opted-out player too", async ({ request, db }) => {
  // The reminder loop requires the initial rate-dm breadcrumb — simulate
  // the bot having ACK'd everyone's morning DM (including Olivia's, so
  // the only thing excluding her tonight is the opt-out flag).
  // The morning DM went at 08:30 London today (the morning after the
  // match); since 2026-10-18 the first reminder is never on that same day.
  for (const uid of [U.rater, U.player, U.third, U.stale, U.opt]) {
    await db.run(
      `INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser", "createdAt")
       VALUES ($1, $2, 'rate-dm', $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET "createdAt" = EXCLUDED."createdAt"`,
      [`e2e-sn-rate-dm-${uid}`, rateDmKey(uid), MATCH.rate, uid, londonAt(0, 8, 30)],
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

  // 18:30 London today, the same day as the first DM: no reminder yet
  // (Kemal, 2026-10-18).
  const sameDay = await duePostsAt(request, londonAt(0, 18, 30));
  expect(sameDay.filter((i) => i.key?.includes(":rate-reminder:"))).toHaveLength(0);

  // 18:30 London tomorrow = 46.5h after yesterday's 20:00 kickoff: the
  // day after the first DM (reminder 1), inside the 18-19 reminder hour
  // and the 5-day rating window.
  const fakeNow = londonAt(1, 18, 30);

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

/* ── THE MAN OF THE MATCH RESULT IS STORED WHEN THE POST IS CLAIMED ─────
 *
 * Kemal, 2026-11-16: "who was the last Man of the Match?" is told exactly
 * as announced. So the claim stores what the post said ("MoMAnnouncement"),
 * from the same tally its words were built from; later votes and changed
 * votes never touch it. The scheduler's decision (here the EARLY trigger:
 * every confirmed player has voted) is unchanged.
 */
test("the MoM announcement's result is stored at claim time, not before, and a later vote change never alters it", async ({ request, db }) => {
  resetDb();
  const MOM_KEY = `${MATCH.rate}:mom-announcement`;
  // Every confirmed player votes (the early trigger): Pat 3, Tom 2.
  const votes: Array<[string, string]> = [
    [U.rater, U.player],
    [U.third, U.player],
    [U.stale, U.player],
    [U.player, U.third],
    [U.opt, U.third],
  ];
  for (const [voter, player] of votes) {
    await db.run(`INSERT INTO "MoMVote" (id, "matchId", "voterId", "playerId") VALUES ($1, $2, $3, $4)`, [`e2e-mom-${voter}`, MATCH.rate, voter, player]);
  }
  const at = londonAt(0, 10, 0);
  // The time as stored (UTC, naive column), so the machine's zone cannot move it.
  const stored = () =>
    db.all<{ result: unknown; at: string }>(
      `SELECT result, to_char("announcedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM "MoMAnnouncement" WHERE "matchId" = $1`,
      [MATCH.rate],
    );

  // A preview poll (no claim) writes nothing.
  expect((await duePostsAt(request, at)).map((i) => i.key)).toContain(MOM_KEY);
  expect(await stored()).toEqual([]);

  // The real poll claims the post and stores what it says.
  const claimed = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": at.toISOString() },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  const post = ((await claimed.json()).instructions as Array<Record<string, unknown>>).find((i) => i.key === MOM_KEY);
  expect(post?.text).toContain("Pat Player");
  // The record is server-side: the Pi never sees it.
  expect(post && "momResult" in post).toBe(false);
  const RESULT = {
    v: 1,
    kind: "vote",
    tally: [
      { userId: U.player, name: "Pat Player", votes: 3 },
      { userId: U.third, name: "Tom Third", votes: 2 },
    ],
    // The winners the post announced, stored (never re-derived later).
    winners: [U.player],
  };
  const rows = await stored();
  expect(rows.map((r) => r.result)).toEqual([RESULT]);
  expect(rows[0].at).toBe(at.toISOString());

  // Votes change after the post (an upsert keeps the row's createdAt).
  await db.run(`UPDATE "MoMVote" SET "playerId" = $2 WHERE "matchId" = $1 AND "voterId" IN ($3, $4)`, [MATCH.rate, U.third, U.rater, U.stale]);
  const again = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": new Date(at.getTime() + 60 * 60 * 1000).toISOString() },
  });
  expect(again.status()).toBe(200);
  // Never announced twice, and the record still says what the group saw.
  expect(((await again.json()).instructions as Array<{ key?: string }>).map((i) => i.key)).not.toContain(MOM_KEY);
  expect((await stored()).map((r) => r.result)).toEqual([RESULT]);
});
