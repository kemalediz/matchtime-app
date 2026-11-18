/**
 * A WhatsApp Man of the Match poll vote obeys the same window as the web
 * vote (review of #608, round 3, `mom-vote-window.ts`): kickoff plus the
 * activity's `ratingWindowHours`. After it, a vote is neither added nor
 * cleared, so a result is final once the window is over on every path.
 *
 * The fixture's MATCH.rate was played yesterday at 20:00 London; its
 * activity's window is 120h, so it is open until the window is narrowed.
 */
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, MATCH, NAME, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const POLL_MSG = "e2e-window-poll-msg";

async function pollVote(request: APIRequestContext, optionName: string | null) {
  const res = await request.post("/api/whatsapp/poll-vote", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { waMessageId: POLL_MSG, voterPhone: PHONE.rater.replace("+", ""), optionName },
  });
  expect(res.status()).toBe(200);
  return res.json();
}
const votes = (db: { all: (sql: string, a: unknown[]) => Promise<unknown[]> }) =>
  db.all(`SELECT "voterId", "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [MATCH.rate]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId") VALUES ('e2e-window-poll', $1, 'mom-poll', $2, $3)`, [
    `${MATCH.rate}:mom-poll`,
    MATCH.rate,
    POLL_MSG,
  ]);
});

test.afterAll(async () => {
  resetDb();
});

test("inside the window a poll vote is recorded", async ({ request, db }) => {
  expect(await pollVote(request, NAME.third)).toMatchObject({ action: "recorded" });
  expect(await votes(db)).toEqual([{ voterId: U.rater, playerId: U.third }]);
});

test("after the window a poll vote is neither added, changed nor cleared", async ({ request, db }) => {
  // The window becomes one hour: yesterday's 20:00 kickoff is long past it.
  await db.run(`UPDATE "Activity" SET "ratingWindowHours" = 1 WHERE id = $1`, [ACTIVITY_ID]);
  expect(await pollVote(request, NAME.player)).toMatchObject({ ignored: "vote-window-closed" });
  expect(await pollVote(request, null)).toMatchObject({ ignored: "vote-window-closed" });
  expect(await votes(db)).toEqual([{ voterId: U.rater, playerId: U.third }]);
});
