/**
 * A SWAP WITH THE BENCH TYPED IN HQ, ON A FULL SQUAD (FNF HQ, 2026-11-10),
 * against a real Postgres and the real route. The router and the HQ squad
 * reader are STUBBED (no model is called): the readings are the ones the
 * live check got from the real reader. Everything after the reading is the
 * shipped code: the attendance engine, the writers, the reply.
 *
 * The fixture club's upcoming match is made full here: 5 of 5 (Alex, Colin,
 * Pat, Tom and Ian) with Ben Bench on the bench. "Swap Tom for Ben" means
 * Ben plays and Tom goes to the bench, the squad still 5.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, changeReading, clearHqSquadReaderStub } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000092@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

let seq = 0;
async function say(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-swap-bench-${++seq}`, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const statusOf = async (db: TestDb, userId: string) =>
  (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))?.status ?? null;
const confirmed = async (db: TestDb) =>
  Number((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [MATCH.upcoming]))?.n);
const groupJobs = (db: TestDb) => db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG_ID]);

test.beforeEach(async ({ db, request }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // Fill the squad: Ian in, 5 of 5, Ben on the bench.
  engineOn({ "put Ian in": { route: "other_att", reading: changeReading([["Ian Innes", "in"]]) } });
  await say(request, "put Ian in");
  expect(await confirmed(db)).toBe(5);
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1`, [ORG_ID]);
});

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

const SWAP = changeReading([["Ben Bench", "in"], ["Tom Third", "bench"]], { replaces: { "Ben Bench": "Tom Third" } });

test("'swap Tom for Ben' (the IN read first): Ben plays, Tom on the bench, still 5 of 5", async ({ request, db }) => {
  engineOn({ "@Match Time swap Tom for Ben": { route: "other_att", reading: SWAP } });
  const out = await say(request, "@Match Time swap Tom for Ben");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Tom Third on the bench, Ben Bench in. 5 of 5, 1 on the bench (Tom Third)." });
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  expect(await statusOf(db, U.third)).toBe("BENCH");
  expect(await confirmed(db)).toBe(5);
});

test("'Ben in, Tom to the bench' with no replacement stated: the same", async ({ request, db }) => {
  engineOn({ "@Match Time Ben in, Tom to the bench": { route: "other_att", reading: changeReading([["Ben Bench", "in"], ["Tom Third", "bench"]]) } });
  const out = await say(request, "@Match Time Ben in, Tom to the bench");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed" });
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  expect(await statusOf(db, U.third)).toBe("BENCH");
  expect(await confirmed(db)).toBe(5);
});

test("'swap Tom and Ben' routed to the TEAMS: the HQ squad reader reads a change, and it is done", async ({ request, db }) => {
  engineOn({ "@Match Time swap Tom and Ben": { route: "balancer", reading: SWAP } });
  const out = await say(request, "@Match Time swap Tom and Ben");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed" });
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  expect(await statusOf(db, U.third)).toBe("BENCH");
  expect(await confirmed(db)).toBe(5);
  // Nothing for the players' group: the squad was full before and is full
  // after, and its "Squad complete" list already went out when Ian filled it.
  expect(await groupJobs(db)).toEqual([]);
});

test("CONTROL: 'Ben for Tom, Tom can't make it' still takes Tom out", async ({ request, db }) => {
  const reading = changeReading([["Ben Bench", "in"], ["Tom Third", "out"]], { replaces: { "Ben Bench": "Tom Third" } });
  engineOn({ "@Match Time Ben for Tom, Tom can't make it": { route: "other_att", reading } });
  const out = await say(request, "@Match Time Ben for Tom, Tom can't make it");
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed" });
  expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  expect(await statusOf(db, U.third)).toBe("DROPPED");
  expect(await confirmed(db)).toBe(5);
});
