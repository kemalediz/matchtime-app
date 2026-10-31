/**
 * "Man of the Match chosen by: organisers pick" (2026-10-18): no vote is
 * offered or taken anywhere, and the organisers' pick is announced in the
 * players' group without a vote count. Against a real Postgres and the
 * real routes, through the scheduler's due-posts with a pinned clock.
 *
 * The fixture's MATCH.rate was played yesterday at 20:00 London. Pat and
 * Tom rated in the seed; Riley and Sam did not.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, NAME, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  text?: string;
}

async function due(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString(), "x-no-claim": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions ?? []) as Instruction[];
}

const MOM_KEY = `${MATCH.rate}:mom-announcement`;
const pick = (db: { run: (sql: string, args: unknown[]) => Promise<unknown> }, playerId: string) =>
  db.run(`INSERT INTO "MoMVote" (id, "matchId", "voterId", "playerId") VALUES ('e2e-pick-1', $1, $2, $3)`, [MATCH.rate, U.admin, playerId]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'organisers' WHERE id = $1`, [ORG_ID]);
});

test.afterAll(async () => {
  resetDb();
});

test("the rating DM asks for ratings only: no Man of the Match vote", async ({ request }) => {
  const dms = (await due(request, londonAt(0, 8, 30))).filter((i) => i.key?.includes(":rate-dm:"));
  expect(dms.length).toBeGreaterThan(0);
  for (const dm of dms) {
    expect(dm.text).toContain("Rate your teammates. Takes ~1 minute.");
    expect(dm.text).not.toMatch(/pick Man of the Match/);
  }
});

test("with no pick yet, nothing is announced: there is no vote to count", async ({ request }) => {
  expect((await due(request, londonAt(0, 10, 0))).find((i) => i.key === MOM_KEY)).toBeUndefined();
});

test("the organisers' pick is announced in the players' group, in civil hours, without a vote count", async ({ request, db }) => {
  await pick(db, U.player);
  const post = (await due(request, londonAt(0, 10, 0))).find((i) => i.key === MOM_KEY);
  expect(post).toMatchObject({ kind: "group-message" });
  expect(post?.text).toBe(`🏆 *Man of the Match: E2E 5-a-side*\n\nCongrats *${NAME.player}* 🎉`);
  // Not overnight.
  expect((await due(request, londonAt(0, 22, 30))).find((i) => i.key === MOM_KEY)).toBeUndefined();
});

test("an old MoM poll vote neither adds to nor clears the organisers' pick", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId") VALUES ('e2e-pick-poll', $1, 'mom-poll', $2, 'e2e-pick-poll-msg')`,
    [`${MATCH.rate}:mom-poll`, MATCH.rate],
  );
  const res = await request.post("/api/whatsapp/poll-vote", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { waMessageId: "e2e-pick-poll-msg", voterPhone: PHONE.rater.replace("+", ""), optionName: NAME.third },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).ignored).toBe("organisers-pick-mom");
  expect(await db.all(`SELECT "voterId", "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [MATCH.rate])).toEqual([
    { voterId: U.admin, playerId: U.player },
  ]);
});

test("the organiser who picked is still asked to rate: the pick is not their rating", async ({ request, db }) => {
  // Alex Admin plays this match too; the pick is his MoMVote row.
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ('e2e-pick-att', $1, $2, 'CONFIRMED', 9, now())
     ON CONFLICT DO NOTHING`,
    [MATCH.rate, U.admin],
  );
  const keys = (await due(request, londonAt(0, 8, 30))).map((i) => i.key);
  expect(keys).toContain(`${MATCH.rate}:rate-dm:${U.admin}`);
});

test("a club whose players vote: the rating DM still asks for the vote", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'players' WHERE id = $1`, [ORG_ID]);
  const dm = (await due(request, londonAt(0, 8, 30))).find((i) => i.key === `${MATCH.rate}:rate-dm:${U.rater}`);
  expect(dm?.text).toContain("Rate your teammates and pick Man of the Match.");
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'organisers' WHERE id = $1`, [ORG_ID]);
});
